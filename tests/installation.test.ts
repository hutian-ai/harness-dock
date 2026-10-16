import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { manageInstallation, readInstallation, startInstalled } from '../apps/daemon/src/installation.ts';
import { launchAgent, type Autostart } from '../apps/daemon/src/autostart.ts';
import { control } from '../apps/daemon/src/local-control.ts';
import { writeReleaseManifest, verifyRelease } from '../apps/daemon/src/release-manifest.ts';
import { DeviceStore } from '../apps/daemon/src/device-store.ts';

const exec = promisify(execFile);
async function bundle(root: string, name: string, broken = false) {
  const directory = join(root, name);
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@harness-dock/daemon', version: name, type: 'module' }));
  await writeFile(join(directory, 'dist/device-main.js'), 'export const fixture = true;\n');
  // A synthetic daemon uses the actual authenticated socket boundary, without any Provider or model.
  await writeFile(join(directory, 'dist/cli.js'), `
import {readFile, mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveControl} from ${JSON.stringify(pathToFileURL(resolve('apps/daemon/dist/local-control.js')).href)};
const command=process.argv[2];
if(command==='help') console.log('synthetic release');
else if(command==='run') {
  if(${broken}) throw Error('synthetic startup failure');
  const config=JSON.parse(await readFile(process.argv[3],'utf8'));
  await mkdir(config.stateDir,{recursive:true,mode:0o700});
  const status={nodeId:config.nodeId,daemonId:randomUUID(),pid:process.pid,connected:false,endpoint:config.endpoint,
    entrypoint:fileURLToPath(import.meta.url),runtime:process.execPath};
  await serveControl(config,()=>status,async()=>{},async()=>{
    let busy=''; try{busy=await readFile(join(config.stateDir,'busy'),'utf8');}catch{}
    if(busy) throw Error(busy);
  });
}
`);
  await writeReleaseManifest(directory);
  return directory;
}

test('managed install stages independently, upgrades, rolls back, and restores a failed activation', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dock-install-'))), work = join(root, 'work');
  await mkdir(work);
  const { configPath } = await initializeDevice({ home: join(root, 'device'), cwd: work, endpoint: 'ws://127.0.0.1:1/' });
  const config = await readConfig(configPath), install = join(root, 'installed');
  t.after(async () => { await control(config, 'stop'); await rm(root, { recursive: true, force: true }); });
  const originalConfig = await readFile(configPath), a = await bundle(root, 'a'), b = await bundle(root, 'b'), bad = await bundle(root, 'bad', true);
  const parentAlias = join(root, 'parent-alias'); await symlink(root, parentAlias);
  const chosenInstall = join(parentAlias, 'installed');
  await manageInstallation('install', { config: configPath, root: chosenInstall, bundle: a });
  const first = (await readInstallation(install, configPath))!.current;
  // The source can disappear: the installed program owns a separate copy.
  await rm(a, { recursive: true });
  await startInstalled(configPath, chosenInstall);
  const initial = (await control(config, 'status'))!;
  assert.equal(initial.entrypoint, join(install, 'releases', first.id, 'dist/cli.js'));
  await writeFile(join(config.stateDir, 'preserved-history'), 'unknown evidence and session identity');
  await manageInstallation('upgrade', { config: configPath, root: install, bundle: b });
  const second = (await readInstallation(install, configPath))!;
  assert.notEqual(second.current.id, first.id);
  assert.deepEqual(second.previous, first);
  assert.notEqual((await control(config, 'status'))?.daemonId, initial.daemonId);
  await manageInstallation('rollback', { config: configPath, root: install });
  assert.deepEqual((await readInstallation(install, configPath))?.current, first);
  await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: bad }), /activation_failed_previous_restored/);
  assert.deepEqual((await readInstallation(install, configPath))?.current, first);
  assert.equal((await control(config, 'status'))?.entrypoint, initial.entrypoint);
  assert.deepEqual(await readFile(configPath), originalConfig);
  assert.equal(await readFile(join(config.stateDir, 'preserved-history'), 'utf8'), 'unknown evidence and session identity');
  assert.equal((await stat(join(install, 'installation.json'))).mode & 0o777, 0o600);
  // A second operation cannot race the current/previous pointers.
  await writeFile(join(install, 'operation.lock'), 'synthetic concurrent operation');
  await assert.rejects(manageInstallation('rollback', { config: configPath, root: install }), /installation_busy/);
  await assert.rejects(startInstalled(configPath, install), /installation_busy/);
  await rm(join(install, 'operation.lock'));
});

test('installation refuses busy/unknown owners and invalid artifacts before changing the live release', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dock-install-refuse-'))), work = join(root, 'work');
  await mkdir(work);
  const { configPath } = await initializeDevice({ home: join(root, 'device'), cwd: work, endpoint: 'ws://127.0.0.1:1/' });
  const config = await readConfig(configPath), install = join(root, 'installed');
  t.after(async () => { await control(config, 'stop'); await rm(root, { recursive: true, force: true }); });
  const a = await bundle(root, 'a'), b = await bundle(root, 'b');
  await manageInstallation('install', { config: configPath, root: install, bundle: a });
  await startInstalled(configPath, install);
  const original = await readFile(join(install, 'installation.json'), 'utf8'), owner = (await control(config, 'status'))!.daemonId;
  for (const reason of ['device_busy', 'unresolved_execution']) {
    await writeFile(join(config.stateDir, 'busy'), reason);
    await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: b }), new RegExp(reason));
    assert.equal((await control(config, 'status'))?.daemonId, owner);
    assert.equal(await readFile(join(install, 'installation.json'), 'utf8'), original);
  }
  await rm(join(config.stateDir, 'busy'));
  await writeFile(join(b, 'unexpected.txt'), 'not in manifest');
  await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: b }), /integrity_mismatch/);
  assert.equal((await control(config, 'status'))?.daemonId, owner);
  await rm(join(b, 'unexpected.txt'));
  const manifestPath = join(b, 'dock-release.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, arch: 'another-platform' }));
  await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: b }), /platform_mismatch/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, stateFormat: 2 }));
  await assert.rejects(verifyRelease(b), /incompatible_release_format/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await symlink(configPath, join(b, 'external-link'));
  await assert.rejects(verifyRelease(b), /external_symlink/);
  await rm(join(b, 'external-link'));
  await control(config, 'stop');
  const store = new DeviceStore(config.nodeId, config.stateDir);
  store.admit({ runId: 'unknown', provider: 'codex', input: 'identity', state: 'unknown' }); store.close();
  await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: b }), /unresolved_execution/);
  assert.equal(await readFile(join(install, 'installation.json'), 'utf8'), original);
});

test('autostart changes only its owned service and requires confirmed local startup', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dock-autostart-'))), work = join(root, 'work');
  await mkdir(work);
  const { configPath } = await initializeDevice({ home: join(root, 'device'), cwd: work });
  const config = await readConfig(configPath), install = join(root, 'installed');
  t.after(async () => { await control(config, 'stop'); await rm(root, { recursive: true, force: true }); });
  await manageInstallation('install', { config: configPath, root: install, bundle: await bundle(root, 'a') });
  const calls: string[] = []; let loaded = false;
  const service: Autostart = { path: 'synthetic-agent', loaded: async () => loaded,
    check: async () => {},
    enable: async () => { calls.push('enable'); loaded = true; },
    unload: async () => { calls.push('unload'); loaded = false; },
    disable: async () => { calls.push('disable'); loaded = false; },
    start: async () => {
      calls.push('start');
      const record = (await readInstallation(install, configPath))!;
      const { startBackground } = await import('../apps/daemon/src/process-management.ts');
      await startBackground(config, configPath, join(install, 'releases', record.current.id, 'dist/cli.js'), record.current.runtime);
    } };
  const factory = () => service;
  const enabled = await manageInstallation('autostart', { config: configPath, root: install }, factory);
  assert.equal(enabled.autostart, true);
  assert.equal((await readInstallation(install, configPath))?.autostart, true);
  assert.deepEqual(calls, ['enable', 'start']);
  await manageInstallation('upgrade', { config: configPath, root: install, bundle: await bundle(root, 'b') }, factory);
  assert.deepEqual(calls.slice(2), ['unload', 'enable', 'start']);
  const beforeFailure = (await readInstallation(install, configPath))!;
  // A loaded but intentionally stopped agent must also receive a confirmed recovery.
  await control(config, 'stop');
  await assert.rejects(manageInstallation('upgrade', { config: configPath, root: install, bundle: await bundle(root, 'bad', true) }, factory), /activation_failed_previous_restored/);
  assert.equal((await readInstallation(install, configPath))?.current.id, beforeFailure.current.id);
  assert.equal((await readInstallation(install, configPath))?.autostart, true);
  assert.equal(loaded, true);
  assert.equal((await control(config, 'status'))?.entrypoint, join(install, 'releases', beforeFailure.current.id, 'dist/cli.js'));
  await manageInstallation('autostart', { config: configPath, root: install, disable: true }, factory);
  assert.equal((await readInstallation(install, configPath))?.autostart, false);
  assert.equal(await control(config, 'status'), null);
  assert.equal(calls.at(-1), 'disable');
  const plan = launchAgent('/private/install & test', '/private/config <test>.json', '/private/node', '/usr/bin:/bin', '/private/user');
  assert.match(plan.content, /SuccessfulExit<\/key><false\/>/);
  assert.match(plan.content, /install &amp; test/);
  assert.match(plan.content, /config &lt;test&gt;/);
  assert.match(plan.content, /RunAtLoad/);
  assert.ok(!plan.content.includes(config.token));
  const plist = join(root, 'agent.plist'); await writeFile(plist, plan.content);
  if (process.platform === 'darwin') await exec('/usr/bin/plutil', ['-lint', plist]);
  assert.equal(dirname(plan.path), '/private/user/Library/LaunchAgents');
});
