import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, toNamespacedPath } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
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
    const stateDir = join(root, 'nested-device-state'.repeat(5), 'session-identity'.repeat(5), agent);
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

test('Windows managed bundled runtime starts beyond MAX_PATH and preserves identity through upgrade and rollback', { skip: !windows, timeout: 120_000 }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/windows-install-'));
  const { configPath } = await initializeDevice({ home: join(root, 'device-with-a-long-installation-path'.repeat(2)), cwd: root });
  const config = await readConfig(configPath), install = installationRoot(configPath);
  t.after(async () => {
    await control(config, 'stop');
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  async function bundle(version: string) {
    const directory = join(root, version);
    await mkdir(join(directory, 'dist'), { recursive: true });
    await mkdir(join(directory, 'runtime'));
    await copyFile(process.execPath, join(directory, 'runtime/node.exe'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@harness-dock/daemon', version, type: 'module' }));
    await writeFile(join(directory, 'dist/device-main.js'), 'export const synthetic = true;');
    await writeFile(join(directory, 'dist/cli.js'), `
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {serveControl} from ${JSON.stringify(pathToFileURL(resolve('apps/daemon/dist/local-control.js')).href)};
if (process.argv[2] === 'run') {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const status = {nodeId:config.nodeId,daemonId:randomUUID(),pid:process.pid,connected:false,endpoint:config.endpoint,
    entrypoint:fileURLToPath(import.meta.url),runtime:process.execPath};
  await serveControl(config, () => status, async () => {}, async () => {});
}`);
    await writeReleaseManifest(directory);
    return directory;
  }
  const first = await bundle('0.0.1'), second = await bundle('0.0.2');
  await manageInstallation('install', { config: configPath, bundle: first, runtime: join(first, 'runtime/node.exe') });
  await startInstalled(configPath, install);
  const before = (await control(config, 'status'))!;
  const original = (await readInstallation(install, configPath))!.current;
  assert.ok(original.runtime.length > 260 && original.runtime.startsWith('\\\\?\\'));
  await manageInstallation('upgrade', { config: configPath, bundle: second, runtime: join(second, 'runtime/node.exe') });
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
