import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ServerClient, loadClientOptions } from '../packages/client/src/index.ts';

process.umask(0o077);
const exec = promisify(execFile);
const root = process.cwd();
await mkdir('.local', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(resolve('.local/source-smoke-'));
const home = join(directory, 'home'), work = join(directory, 'work');
await mkdir(home); await mkdir(work);
await writeFile(join(work, 'user-owned.txt'), 'synthetic user file');
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'].includes(key))),
  HOME: home,
};
const entries = { server: 'apps/server/src/cli.ts', daemon: 'apps/daemon/src/cli.ts', client: 'packages/client/src/cli.ts' };
const cli = async (name: keyof typeof entries, ...args: string[]) =>
  (await exec(process.execPath, ['--import', 'tsx', resolve(entries[name]), ...args], { cwd: root, env: environment, timeout: 20_000, maxBuffer: 128 * 1024 })).stdout;
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`source_smoke_timeout:${label}`);
    await delay(50);
  }
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('source_smoke_shutdown_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

let server: ReturnType<typeof spawn> | undefined, serverExit: Promise<number | null> | undefined;
let configPath: string | undefined, client: ServerClient | undefined, log = '', passed = false;
try {
  const paths = JSON.parse(await cli('server', 'init', join(directory, 'control'))) as { serverPath: string; clientPath: string; devicePairingPath: string };
  const config = JSON.parse(await readFile(paths.serverPath, 'utf8'));
  // Init writes fixed recipient endpoints. Select collision-free ports for this isolated smoke only.
  config.devicePort = 0; config.clientPort = 0;
  await writeFile(paths.serverPath, JSON.stringify(config));
  server = spawn(process.execPath, ['--import', 'tsx', resolve(entries.server), 'run', paths.serverPath], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream!.on('data', chunk => { log = (log + String(chunk)).slice(-131072); });
  serverExit = new Promise((done, reject) => { server!.once('error', reject); server!.once('exit', done); });
  void serverExit.catch(() => {});
  await until(() => {
    if (server!.exitCode !== null) throw new Error('source_server_exited');
    return /server ready: devices (ws:\/\/127\.0\.0\.1:\d+\/); clients (ws:\/\/127\.0\.0\.1:\d+\/)/u.test(log);
  }, 'server');
  const endpoints = /server ready: devices (ws:\/\/127\.0\.0\.1:\d+\/); clients (ws:\/\/127\.0\.0\.1:\d+\/)/u.exec(log)!;
  for (const [path, endpoint] of [[paths.devicePairingPath, endpoints[1]], [paths.clientPath, endpoints[2]]] as const) {
    const value = JSON.parse(await readFile(path, 'utf8')); value.endpoint = endpoint;
    await writeFile(path, JSON.stringify(value));
  }
  const initialized = JSON.parse(await cli('daemon', 'init', '--home', join(directory, 'device'), '--cwd', work, '--pairing', paths.devicePairingPath));
  configPath = initialized.configPath as string;
  const device = JSON.parse(await readFile(configPath, 'utf8'));
  // No native installation, authentication, inherited account home or model call is used.
  device.providers = { codex: { disabled: true }, dsh: { disabled: true } };
  await writeFile(configPath, JSON.stringify(device));
  const started = JSON.parse(await cli('daemon', 'start', configPath));
  client = new ServerClient(await loadClientOptions(paths.clientPath));
  await client.ready;
  const peer = client.node(device.nodeId)!;
  await until(() => peer.connected, 'device_connection');
  assert.equal(client.listNodes().length, 1);
  const inventory = await peer.request('inventory');
  assert.deepEqual(inventory.providers.map(provider => ({ key: provider.key, status: provider.status })), [{ key: 'codex', status: 'disabled' }, { key: 'dsh', status: 'disabled' }]);
  const runId = randomUUID(), sessionKey = randomUUID();
  await peer.request('prepare', { runId, sessionKey, files: [] });
  assert.deepEqual(await peer.request('collect', { runId }), []);
  await peer.request('release', { runId });
  await peer.request('forgetSession', { sessionKey });
  assert.equal(await peer.request('getExecution', { runId }), null);
  await client.close(); client = undefined;
  const nodes = JSON.parse(await cli('client', 'nodes', paths.clientPath));
  assert.equal(nodes.length, 1); assert.equal(nodes[0].connected, true);
  const diagnosis = JSON.parse(await cli('client', 'doctor', paths.clientPath, '--json'));
  assert.equal(diagnosis.ok, true); assert.equal(diagnosis.modelExecutionVerified, false);
  assert.equal(JSON.parse(await cli('server', 'doctor', paths.serverPath, '--endpoint', endpoints[2]!, '--json')).ok, true);
  assert.equal(JSON.parse(await cli('daemon', 'stop', configPath)).stopped, true);
  const restarted = JSON.parse(await cli('daemon', 'start', configPath));
  assert.equal(restarted.nodeId, started.nodeId); assert.notEqual(restarted.daemonId, started.daemonId);
  assert.equal(await readFile(join(work, 'user-owned.txt'), 'utf8'), 'synthetic user file');
  passed = true;
} finally {
  await client?.close();
  // Management always addresses this isolated owner through its protected local socket.
  try { if (configPath) await cli('daemon', 'stop', configPath); }
  finally {
    if (server && serverExit) {
      server.kill('SIGTERM');
      const code = await bounded(serverExit, 10_000).catch(async error => { server!.kill('SIGKILL'); await serverExit; throw error; });
      assert.equal(code, 0, 'source server must confirm graceful shutdown');
    }
    await writeFile(join(directory, 'server.log'), log);
    await writeFile(join(directory, 'result.json'), JSON.stringify({ passed, nativeProviderExecuted: false, modelExecutionVerified: false }, null, 2));
  }
}
console.log(`PASS source smoke: source CLIs, pairing, background start/stop/restart, SDK connection, managed files and diagnostics. Codex and dsh disabled; no model execution. Evidence: ${relative(root, directory)}`);
