import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { installationEnvironment } from '../apps/daemon/src/installation-environment.ts';
import { windowsCodexApplications } from '../packages/drivers/src/windows-codex.ts';
import { discoverCodexInstallation } from '../packages/drivers/src/codex-environment.ts';
import { discoverDshInstallation } from '../packages/drivers/src/dsh-environment.ts';

test('managed starts retain local provider selections while preferring the fresh launch PATH', () => {
  const runtime = resolve('runtime/node.exe'), live = resolve('fresh-bin'), saved = resolve('local-provider-bin');
  const inherited = { Path: live, PATH: live, DSH_HOME: 'different-home', OTHER: 'preserved' };
  const record = { searchPath: [saved, live].join(delimiter), environment: { DSH_HOME: resolve('native-home'), NOT_ALLOWED: 'ignored' } };
  const environment = installationEnvironment(record, runtime, inherited);
  assert.deepEqual(environment.PATH?.split(delimiter), [dirname(runtime), live, saved]);
  assert.equal(environment.Path, undefined);
  assert.equal(environment.DSH_HOME, record.environment.DSH_HOME);
  assert.equal(environment.NOT_ALLOWED, undefined);
  assert.equal(environment.OTHER, 'preserved');
  assert.equal(inherited.DSH_HOME, 'different-home');
});

test('Windows package discovery resolves an update afresh and ignores removed package files', { skip: process.platform !== 'win32' }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/runtime-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'package-v1'), second = join(root, 'package-v2');
  for (const location of [first, second]) {
    await mkdir(join(location, 'app/resources'), { recursive: true });
    await writeFile(join(location, 'app/resources/codex.exe'), 'synthetic; never executed');
  }
  let registered = first;
  const query: Parameters<typeof windowsCodexApplications>[2] = async (executable, args) => {
    assert.equal(executable, join(process.env.SYSTEMROOT!, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
    assert.ok(args.includes('-NoProfile'));
    assert.match(args.at(-1)!, /Get-AppxPackage -Name OpenAI.Codex/);
    return { exitCode: 0, stdout: JSON.stringify([registered]), stderr: '' } as Awaited<ReturnType<NonNullable<typeof query>>>;
  };
  assert.deepEqual(await windowsCodexApplications(process.env, undefined, query), [join(first, 'app/resources/codex.exe')]);
  await rm(first, { recursive: true }); registered = second;
  assert.deepEqual(await windowsCodexApplications(process.env, undefined, query), [join(second, 'app/resources/codex.exe')]);
  await rm(second, { recursive: true });
  assert.deepEqual(await windowsCodexApplications(process.env, undefined, query), []);
});

test('Windows local dsh survives a GUI launch with no provider PATH and keeps its selected home', { skip: process.platform !== 'win32' }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/runtime-dsh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'local-bin'), home = join(root, 'selected-home');
  await mkdir(bin); await mkdir(home);
  await writeFile(join(bin, 'dsh.cmd'), '@echo off\r\necho dsh synthetic-version\r\n');
  const environment = installationEnvironment({ searchPath: bin, environment: { DSH_HOME: home } }, process.execPath, { PATH: '', SYSTEMROOT: process.env.SYSTEMROOT });
  const found = await discoverDshInstallation({ environment, homeDirectory: root });
  assert.equal(found.status, 'installed');
  assert.equal(found.executable?.toLowerCase(), join(bin, 'dsh.cmd').toLowerCase());
  assert.equal(found.home, home);
  const missing = await discoverDshInstallation({ environment, homeDirectory: root, override: { executable: join(root, 'missing.cmd') } });
  assert.equal(missing.status, 'not_found', 'an explicit selection must never silently fall back');
});

test('Windows Codex discovery does not cross into the real user for a synthetic home', { skip: process.platform !== 'win32' }, async () => {
  const result = await discoverCodexInstallation({ environment: { PATH: '' }, homeDirectory: resolve('.local/synthetic-owner') });
  assert.equal(result.status, 'not_found');
  assert.notEqual(result.home, join(homedir(), '.codex'));
});
