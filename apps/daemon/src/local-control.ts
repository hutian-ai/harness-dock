import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { id } from '@harness-dock/protocol';
import type { DeviceConfig } from './config.ts';
import type { SelfTestSnapshot } from './device-self-test.ts';

export interface LocalStatus {
  nodeId: string; daemonId: string; pid: number; connected: boolean; endpoint: string;
  entrypoint?: string; runtime?: string; activeRunIds?: string[]; unresolvedRunIds?: string[];
  connectionError?: string;
  selfTest?: SelfTestSnapshot;
  selfTestReceipt?: { id: string; found: boolean };
}
function socketPath(config: DeviceConfig, daemonId: string): string {
  const key = createHash('sha256').update(`${resolve(config.stateDir)}:${daemonId}`).digest('hex').slice(0, 32);
  return join(tmpdir(), `hd-${process.getuid?.() ?? 'user'}`, `${key}.sock`);
}
const descriptor = (config: DeviceConfig) => join(config.stateDir, 'control.json');
const selfTestId = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'id'
    || !id.safeParse((value as { id?: unknown }).id).success) throw new Error('invalid_self_test_request');
  return (value as { id: string }).id;
};

/** Called only after DeviceHost has acquired the state directory's SQLite lock. */
export async function serveControl(config: DeviceConfig, status: () => LocalStatus, shutdown: () => Promise<void>, shutdownIfIdle?: () => Promise<void>, startSelfTest?: (id: string) => SelfTestSnapshot, lookupSelfTest?: (id: string) => { id: string; found: boolean }) {
  if (process.platform === 'win32') throw new Error('Local daemon management currently requires macOS or Linux');
  const path = socketPath(config, status().daemonId);
  const directory = join(tmpdir(), `hd-${process.getuid!()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await lstat(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid!()) throw new Error('local_control_owner_mismatch');
  await chmod(directory, 0o700);
  try {
    const old = JSON.parse(await readFile(descriptor(config), 'utf8')) as LocalStatus;
    await rm(socketPath(config, old.daemonId), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const server = createServer((req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (req.headers.origin !== undefined || req.headers['x-dock-daemon'] !== status().daemonId ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') res.end(JSON.stringify(status()));
    else if (req.method === 'POST' && (req.url === '/self-test' || req.url === '/self-test-status')) {
      if (req.headers['content-type'] !== 'application/json') {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid_self_test_request' })); return;
      }
      const chunks: Buffer[] = []; let size = 0, rejected = false;
      req.setTimeout(5_000, () => req.destroy());
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > 256) { rejected = true; res.writeHead(413).end(JSON.stringify({ error: 'invalid_self_test_request' })); }
        else chunks.push(Buffer.from(chunk));
      });
      req.on('end', () => {
        if (rejected) return;
        let testId: string;
        try { testId = selfTestId(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { res.writeHead(400).end(JSON.stringify({ error: 'invalid_self_test_request' })); return; }
        const lookup = req.url === '/self-test-status';
        if (lookup ? !lookupSelfTest : !startSelfTest) { res.writeHead(409).end(JSON.stringify({ error: 'self_test_unsupported' })); return; }
        try { res.end(JSON.stringify({ ...status(), ...(lookup ? { selfTestReceipt: lookupSelfTest!(testId) } : { selfTest: startSelfTest!(testId) }) })); }
        catch (error) {
          const reason = error instanceof Error ? error.message : '';
          const conflict = ['device_busy', 'unresolved_execution', 'device_stopping', 'self_test_id_conflict'].includes(reason);
          res.writeHead(conflict ? 409 : 500).end(JSON.stringify({ error: conflict || reason === 'self_test_storage_unavailable' ? reason : 'self_test_failed' }));
        }
      });
      req.on('error', () => { if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error: 'invalid_self_test_request' })); });
    }
    else if (req.method === 'POST' && (req.url === '/stop' || req.url === '/stop-idle')) {
      const snapshot = status();
      // Evaluate inside a promise: an idle check can reject synchronously before shutdown begins.
      void Promise.resolve().then(() => {
        if (req.url === '/stop-idle') {
          if (!shutdownIfIdle) throw new Error('maintenance_stop_unsupported');
          return shutdownIfIdle();
        }
        return shutdown();
      }).then(() => {
        res.end(JSON.stringify({ ...snapshot, stopped: true }));
        server.close();
      }, error => {
        const reason = error instanceof Error ? error.message : 'shutdown_failed';
        const refused = ['device_busy', 'unresolved_execution', 'maintenance_stop_unsupported'].includes(reason);
        res.writeHead(refused ? 409 : 500).end(JSON.stringify({ error: refused ? reason : 'shutdown_failed' }));
        if (!refused) { server.close(); process.exitCode = 1; }
      });
    } else res.writeHead(404).end();
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(path, done);
  });
  const pending = `${descriptor(config)}.${status().daemonId}.tmp`;
  try {
    await chmod(path, 0o600);
    await writeFile(pending, JSON.stringify(status()), { mode: 0o600 });
    await rename(pending, descriptor(config));
  } catch (error) { server.close(); await rm(pending, { force: true }); throw error; }
  // Every boot has a unique socket; closing an old daemon cannot unlink a replacement's socket.
  return () => new Promise<void>((done) => server.close(() => done()));
}

export async function control(config: DeviceConfig, method: 'status' | 'stop' | 'stop-idle' | 'self-test' | 'self-test-status', params?: { id: string }): Promise<LocalStatus & { stopped?: boolean; } | null> {
  const testRequest = method === 'self-test' || method === 'self-test-status';
  const readOnly = method === 'status' || method === 'self-test-status';
  const input = testRequest ? JSON.stringify({ id: selfTestId(params) }) : undefined;
  if (!testRequest && params !== undefined) throw new Error('invalid_local_control_request');
  let info: LocalStatus;
  try { info = JSON.parse(await readFile(descriptor(config), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (info.nodeId !== config.nodeId) throw new Error('local_control_node_mismatch');
  return new Promise((done, reject) => {
    const req = request({ socketPath: socketPath(config, info.daemonId), path: `/${method}`,
      method: method === 'status' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'x-dock-daemon': info.daemonId,
        ...(input ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(input) } : {}) },
    }, (res) => {
      let body = '';
      res.on('error', reject);
      res.on('data', chunk => { body += chunk; if (body.length > 16_384) req.destroy(new Error('local_control_response_too_large')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`local_control_rejected:${res.statusCode}:${JSON.parse(body || '{}').error ?? 'unknown'}`);
          const result = JSON.parse(body) as LocalStatus;
          if (result.daemonId !== info.daemonId || result.nodeId !== config.nodeId) throw new Error('local_control_identity_mismatch');
          if (method === 'self-test' && result.selfTest?.id !== params?.id) throw new Error('local_control_self_test_mismatch');
          if (method === 'self-test-status' && (result.selfTestReceipt?.id !== params?.id || typeof result.selfTestReceipt?.found !== 'boolean')) throw new Error('local_control_self_test_receipt_mismatch');
          done(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(readOnly ? 2_000 : 30_000, () => req.destroy(new Error('local_control_timeout')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '') || readOnly && ['EPIPE', 'ECONNRESET'].includes(error.code ?? '')) done(null); else reject(error);
    });
    req.end(input);
  });
}
