import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const source = resolve(process.argv[2] ?? '.local/bundle');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-dock-delivery-')));
await cp(source, directory, { recursive: true, verbatimSymlinks: true });
const consumer = join(directory, 'consumer');
await mkdir(consumer);
await writeFile(join(consumer, 'package.json'), JSON.stringify({
  private: true, type: 'module', dependencies: { '@harness-dock/client': 'file:../controller' },
}));
execFileSync('npm', ['install', '--offline', '--install-links=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: consumer, stdio: 'inherit', timeout: 60_000 });
await writeFile(join(consumer, 'index.ts'), [
  "export { DockClient, DockError } from '@harness-dock/client';",
  "export type { Observation, PermissionInput, Probe, RunSnapshot, StartInput } from '@harness-dock/client';",
].join('\n'));
await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [], outDir: 'dist' },
  include: ['index.ts'],
}));
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'inherit' });
const clientEntry = await realpath(join(consumer, 'node_modules/@harness-dock/client/dist/index.js'));
assert.ok(clientEntry.startsWith(join(directory, 'controller') + '/'));
const require = createRequire(clientEntry);
for (const dependency of ['@harness-dock/protocol', 'ws', 'json-rpc-2.0'])
  assert.ok((await realpath(join(directory, 'controller/node_modules', dependency))).startsWith(join(directory, 'controller') + '/'));
for (const dependency of ['acpx', '@agentclientprotocol/codex-acp', '@harness-dock/drivers'])
  assert.throws(() => require.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
const { DockClient } = await import(pathToFileURL(join(consumer, 'dist/index.js')).href);
const agentConsumer = join(directory, 'agent-consumer');
await mkdir(agentConsumer);
await writeFile(join(agentConsumer, 'package.json'), JSON.stringify({
  private: true, dependencies: { '@harness-dock/daemon': 'file:../daemon' },
}));
execFileSync('npm', ['install', '--offline', '--install-links=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: agentConsumer, stdio: 'inherit', timeout: 60_000 });
const cliPath = join(agentConsumer, 'node_modules/.bin/harness-dock-daemon');
const exec = promisify(execFile);
const cli = async (...args: string[]) => (await exec(cliPath, args, { cwd: directory, timeout: 45_000 })).stdout;
const evidenceDir = resolve('.local/delivery', new Date().toISOString().replaceAll(':', '-'));
await mkdir(join(evidenceDir, 'work'), { recursive: true, mode: 0o700 });
const { configPath, controllerPath } = JSON.parse(await cli('init', '--home', join(evidenceDir, 'node'),
  '--cwd', join(evidenceDir, 'work'), '--auth-from', resolve('.local/codex-home/auth.json')));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const { nodeId, token } = config;
const client = new DockClient({ nodeId, token, port: 0 });
await client.ready;
const controllerConfig = { nodeId, token, endpoint: client.endpoint };
await writeFile(configPath, JSON.stringify({ ...config, endpoint: client.endpoint }), { mode: 0o600 });
await writeFile(controllerPath, JSON.stringify(controllerConfig), { mode: 0o600 });
try {
  const started = JSON.parse(await cli('start', configPath));
  await client.waitForConnection();
  assert.equal(JSON.parse(await cli('status', configPath)).connected, true);
  const duplicate = JSON.parse(await cli('start', configPath));
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.daemonId, started.daemonId);
  const input = { runId: randomUUID(), prompt: 'Reply exactly BUNDLE_OK without tools.' };
  await client.start(input);
  const deadline = Date.now() + 150_000;
  let snapshot;
  do {
    snapshot = await client.getRun(input.runId);
    if (!['running', 'cancel_requested'].includes(snapshot.state)) break;
    await delay(200);
  } while (Date.now() < deadline);
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.finalAnswer?.[0]?.text, 'BUNDLE_OK');
  assert.match(await cli('logs', configPath), /Daemon .* connecting/);
  assert.equal(JSON.parse(await cli('stop', configPath)).stopped, true);
  const restarted = JSON.parse(await cli('start', configPath));
  assert.notEqual(restarted.daemonId, started.daemonId);
  await client.waitForConnection();
  assert.equal((await client.getRun(input.runId)).finalAnswer?.[0]?.text, 'BUNDLE_OK');
  await assert.rejects(client.start(input), /original daemon is unavailable/);
  await client.close();
  const consoleProcess = spawn(process.execPath, [join(directory, 'controller/dist/console.js'), controllerPath], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  consoleProcess.stdout.on('data', c => { output += c; });
  consoleProcess.stderr.on('data', c => { output += c; });
  await delay(1500);
  consoleProcess.stdin.write(`probe\nhistory\nstatus ${input.runId}\nquit\n`);
  const code = await Promise.race([once(consoleProcess, 'exit').then(([code]) => code), delay(15_000).then(() => { consoleProcess.kill('SIGKILL'); throw new Error('Console timeout'); })]);
  assert.equal(code, 0);
  assert.match(output, /BUNDLE_OK/);
  assert.match(output, /protocolVersion: 3/);
  assert.equal(JSON.parse(await cli('stop', configPath)).stopped, true);
  const finalStatus = JSON.parse(await cli('status', configPath));
  assert.equal(finalStatus.available, false);
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify({ directory, npmLocalDependency: true,
    npmDaemonBin: cliPath, publicTypesChecked: true, clientEntry, cli: { started, duplicate, restarted, finalStatus },
    sdkDependencies: await readdir(join(directory, 'controller/node_modules/.pnpm')), snapshot, consoleOutput: output,
  }, null, 2), { mode: 0o600 });
  console.log(`PASS npm SDK/types, installed Daemon init/start/status/logs/stop/restart, real Codex and console; evidence ${evidenceDir}`);
} finally {
  await client.close();
  await cli('stop', configPath);
}
