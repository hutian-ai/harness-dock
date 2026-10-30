import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { discoverProviders } from '../packages/drivers/src/discovery.ts';
import { discoverDshInstallation } from '../packages/drivers/src/dsh-environment.ts';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  await mkdir('.local', { recursive: true });
  const root = await realpath(await mkdtemp(resolve('.local/discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function executable(path: string) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 42\nprintf "dsh synthetic-version\\n"\n', { mode: 0o700 });
}
async function npmInstallation(root: string, version = '0.1.2-rc.1') {
  const directory = join(root, 'lib/node_modules/@deepseek-ai/dsh'), cli = join(directory, 'lib/bin.js');
  await executable(cli);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  await mkdir(join(root, 'bin'), { recursive: true });
  const path = join(root, 'bin/dsh');
  await symlink(cli, path);
  return { path, cli };
}

test('dsh discovery selects the installed npm binary and home without starting it or reading native config', { skip: !supported }, async t => {
  const root = await temporary(t), install = await npmInstallation(join(root, 'installation'));
  await writeFile(install.cli, '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  const nativeHome = join(root, 'native-home');
  await mkdir(nativeHome);
  const nativeConfig = 'private native configuration: deliberately not JSON';
  await writeFile(join(nativeHome, 'config.json'), nativeConfig);
  const providers = await discoverProviders({ homeDirectory: root,
    environment: { PATH: join(root, 'installation/bin'), DSH_HOME: nativeHome }, overrides: { codex: { disabled: true } } });
  assert.deepEqual(providers.map(provider => provider.key), ['codex', 'dsh']);
  const dsh = providers[1]!;
  assert.equal(dsh.status, 'installed'); assert.equal(dsh.executable, install.cli);
  assert.equal(dsh.version, '0.1.2-rc.1', 'version comes from the selected package, not a CLI process');
  assert.equal(dsh.source, 'path'); assert.equal(dsh.home, nativeHome);
  assert.equal(await readFile(join(nativeHome, 'config.json'), 'utf8'), nativeConfig);
  assert.equal(JSON.stringify(dsh).includes(nativeConfig), false);
});

test('dsh configured selection takes precedence and never falls back to another installation', { skip: !supported }, async t => {
  const root = await temporary(t), path = join(root, 'bin/dsh');
  await executable(path);
  const environment = { PATH: join(root, 'bin'), DSH_HOME: join(root, 'environment-home') };
  const found = await discoverDshInstallation({ environment, homeDirectory: root,
    override: { executable: 'dsh', home: join(root, 'selected-home') } });
  assert.equal(found.executable, path); assert.equal(found.home, join(root, 'selected-home'));
  assert.equal(found.source, 'configured'); assert.equal(found.version, 'synthetic-version');
  const missing = await discoverDshInstallation({ environment, homeDirectory: root, override: { executable: join(root, 'missing') } });
  assert.equal(missing.status, 'not_found'); assert.equal(missing.executable, null);
  assert.equal(missing.reason, 'Configured executable not found');
});

test('dsh discovery finds one nvm installation and requires a selection when multiple installations are present', { skip: !supported }, async t => {
  const root = await temporary(t), versions = join(root, '.nvm/versions/node');
  const first = await npmInstallation(join(versions, 'v22.1.0'));
  const options = { homeDirectory: root, environment: { PATH: '' } };
  const found = await discoverDshInstallation(options);
  assert.equal(found.status, 'installed'); assert.equal(found.executable, first.cli);
  assert.equal(found.home, join(root, '.dsh'));
  const second = await npmInstallation(join(versions, 'v22.2.0'));
  const ambiguous = await discoverDshInstallation(options);
  assert.equal(ambiguous.status, 'not_found'); assert.equal(ambiguous.executable, null);
  assert.equal(ambiguous.reason, 'dsh_installation_ambiguous');
  assert.deepEqual(new Set(ambiguous.candidates), new Set([first.path, second.path]));
  const chosen = await discoverDshInstallation({ ...options, environment: { PATH: join(versions, 'v22.1.0/bin') } });
  assert.equal(chosen.status, 'installed'); assert.equal(chosen.executable, first.cli);
});

test('dsh discovery preserves disablement and rejects unsupported device platforms before probing', async t => {
  const root = await temporary(t), options = { homeDirectory: root, environment: { PATH: '' }, override: { executable: '/missing/dsh', disabled: true } };
  const disabled = await discoverDshInstallation(options);
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.version, null); assert.deepEqual(disabled.candidates, []);
  if (!supported) {
    const found = await discoverDshInstallation({ ...options, override: { executable: '/missing/dsh' } });
    assert.equal(found.status, 'not_found'); assert.equal(found.reason, 'dsh_unsupported_platform');
  }
  const controller = new AbortController(); controller.abort(new Error('synthetic_abort'));
  await assert.rejects(discoverDshInstallation({ ...options, signal: controller.signal }), /synthetic_abort/);
});
