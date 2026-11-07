import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { id } from '@harness-dock/protocol';
import type { DeviceConfig } from './config.ts';
import type { SelfTestProvider, SelfTestSnapshot } from './device-self-test.ts';
import type { AdmissionRecoveryStatus } from './device-store.ts';
import type { ProviderProxyStatus } from './provider-proxy.ts';
import type { ProviderDetails } from './provider-details.ts';
import type { DeviceOverview } from './device-overview.ts';

export interface SelfTestRequest { id: string; provider?: SelfTestProvider }
export interface SelfTestReceipt { id: string; found: boolean; provider?: SelfTestProvider }

export interface LocalStatus {
  nodeId: string; daemonId: string; pid: number; connected: boolean; endpoint: string;
  entrypoint?: string; runtime?: string; activeRunIds?: string[]; unresolvedRunIds?: string[];
  connectionError?: string;
  admissionRecovery?: AdmissionRecoveryStatus;
  selfTest?: SelfTestSnapshot;
  selfTests?: SelfTestSnapshot[];
  selfTestProviders?: SelfTestProvider[];
  selfTestReceipt?: SelfTestReceipt;
  providerActivity?: Partial<Record<SelfTestProvider, 'idle' | 'connecting' | 'executing' | 'checking' | 'unknown'>>;
  providerProxies?: Partial<Record<SelfTestProvider, ProviderProxyStatus>>;
  overview?: DeviceOverview;
  providerDetailsSupported?: boolean;
  providerDetails?: Record<string, ProviderDetails>;
}
function socketPath(config: DeviceConfig, daemonId: string): string {
  const key = createHash('sha256').update(`${resolve(config.stateDir)}:${daemonId}`).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return `\\\\.\\pipe\\harness-dock-control-${key}`;
  return join(tmpdir(), `hd-${process.getuid?.() ?? 'user'}`, `${key}.sock`);
}
const descriptor = (config: DeviceConfig) => join(config.stateDir, 'control.json');
const selfTestRequest = (value: unknown): Required<SelfTestRequest> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_self_test_request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'id' && key !== 'provider') || !id.safeParse(input.id).success
    || input.provider !== undefined && input.provider !== 'codex' && input.provider !== 'dsh') throw new Error('invalid_self_test_request');
  return { id: input.id as string, provider: input.provider as SelfTestProvider | undefined ?? 'codex' };
};
const recoveryRequest = (value: unknown): { id: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_local_control_request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !id.safeParse(input.id).success) throw new Error('invalid_local_control_request');
  return { id: input.id as string };
};
const responseProvider = (value: unknown): SelfTestProvider | undefined => value === undefined ? 'codex' : value === 'codex' || value === 'dsh' ? value : undefined;

/** Shared bounded body reader for authenticated local commands. */
function readControlBody(req: IncomingMessage, res: ServerResponse, error: string, accept: (body: Buffer) => void): void {
  const chunks: Buffer[] = []; let size = 0, rejected = false;
  req.setTimeout(5_000, () => req.destroy());
  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > 256) { rejected = true; res.writeHead(413).end(JSON.stringify({ error })); }
    else chunks.push(Buffer.from(chunk));
  });
  req.on('end', () => {
    // The body deadline must not abort a bounded native capability inspection after upload completes.
    req.setTimeout(0);
    if (!rejected) accept(Buffer.concat(chunks));
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error })); });
}

/** Called only after DeviceHost has acquired the state directory's SQLite lock. */
export async function serveControl(config: DeviceConfig, status: () => LocalStatus, shutdown: () => Promise<void>, shutdownIfIdle?: () => Promise<void>, startSelfTest?: (id: string, provider?: SelfTestProvider) => SelfTestSnapshot, lookupSelfTest?: (id: string, provider?: SelfTestProvider) => SelfTestReceipt,
  admissionRecovery?: { prepare(): Promise<unknown>; resume(id: string): Promise<unknown> },
  refreshProviderDetails?: () => Promise<void>) {
  if (process.platform === 'win32') await (await import('@harness-dock/drivers')).assertWindowsPrivatePath(config.stateDir);
  const path = socketPath(config, status().daemonId);
  if (process.platform !== 'win32') {
    const directory = join(tmpdir(), `hd-${process.getuid!()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = await lstat(directory);
    if (!owner.isDirectory() || owner.uid !== process.getuid!()) throw new Error('local_control_owner_mismatch');
    await chmod(directory, 0o700);
    try {
      const old = JSON.parse(await readFile(descriptor(config), 'utf8')) as LocalStatus;
      await rm(socketPath(config, old.daemonId), { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let ready = false;
  const server = createServer((req, res) => {
    if (!ready) { res.writeHead(503).end(); return; }
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
      readControlBody(req, res, 'invalid_self_test_request', body => {
        let test: Required<SelfTestRequest>;
        try { test = selfTestRequest(JSON.parse(body.toString('utf8'))); }
        catch { res.writeHead(400).end(JSON.stringify({ error: 'invalid_self_test_request' })); return; }
        const lookup = req.url === '/self-test-status';
        if (lookup ? !lookupSelfTest : !startSelfTest) { res.writeHead(409).end(JSON.stringify({ error: 'self_test_unsupported' })); return; }
        try { res.end(JSON.stringify({ ...status(), ...(lookup ? { selfTestReceipt: lookupSelfTest!(test.id, test.provider) } : { selfTest: startSelfTest!(test.id, test.provider) }) })); }
        catch (error) {
          const reason = error instanceof Error ? error.message : '';
          const conflict = ['device_busy', 'unresolved_execution', 'device_stopping', 'self_test_id_conflict'].includes(reason);
          res.writeHead(conflict ? 409 : 500).end(JSON.stringify({ error: conflict || reason === 'self_test_storage_unavailable' ? reason : 'self_test_failed' }));
        }
      });
    }
    else if (req.method === 'POST' && req.url === '/provider-details') {
      readControlBody(req, res, 'invalid_local_control_request', body => {
        if (body.length) { res.writeHead(400).end(JSON.stringify({ error: 'invalid_local_control_request' })); return; }
        if (!refreshProviderDetails) { res.writeHead(409).end(JSON.stringify({ error: 'provider_details_unsupported' })); return; }
        void refreshProviderDetails().then(() => res.end(JSON.stringify(status())), error => {
          const reason = error instanceof Error ? error.message : '';
          const code = ['device_busy', 'busy', 'device_stopping'].includes(reason) ? 'device_busy' : 'provider_details_failed';
          res.writeHead(code === 'device_busy' ? 409 : 500).end(JSON.stringify({ error: code }));
        });
      });
    }
    else if (req.method === 'POST' && (req.url === '/prepare-admission-recovery' || req.url === '/resume-admission')) {
      if (!admissionRecovery) { res.writeHead(409).end(JSON.stringify({ error: 'admission_recovery_unsupported' })); return; }
      readControlBody(req, res, 'invalid_local_control_request', body => {
        let checkpointId: string | undefined;
        try {
          if (req.url === '/resume-admission') {
            if (req.headers['content-type'] !== 'application/json') throw new Error('invalid_local_control_request');
            checkpointId = recoveryRequest(JSON.parse(body.toString('utf8'))).id;
          } else if (body.length !== 0) throw new Error('invalid_local_control_request');
        } catch { res.writeHead(400).end(JSON.stringify({ error: 'invalid_local_control_request' })); return; }
        void Promise.resolve().then(() => checkpointId ? admissionRecovery.resume(checkpointId) : admissionRecovery.prepare())
          .then(() => res.end(JSON.stringify(status())), error => {
            const reason = error instanceof Error ? error.message : '';
            const code = ['admission_recovery_unsupported', 'admission_recovery_changed', 'admission_recovery_restart_required', 'device_busy', 'busy', 'device_stopping'].includes(reason) ? reason : 'admission_recovery_failed';
            res.writeHead(code === 'admission_recovery_failed' ? 500 : 409).end(JSON.stringify({ error: code }));
          });
      });
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
    if (process.platform === 'win32') await (await import('@harness-dock/drivers')).protectWindowsPipe(path);
    else await chmod(path, 0o600);
    await writeFile(pending, JSON.stringify(status()), { mode: 0o600 });
    await rename(pending, descriptor(config));
    ready = true;
  } catch (error) { server.close(); await rm(pending, { force: true }); throw error; }
  // Every boot has a unique socket; closing an old daemon cannot unlink a replacement's socket.
  return () => new Promise<void>((done) => server.close(() => done()));
}

export async function control(config: DeviceConfig, method: 'status' | 'provider-details' | 'stop' | 'stop-idle' | 'self-test' | 'self-test-status' | 'prepare-admission-recovery' | 'resume-admission', params?: SelfTestRequest): Promise<LocalStatus & { stopped?: boolean; } | null> {
  const testRequest = method === 'self-test' || method === 'self-test-status';
  const readOnly = method === 'status' || method === 'self-test-status';
  const test = testRequest ? selfTestRequest(params) : undefined;
  // Legacy Codex daemons accept only { id }; only a named non-default request extends the wire body.
  const recovery = method === 'resume-admission' ? recoveryRequest(params) : undefined;
  const input = test ? JSON.stringify({ id: test.id, ...(test.provider === 'dsh' ? { provider: test.provider } : {}) }) : recovery ? JSON.stringify({ id: recovery.id }) : undefined;
  if (!testRequest && !recovery && params !== undefined) throw new Error('invalid_local_control_request');
  if (process.platform === 'win32') await (await import('@harness-dock/drivers')).assertWindowsPrivatePath(config.stateDir);
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
      // Bounded dashboard rows plus the pre-existing active/unresolved identity lists.
      res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 512 * 1024) req.destroy(new Error('local_control_response_too_large')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`local_control_rejected:${res.statusCode}:${JSON.parse(body || '{}').error ?? 'unknown'}`);
          const result = JSON.parse(body) as LocalStatus;
          if (result.daemonId !== info.daemonId || result.nodeId !== config.nodeId) throw new Error('local_control_identity_mismatch');
          if (method === 'self-test' && (result.selfTest?.id !== test?.id || responseProvider(result.selfTest?.provider) !== test?.provider)) throw new Error('local_control_self_test_mismatch');
          if (method === 'self-test-status' && (result.selfTestReceipt?.id !== test?.id || typeof result.selfTestReceipt?.found !== 'boolean'
            || responseProvider(result.selfTestReceipt?.provider) !== test?.provider)) throw new Error('local_control_self_test_receipt_mismatch');
          done(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(method === 'provider-details' ? 100_000 : readOnly ? 2_000 : 30_000, () => req.destroy(new Error('local_control_timeout')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '') || readOnly && ['EPIPE', 'ECONNRESET'].includes(error.code ?? '')) done(null); else reject(error);
    });
    req.end(input);
  });
}
