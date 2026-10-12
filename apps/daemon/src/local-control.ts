import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { NodeConfig } from './config.ts';

export interface LocalStatus {
  nodeId: string; daemonId: string; pid: number; connected: boolean; endpoint: string;
}
function socketPath(config: NodeConfig, daemonId: string): string {
  const key = createHash('sha256').update(`${resolve(config.stateDir)}:${daemonId}`).digest('hex').slice(0, 32);
  return join(tmpdir(), `hd-${process.getuid?.() ?? 'user'}`, `${key}.sock`);
}
const descriptor = (config: NodeConfig) => join(config.stateDir, 'control.json');

/** Called only after Engine has acquired the state directory's SQLite lock. */
export async function serveControl(config: NodeConfig, status: () => LocalStatus, shutdown: () => Promise<void>) {
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
    if (req.headers.origin || req.headers['x-dock-daemon'] !== status().daemonId ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') res.end(JSON.stringify(status()));
    else if (req.method === 'POST' && req.url === '/stop') {
      void shutdown().then(() => {
        res.end(JSON.stringify({ ...status(), stopped: true }));
        server.close();
      }, () => { res.writeHead(500).end('{"error":"shutdown_failed"}'); server.close(); process.exitCode = 1; });
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

export async function control(config: NodeConfig, method: 'status' | 'stop'): Promise<LocalStatus & { stopped?: boolean; } | null> {
  let info: LocalStatus;
  try { info = JSON.parse(await readFile(descriptor(config), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (info.nodeId !== config.nodeId) throw new Error('local_control_node_mismatch');
  return new Promise((done, reject) => {
    const req = request({ socketPath: socketPath(config, info.daemonId), path: `/${method}`,
      method: method === 'stop' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.token}`, 'x-dock-daemon': info.daemonId },
    }, (res) => {
      let body = '';
      res.on('error', reject);
      res.on('data', chunk => { body += chunk; if (body.length > 16_384) req.destroy(new Error('local_control_response_too_large')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`local_control_rejected:${res.statusCode}`);
          const result = JSON.parse(body) as LocalStatus;
          if (result.daemonId !== info.daemonId || result.nodeId !== config.nodeId) throw new Error('local_control_identity_mismatch');
          done(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(method === 'stop' ? 30_000 : 2_000, () => req.destroy(new Error('local_control_timeout')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) done(null); else reject(error);
    });
    req.end();
  });
}
