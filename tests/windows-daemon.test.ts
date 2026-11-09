import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, toNamespacedPath } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { assertWindowsPrivatePath, protectWindowsDirectory } from '../packages/drivers/src/windows-security.ts';
import { pathCandidates } from '../packages/drivers/src/installation-lookup.ts';
import { runBoundedCommand } from '../packages/drivers/src/process-command.ts';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { installationRoot, manageInstallation, readInstallation, startInstalled } from '../apps/daemon/src/installation.ts';
import { control } from '../apps/daemon/src/local-control.ts';
import { writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { createCodexRuntime } from '../packages/drivers/src/codex.ts';
import { createDshRuntime } from '../packages/drivers/src/dsh.ts';

const windows = process.platform === 'win32';
test('Windows Codex and dsh persist ACP sessions beyond MAX_PATH without dispatching a prompt', { skip: !windows, timeout: 20_000 }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/windows-long-state-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const fixture = join(root, 'peer.mjs');
  await writeFile(fixture, `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const q=JSON.parse(line);
  let result;
  if(q.method==='initialize') result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
  else if(q.method==='session/new') result={sessionId:'synthetic-native-session'};
  else throw Error('unexpected request: '+q.method);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`);
  for (const agent of ['codex', 'dsh'] as const) {
    const stateDir = join(root, 'nested-device-state'.repeat(8), 'session-identity'.repeat(8), agent);
    assert.ok(stateDir.length > 260);
    const factory = () => agent === 'codex'
      ? createCodexRuntime({ cwd: root, codexHome: root, stateDir }, [process.execPath, fixture])
      : createDshRuntime({ cwd: root, dshHome: root, dshBin: fixture, stateDir }, [process.execPath, fixture]);
    const runtime = factory();
    try {
      await runtime.ensureSession({ agent, sessionKey: 'synthetic', mode: 'persistent', cwd: root });
      assert.ok(await runtime.findSession({ agent, sessionKey: 'synthetic' }));
    } finally { await runtime.shutdown(); }
    const restarted = factory();
    try { assert.ok(await restarted.findSession({ agent, sessionKey: 'synthetic' })); }
    finally { await restarted.shutdown(); }
  }
});

test('Windows managed bundled runtime starts beyond MAX_PATH and preserves identity through upgrade and rollback', { skip: !windows, timeout: 240_000 }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/windows-install-'));
  const { configPath } = await initializeDevice({ home: join(root, 'device-with-a-long-installation-path'.repeat(4)), cwd: root });
  const config = await readConfig(configPath), install = installationRoot(configPath);
  t.after(async () => {
    await control(config, 'stop');
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  // Use a standalone deployment so the relocated runtime never resolves
  // dependencies through the checkout's pnpm junctions.
  const bundle = join(root, 'bundle');
  await execa('pnpm', ['--filter', '@harness-dock/daemon', 'deploy', '--prod', '--offline',
    '--no-optional', '--config.node-linker=hoisted', bundle]);
  await mkdir(join(bundle, 'runtime'));
  const runtime = join(bundle, 'runtime/node.exe');
  await copyFile(process.execPath, runtime);
  await writeReleaseManifest(bundle);
  const options = { config: configPath, bundle, runtime };
  await manageInstallation('install', options);
  await startInstalled(configPath, install);
  const before = (await control(config, 'status'))!;
  const original = (await readInstallation(install, configPath))!.current;
  assert.ok(original.runtime.length > 260 && original.runtime.startsWith('\\\\?\\'));
  const packageFile = join(bundle, 'package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  // Replace the file rather than modifying the package manager's hard link.
  await rm(packageFile);
  await writeFile(packageFile, JSON.stringify({ ...manifest, version: '0.0.2' }));
  await rm(join(bundle, 'dock-release.json'));
  await writeReleaseManifest(bundle);
  await manageInstallation('upgrade', options);
  assert.notEqual((await readInstallation(install, configPath))!.current.id, original.id);
  assert.notEqual((await control(config, 'status'))!.daemonId, before.daemonId);
  await manageInstallation('rollback', { config: configPath });
  assert.deepEqual((await readInstallation(install, configPath))!.current, original);
  assert.equal((await readConfig(configPath)).nodeId, config.nodeId);
});

test('Windows ACLs work with a foreign PowerShell module path and reject shared state', { skip: !windows }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/windows-acl-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const directory = join(root, 'private-directory'.repeat(8), "设备 & owner's state");
  await mkdir(directory, { recursive: true });
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = join(root, 'absent-powershell-7-modules');
  try {
    await protectWindowsDirectory(directory);
    const file = join(directory, 'synthetic.json');
    await writeFile(file, '{}');
    await assertWindowsPrivatePath(directory);
    await assertWindowsPrivatePath(file);
    await execa(join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32/icacls.exe'),
      [toNamespacedPath(directory), '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true });
    await assert.rejects(assertWindowsPrivatePath(directory), /windows_private_path_unavailable/);
    await assert.rejects(assertWindowsPrivatePath(file), /windows_private_path_unavailable/);
  } finally {
    if (previous === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = previous;
  }
});

test('Windows discovers and runs a selected CMD shim with spaces and shell metacharacters', { skip: !windows }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/windows-command-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const bin = join(root, 'native installation & tools');
  await mkdir(bin);
  await writeFile(join(bin, 'probe.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const shim = join(bin, 'dsh.cmd');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n`);
  const candidates = await pathCandidates('dsh', { Path: bin, PATHEXT: '.EXE;.CMD' });
  assert.equal(candidates[0]?.path, shim);
  const args = ['space value', 'a&b', '中文'];
  const result = await runBoundedCommand(shim, args);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
