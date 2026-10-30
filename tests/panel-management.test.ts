import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DEVICE_PROTOCOL_VERSION } from '../packages/protocol/src/index.ts';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { control, serveControl } from '../apps/daemon/src/local-control.ts';
import { discoverPanelDevices, panelError, panelStatus, runPanelOperation } from '../apps/daemon/src/panel-management.ts';
import { readInstallation } from '../apps/daemon/src/installation.ts';
import { writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { setupDevice } from '../apps/daemon/src/setup.ts';
import { retireLegacyAutostart } from '../apps/daemon/src/legacy-autostart.ts';
import { writePanelControlFixture } from './fixtures/panel-control.ts';

async function directory() { await mkdir('.local', { recursive: true }); return mkdtemp(resolve('.local/panel-test-')); }

async function releaseMetadataFixture(root: string, version: string) {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@harness-dock/daemon', version, type: 'module' }));
  await writeFile(join(root, 'dist/cli.js'), 'export const synthetic = true;');
  await writeReleaseManifest(root);
  const text = await readFile(join(root, 'dock-release.json'), 'utf8');
  return { root, version, text, id: createHash('sha256').update(text).digest('hex') };
}

async function releasePanelFixture(root: string, installed: Awaited<ReturnType<typeof releaseMetadataFixture>>) {
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'ws://127.0.0.1:1/' });
  const config = { ...await readConfig(paths.configPath), providers: { codex: { disabled: true }, dsh: { disabled: true } } };
  await writeFile(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  const installation = join(root, 'device/installation'), current = { id: installed.id,
    runtime: join(installation, 'releases', installed.id, 'runtime/node') };
  await mkdir(join(installation, 'releases', current.id), { recursive: true, mode: 0o700 });
  await writeFile(join(installation, 'releases', current.id, 'dock-release.json'), installed.text, { mode: 0o600 });
  const record = { format: 1, stateFormat: 1, protocol: DEVICE_PROTOCOL_VERSION, configPath: await realpath(paths.configPath),
    nodeId: config.nodeId, current, autostart: false, searchPath: '/usr/bin:/bin' };
  await writeFile(join(installation, 'installation.json'), JSON.stringify(record), { mode: 0o600 });
  return { paths, config, installation, record };
}

test('panel compares release metadata without full bundle verification; activation still rejects changed files', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const app = await releaseMetadataFixture(join(root, 'app-daemon'), '1.0.0');
  const f = await releasePanelFixture(root, app);
  await writeFile(join(app.root, 'dist/cli.js'), 'changed after the manifest was written');
  const state = await runPanelOperation({ operation: 'status', config: f.paths.configPath }, app.root, root) as Awaited<ReturnType<typeof panelStatus>>;
  assert.equal(state.appVersion, '1.0.0'); assert.equal(state.installedVersion, '1.0.0');
  assert.equal(state.appReleaseId, app.id); assert.equal(state.installedReleaseId, app.id);
  assert.equal(state.releaseMatchesApp, true); assert.equal(state.updateAvailable, false);
  assert.equal(state.runningReleaseId, undefined);
  assert.equal(state.providers.find(provider => provider.key === 'codex')?.experimental, false);
  assert.equal(state.providers.find(provider => provider.key === 'dsh')?.experimental, true);
  const original = await readFile(join(f.installation, 'installation.json'));
  await assert.rejects(runPanelOperation({ operation: 'upgrade', config: f.paths.configPath }, app.root, root), /release_integrity_mismatch/);
  assert.deepEqual(await readFile(join(f.installation, 'installation.json')), original);
});

test('panel offers the different App release only for the matching managed owner and keeps mismatched owners explicit', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const installed = await releaseMetadataFixture(join(root, 'installed-source'), '1.0.0');
  const app = await releaseMetadataFixture(join(root, 'app-daemon'), '1.1.0');
  const f = await releasePanelFixture(root, installed);
  const stopped = await panelStatus(f.paths.configPath, root, app.root);
  assert.equal(stopped.releaseMatchesApp, false); assert.equal(stopped.updateAvailable, true);
  assert.equal(stopped.appVersion, '1.1.0'); assert.equal(stopped.installedVersion, '1.0.0');
  const owner = { nodeId: f.config.nodeId, daemonId: randomUUID(), pid: process.pid, connected: false, endpoint: f.config.endpoint,
    entrypoint: join(f.installation, 'releases', installed.id, 'dist/cli.js'), runtime: f.record.current.runtime };
  const close = await serveControl(f.config, () => owner, async () => {}); t.after(close);
  const matching = await panelStatus(f.paths.configPath, root, app.root);
  assert.equal(matching.runningReleaseId, installed.id); assert.equal(matching.releaseMatchesApp, false); assert.equal(matching.updateAvailable, true);
  owner.entrypoint = join(f.installation, 'releases', app.id, 'dist/cli.js');
  const mismatched = await panelStatus(f.paths.configPath, root, app.root);
  assert.equal(mismatched.runningReleaseId, app.id);
  assert.equal(mismatched.releaseMatchesApp, false, 'a live owner must also match its installation record');
  assert.equal(mismatched.updateAvailable, false);
  owner.entrypoint = join(root, 'source-checkout/dist/cli.js');
  const sourceOwner = await panelStatus(f.paths.configPath, root, app.root);
  assert.equal(sourceOwner.running, true); assert.equal(sourceOwner.runningReleaseId, undefined);
  assert.equal(sourceOwner.releaseMatchesApp, undefined); assert.equal(sourceOwner.updateAvailable, false);
});

test('optional release metadata refuses unsafe or oversized manifests without hiding device status', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const installed = await releaseMetadataFixture(join(root, 'installed-source'), '1.0.0');
  const app = await releaseMetadataFixture(join(root, 'app-daemon'), '1.1.0');
  const f = await releasePanelFixture(root, installed), path = join(app.root, 'dock-release.json');
  for (const kind of ['missing', 'symlink', 'oversized', 'incompatible'] as const) {
    await rm(path, { force: true });
    if (kind === 'symlink') await symlink(join(installed.root, 'dock-release.json'), path);
    if (kind === 'oversized') { await writeFile(path, '{}'); await truncate(path, 8 * 1024 * 1024 + 1); }
    if (kind === 'incompatible') await writeFile(path, JSON.stringify({ ...JSON.parse(app.text), protocol: DEVICE_PROTOCOL_VERSION + 1 }));
    const state = await panelStatus(f.paths.configPath, root, app.root);
    assert.equal(state.configured, true, kind); assert.equal(state.managed, true, kind);
    assert.equal(state.installedVersion, '1.0.0', kind);
    assert.equal(state.appVersion, undefined, kind); assert.equal(state.releaseMatchesApp, undefined, kind); assert.equal(state.updateAvailable, false, kind);
  }
  await rm(path); await writeFile(path, app.text);
  await writeFile(join(f.installation, 'releases', installed.id, 'dock-release.json'), app.text);
  const wrongInstalledMetadata = await panelStatus(f.paths.configPath, root, app.root);
  assert.equal(wrongInstalledMetadata.installedVersion, undefined);
  assert.equal(wrongInstalledMetadata.releaseMatchesApp, undefined); assert.equal(wrongInstalledMetadata.updateAvailable, false);
  const unconfigured = await panelStatus(join(root, 'unconfigured/config.json'), root, app.root);
  assert.equal(unconfigured.configured, false); assert.equal(unconfigured.appVersion, '1.1.0'); assert.equal(unconfigured.updateAvailable, false);
});

test('panel imports bounded pairing without modifying the source, and projects no credential', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'device/config.json'), file = join(root, 'download.json');
  const pairing = { nodeId: randomUUID(), token: 'synthetic-panel-token-value-that-must-not-leak', endpoint: 'wss://dock.example.com/' };
  await writeFile(file, JSON.stringify(pairing), { mode: 0o644 });
  const preview = await runPanelOperation({ operation: 'pairing', config, pairing: file }, root);
  assert.deepEqual(preview, { server: 'dock.example.com', nodeId: pairing.nodeId });
  assert.ok(!JSON.stringify(preview).includes(pairing.token));
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  for (const data of [{ ...pairing, token: 'short' }, { ...pairing, endpoint: 'ws://dock.example.com/' }, { ...pairing, nodeId: 'invalid' }, { ...pairing, command: 'arbitrary' }]) {
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(runPanelOperation({ operation: 'pairing', config, pairing: file }, root));
  }
  await writeFile(file, ' '.repeat(16_385));
  await assert.rejects(runPanelOperation({ operation: 'pairing', config, pairing: file }, root), /invalid_device_pairing/);
  await assert.rejects(runPanelOperation({ operation: 'execute', config, prompt: 'must never execute' }, root), /invalid_panel_request/);
  const unconfigured = await panelStatus(config);
  assert.equal(unconfigured.configured, false);
  assert.ok(Array.isArray(unconfigured.providers));
  assert.ok(unconfigured.providers.every(provider => provider.selfTestSupported === false));
});

test('panel adopts existing identity read-only and does not confuse a stale owner with the saved server', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'wss://dock.example.com/' });
  const config = await readConfig(paths.configPath), original = await readFile(paths.configPath);
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId: 'synthetic-owner', pid: process.pid,
    connected: true, endpoint: 'wss://other.example.com/', activeRunIds: ['run-a'], unresolvedRunIds: ['run-b'] }), async () => {});
  t.after(close);
  const result = await panelStatus(paths.configPath);
  assert.equal(result.connected, false); assert.equal(result.connectionIssue, 'configuration_mismatch');
  assert.equal(result.active, 1); assert.equal(result.unresolved, 1); assert.equal(result.managed, false);
  assert.ok(!JSON.stringify(result).includes(config.token));
  await assert.rejects(runPanelOperation({ operation: 'stop', config: paths.configPath }, root), /device_not_installed/);
  await assert.rejects(setupDevice({ home: join(root, 'device'), cwd: root, nodeId: randomUUID(), token: config.token,
    endpoint: config.endpoint, bundle: root }), /setup_identity_conflict/);
  assert.deepEqual(await readFile(paths.configPath), original);
  await chmod(paths.configPath, 0o644);
  await assert.rejects(panelStatus(paths.configPath), /invalid_config_file_permissions/);
});

test('panel identifies an externally managed live owner without offering implicit migration', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'wss://dock.example.com/' });
  const config = await readConfig(paths.configPath), original = await readFile(paths.configPath);
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId: 'synthetic-external-owner', pid: process.pid,
    connected: true, endpoint: config.endpoint, entrypoint: join(root, 'custom-installation/releases', 'a'.repeat(64), 'dist/cli.js') }), async () => {});
  t.after(close);
  const result = await panelStatus(paths.configPath);
  assert.equal(result.externalInstallation, true); assert.equal(result.managed, false); assert.equal(result.connected, true);
  assert.deepEqual(await readFile(paths.configPath), original);
  assert.ok(!JSON.stringify(result).includes(config.token));
});

test('panel projects discovered installations and test capabilities without conflating model readiness', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'wss://dock.example.com/' });
  const executable = join(root, 'synthetic-harness');
  await writeFile(executable, '#!/bin/sh\necho 0.1.2\n', { mode: 0o700 });
  const config = { ...await readConfig(paths.configPath), providers: {
    codex: { executable, home: root }, dsh: { executable, home: root },
  } };
  await writeFile(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  const testId = randomUUID();
  const selfTest = { id: testId, runId: testId, daemonId: randomUUID(), provider: 'dsh' as const,
    state: 'passed' as const, phase: 'finished' as const, startedAt: 1, finishedAt: 2 };
  const daemonId = randomUUID();
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId, pid: process.pid,
    connected: false, endpoint: config.endpoint, selfTests: [selfTest], selfTestProviders: ['codex', 'dsh'] }), async () => {});
  t.after(close);
  const state = await panelStatus(paths.configPath);
  assert.deepEqual(state.selfTests, [selfTest]);
  assert.equal(state.selfTest, undefined, 'legacy Codex status cannot project a dsh pass');
  const dshSupported = process.platform === 'darwin' && process.arch === 'arm64';
  assert.deepEqual(state.providers.map(provider => [provider.key, provider.status, provider.selfTestKind, provider.selfTestSupported]),
    [['codex', 'installed', 'read-only-echo', true], ['dsh', dshSupported ? 'installed' : 'not_found', 'native-echo', dshSupported]]);
  for (const provider of state.providers.filter(provider => provider.status === 'installed')) {
    assert.equal(provider.executable, executable); assert.equal(provider.home, root); assert.equal(provider.source, 'configured');
    assert.equal(provider.version, '0.1.2');
    assert.ok(provider.acceptanceCommand); assert.ok(!JSON.stringify(provider).includes(config.token));
    assert.ok(!('models' in provider), 'installation discovery is not a readiness probe');
  }
});

test('panel setup installs its bundled runtime independently and stop keeps the owner busy guard', { timeout: 60_000 }, async t => {
  const root = await directory(), bundle = join(root, 'app-daemon'), home = join(root, 'device'), configPath = join(home, 'config.json');
  await mkdir(join(bundle, 'dist'), { recursive: true }); await mkdir(join(bundle, 'runtime'));
  await copyFile(process.execPath, join(bundle, 'runtime/node'), constants.COPYFILE_FICLONE);
  await chmod(join(bundle, 'runtime/node'), 0o755);
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@harness-dock/daemon', version: 'panel-fixture', type: 'module' }));
  await writePanelControlFixture(bundle);
  await writeFile(join(bundle, 'dist/device-main.js'), 'export const fixture = true;');
  await writeFile(join(bundle, 'dist/cli.js'), `
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const controlModule=new URL('./local-control.js',import.meta.url);
const {serveControl}=await import(controlModule.href);
if(process.argv[2]==='help') console.log(JSON.stringify({controlModule:controlModule.href,protocolModule:import.meta.resolve('@harness-dock/protocol')}));
else if(process.argv[2]==='run') {
 const config=JSON.parse(await readFile(process.argv[3],'utf8'));
 const status={nodeId:config.nodeId,daemonId:'synthetic-panel-daemon',pid:process.pid,connected:false,endpoint:config.endpoint,
  entrypoint:fileURLToPath(import.meta.url),runtime:process.execPath};
 await serveControl(config,()=>status,async()=>{},async()=>{
  let reason=''; try{reason=await readFile(join(config.stateDir,'busy'),'utf8');}catch{}
  if(reason) throw Error(reason);
 });
}`);
  await writeReleaseManifest(bundle);
  const pairing = join(root, 'download.json');
  await writeFile(pairing, JSON.stringify({ nodeId: randomUUID(), token: 'synthetic-panel-setup-token-never-displayed', endpoint: 'ws://127.0.0.1:1/' }), { mode: 0o644 });
  t.after(async () => {
    try { await control(await readConfig(configPath), 'stop'); } finally { await rm(root, { recursive: true, force: true }); }
  });
  const state = await runPanelOperation({ operation: 'setup', config: configPath, pairing, cwd: root }, bundle) as Awaited<ReturnType<typeof panelStatus>>;
  assert.equal(state.configured, true); assert.equal(state.running, true); assert.equal(state.connected, false);
  const installation = (await readInstallation(join(home, 'installation'), configPath))!;
  assert.equal(installation.current.runtime, join(home, 'installation/releases', installation.current.id, 'runtime/node'));
  const release = join(home, 'installation/releases', installation.current.id);
  const help = await promisify(execFile)(installation.current.runtime, [join(release, 'dist/cli.js'), 'help']);
  assert.deepEqual(JSON.parse(help.stdout), {
    controlModule: pathToFileURL(join(release, 'dist/local-control.js')).href,
    protocolModule: pathToFileURL(join(release, 'node_modules/@harness-dock/protocol/dist/index.js')).href,
  });
  const config = await readConfig(configPath), before = await readFile(configPath);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  for (const reason of ['device_busy', 'unresolved_execution']) {
    await writeFile(join(config.stateDir, 'busy'), reason);
    await assert.rejects(runPanelOperation({ operation: 'stop', config: configPath }, bundle), new RegExp(reason));
    assert.equal((await panelStatus(configPath)).running, true);
  }
  await rm(join(config.stateDir, 'busy'));
  await runPanelOperation({ operation: 'stop', config: configPath }, bundle);
  const legacyFiles = await initializeDevice({ home: join(root, 'legacy-device'), cwd: root });
  const legacyConfig = await readConfig(legacyFiles.configPath), legacyBytes = await readFile(legacyFiles.configPath);
  await writeFile(join(legacyConfig.stateDir, 'preserved-history'), 'original execution evidence');
  t.after(async () => { await control(legacyConfig, 'stop'); });
  const migrated = await runPanelOperation({ operation: 'install', config: legacyFiles.configPath }, bundle) as Awaited<ReturnType<typeof panelStatus>>;
  assert.equal(migrated.managed, true); assert.equal(migrated.running, true);
  assert.deepEqual(await readFile(legacyFiles.configPath), legacyBytes);
  assert.deepEqual(await readFile(join(root, 'legacy-device/retired-autostart/config-before-panel.json')), legacyBytes);
  assert.equal(await readFile(join(legacyConfig.stateDir, 'preserved-history'), 'utf8'), 'original execution evidence');
  await runPanelOperation({ operation: 'stop', config: legacyFiles.configPath }, bundle);
  await rm(bundle, { recursive: true });
  // Removing/moving the application payload must not break the installed device runtime.
  await runPanelOperation({ operation: 'start', config: configPath }, bundle);
  assert.equal((await panelStatus(configPath)).running, true);
  assert.deepEqual(await readFile(configPath), before);
  await runPanelOperation({ operation: 'stop', config: configPath }, bundle);
});

test('panel errors cannot disclose arbitrary native exception content', () => {
  assert.equal(panelError(new Error('token=synthetic-secret /private/user/work')), 'management_failed');
  assert.equal(panelError(new Error('local_control_rejected:409:device_busy')), 'device_busy');
  assert.equal(panelError(new Error('activation_failed_recovery_unconfirmed:private provider result')), 'activation_failed_recovery_unconfirmed');
});

test('local discovery is bounded to known configuration locations, deduplicates and never searches old fixtures', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, '.harness-dock/.local/device');
  const files = await initializeDevice({ home, cwd: root, endpoint: 'wss://dock.example.com/' });
  await initializeDevice({ home: join(root, 'unrelated-fixture'), cwd: root });
  const secret = (await readConfig(files.configPath)).token;
  const found = await discoverPanelDevices(files.configPath, false, root);
  assert.equal(found.devices.length, 1); assert.equal(found.devices[0]?.configPath, files.configPath);
  assert.ok(!JSON.stringify(found).includes(secret));
  const isolated = await runPanelOperation({ operation: 'discover', config: join(root, 'missing/config.json'), selectedOnly: true }, root);
  assert.deepEqual(isolated, { devices: [], incomplete: false });
});

test('legacy discovery finds the old user service, and retirement preserves identity and original startup preference', { skip: process.platform !== 'darwin' }, async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const files = await initializeDevice({ home: join(root, 'old-cache-device'), cwd: root, endpoint: 'wss://dock.example.com/' });
  const config = await readConfig(files.configPath), original = await readFile(files.configPath);
  const agents = join(root, 'Library/LaunchAgents'); await mkdir(agents, { recursive: true });
  const service = join(agents, 'dev.harness-dock.device.plist');
  await writeFile(service, `<?xml version="1.0"?><plist version="1.0"><dict>
<key>Label</key><string>dev.harness-dock.device</string><key>ProgramArguments</key><array>
<string>/usr/bin/node</string><string>/private/old-daemon/cli.js</string><string>run</string><string>${files.configPath}</string>
</array><key>RunAtLoad</key><true/></dict></plist>`, { mode: 0o600 });
  const found = await discoverPanelDevices(join(root, 'missing/config.json'), false, root);
  assert.equal(found.devices[0]?.configPath, files.configPath);
  const calls: string[][] = [];
  const retired = await retireLegacyAutostart(files.configPath, config, root, async args => { calls.push(args); });
  assert.deepEqual(retired, { retired: true, autostart: true });
  assert.deepEqual(calls, [['bootout', `gui/${process.getuid!()}/dev.harness-dock.device`]]);
  await assert.rejects(stat(service), { code: 'ENOENT' });
  assert.ok((await readdir(join(root, 'old-cache-device/retired-autostart'))).some(name => name.endsWith('.plist')));
  assert.deepEqual(await readFile(files.configPath), original);
  assert.deepEqual(await retireLegacyAutostart(files.configPath, config, root, async () => assert.fail()), { retired: false, autostart: true });
});

test('legacy retirement cannot unload a live owner or a service belonging to another device', { skip: process.platform !== 'darwin' }, async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const files = await initializeDevice({ home: join(root, 'device'), cwd: root });
  const other = await initializeDevice({ home: join(root, 'other'), cwd: root });
  const config = await readConfig(files.configPath);
  const agents = join(root, 'Library/LaunchAgents'); await mkdir(agents, { recursive: true });
  const service = join(agents, 'dev.harness-dock.device.plist');
  const plist = (path: string) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.harness-dock.device</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/private/cli.js</string><string>run</string><string>${path}</string></array></dict></plist>`;
  await writeFile(service, plist(other.configPath), { mode: 0o600 });
  assert.deepEqual(await retireLegacyAutostart(files.configPath, config, root, async () => assert.fail()), { retired: false, autostart: false });
  await writeFile(service, plist(files.configPath));
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId: 'live-owner', pid: process.pid, connected: true, endpoint: config.endpoint }), async () => {});
  t.after(close);
  await assert.rejects(retireLegacyAutostart(files.configPath, config, root, async () => assert.fail()), /legacy_owner_still_running/);
  assert.equal(await readFile(service, 'utf8'), plist(files.configPath));
});
