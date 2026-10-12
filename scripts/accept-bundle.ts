import { acceptDevice } from './accept-device.ts';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
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
  "export { ServerClient, DeviceController, DockError } from '@harness-dock/client';",
  "export type { ServerPeer, DeviceNodeSummary, DeviceRequestHandler } from '@harness-dock/client';",
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
const agentConsumer = join(directory, 'agent-consumer');
await mkdir(agentConsumer);
await writeFile(join(agentConsumer, 'package.json'), JSON.stringify({
  private: true, dependencies: { '@harness-dock/daemon': 'file:../daemon' },
}));
execFileSync('npm', ['install', '--offline', '--install-links=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: agentConsumer, stdio: 'inherit', timeout: 60_000 });
const cliPath = join(agentConsumer, 'node_modules/.bin/harness-dock-daemon');
const exec = promisify(execFile);
const cli = async (...args: string[]) => (await exec(cliPath, args, { cwd: directory, timeout: 45_000 })).stdout;
assert.match(await cli('help'), /Default config: .local.device.config.json/);
await acceptDevice('codex', { daemon: cliPath, client: join(consumer, 'dist/index.js'), server: join(directory, 'server/dist/index.js') });
console.log(`PASS outside-checkout SDK types, dependency isolation, installed Daemon and real Codex: ${directory}`);
