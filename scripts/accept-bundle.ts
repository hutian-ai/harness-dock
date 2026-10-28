import { acceptDevice } from './accept-device.ts';
import { verifyRelease } from '../apps/daemon/src/release-manifest.ts';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const source = resolve(process.argv[2] ?? '.local/bundle');
const offline = process.argv[3] === '--offline';
assert.ok(process.argv.length <= 4 && (!process.argv[3] || offline), 'Usage: accept-bundle.ts [directory] [--offline]');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-dock-delivery-')));
await cp(source, directory, { recursive: true, verbatimSymlinks: true });
const release = await verifyRelease(join(directory, 'daemon'));
async function checkNotices(root: string): Promise<void> {
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).license, 'MIT');
  assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /Third-party software/);
  const notices: { location: string; name: string; version: string; license: string; notices: string[] }[] =
    JSON.parse(await readFile(join(root, 'THIRD_PARTY_NOTICES.json'), 'utf8'));
  assert.ok(notices.length > 0);
  for (const entry of notices) {
    const metadata = JSON.parse(await readFile(join(root, entry.location, 'package.json'), 'utf8'));
    assert.equal(metadata.name, entry.name);
    assert.equal(metadata.version, entry.version);
    assert.equal(typeof metadata.license === 'string' ? metadata.license : metadata.license?.type, entry.license);
    assert.ok(entry.license && entry.notices.length);
    for (const path of entry.notices) {
      assert.ok((await realpath(join(root, path))).startsWith(root + '/'));
      assert.ok((await readFile(join(root, path))).length > 0);
    }
  }
}
for (const target of ['daemon', 'controller', 'server']) await checkNotices(join(directory, target));
const driverRequire = createRequire(join(directory, 'daemon/node_modules/@harness-dock/drivers/package.json'));
for (const [dependency, patch] of [['acpx', 'acpx@0.21.1.patch'], ['@agentclientprotocol/codex-acp', '@agentclientprotocol__codex-acp@2.3.0.patch']]) {
  const packageDirectory = dirname(driverRequire.resolve(`${dependency}/package.json`));
  execFileSync('git', ['apply', '--reverse', '--check', join(directory, 'daemon/patches', patch!)], { cwd: packageDirectory, stdio: 'inherit' });
}
// The SDK archive must install without the unpacked controller or a warm registry cache.
await rm(join(directory, 'controller'), { recursive: true });
const consumer = join(directory, 'consumer');
await mkdir(consumer);
await writeFile(join(consumer, 'package.json'), JSON.stringify({
  private: true, type: 'module', dependencies: { '@harness-dock/client': 'file:../controller.tgz' },
}));
execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(directory, 'install-cache')], { cwd: consumer, stdio: 'inherit', timeout: 60_000 });
execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(directory, 'ci-cache')], { cwd: consumer, stdio: 'inherit', timeout: 60_000 });
await writeFile(join(consumer, 'index.ts'), [
  "export { ServerClient, DeviceController, DockError } from '@harness-dock/client';",
  "export type { ServerPeer, DeviceNodeSummary, DeviceRequestHandler } from '@harness-dock/client';",
  "import type { ServerPeer, DeviceInventory, DeviceExecutionResponse, DevicePermissionDecision } from '@harness-dock/client';",
  "export async function typedConsumer(peer: ServerPeer) {",
  "  const inventory: DeviceInventory = await peer.request('inventory');",
  "  const result: DeviceExecutionResponse = await peer.request('execute', { provider: inventory.providers[0]!.key, runId: 'synthetic', prompt: 'never called' });",
  "  peer.onExecutionCallback(async request => {",
  "    if (request.kind === 'permission') { request.payload.options?.[0]?.optionId satisfies string | undefined; return 'deny' satisfies DevicePermissionDecision; }",
  "    return null;",
  "  });",
  "  // @ts-expect-error execution identity is required",
  "  await peer.request('execute', { provider: 'codex', prompt: 'never called' });",
  "  return result;",
  "}",
].join('\n'));
await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [], outDir: 'dist' },
  include: ['index.ts'],
}));
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'inherit' });
const clientEntry = await realpath(join(consumer, 'node_modules/@harness-dock/client/dist/index.js'));
assert.ok(clientEntry.startsWith(consumer + '/'));
const require = createRequire(clientEntry);
for (const dependency of ['@harness-dock/protocol', 'ws', 'json-rpc-2.0'])
  assert.ok((await realpath(join(dirname(dirname(clientEntry)), 'node_modules', dependency))).startsWith(consumer + '/'));
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
assert.equal((await verifyRelease(join(directory, 'daemon'))).id, release.id);
await checkNotices(dirname(dirname(clientEntry)));
if (!offline) await acceptDevice('codex', { daemon: cliPath, client: join(consumer, 'dist/index.js'), server: join(directory, 'server/dist/index.js') });
console.log(`PASS outside-checkout offline SDK archive install/ci, types, dependency isolation, applied patches, licenses and installed Daemon${offline ? '' : ' and real Codex'}: ${directory}`);
