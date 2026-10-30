import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { launchAgent } from '../apps/daemon/src/autostart.ts';
import { initializeDevice } from '../apps/daemon/src/config.ts';
import { panelExternalInstallation } from '../apps/daemon/src/panel-discovery.ts';
import { panelError, panelStatus, runPanelOperation } from '../apps/daemon/src/panel-management.ts';

async function fixture() {
  await mkdir('.local', { recursive: true });
  const home = await mkdtemp(resolve('.local/panel-external-'));
  const device = await initializeDevice({ home: join(home, 'device'), cwd: home, endpoint: 'wss://dock.example.com/' });
  return { home, config: device.configPath, expected: join(dirname(device.configPath), 'installation') };
}

async function registration(home: string, root: string, config: string) {
  await mkdir(root, { recursive: true });
  const plan = launchAgent(root, config, process.execPath, '/usr/bin:/bin', home);
  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, plan.content, { mode: 0o600 });
  return plan;
}

test('offline custom installation remains visible and cannot be replaced by panel install', { skip: process.platform !== 'darwin' }, async t => {
  const { home, config, expected } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const plan = await registration(home, join(home, 'custom-installation'), config);
  const originalConfig = await readFile(config), originalAgent = await readFile(plan.path);
  const state = await panelStatus(config, home);
  assert.equal(state.running, false);
  assert.equal(state.managed, false);
  assert.equal(state.externalInstallation, true);
  // The missing bundle proves rejection happens before release verification or any owner mutation.
  await assert.rejects(runPanelOperation({ operation: 'install', config }, join(home, 'missing-bundle'), home), /installation_config_mismatch/);
  await assert.rejects(runPanelOperation({ operation: 'setup', config, pairing: join(home, 'missing-pairing.json'), cwd: home }, join(home, 'missing-bundle'), home), /installation_config_mismatch/);
  await assert.rejects(stat(expected), { code: 'ENOENT' });
  assert.deepEqual(await readFile(config), originalConfig);
  assert.deepEqual(await readFile(plan.path), originalAgent);
});

test('registration matching resolves config symlinks and leaves unrelated and own-root registrations alone', { skip: process.platform !== 'darwin' }, async t => {
  const { home, config, expected } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  await registration(home, expected, config);
  const unrelated = await initializeDevice({ home: join(home, 'other-device'), cwd: home, endpoint: 'wss://dock.example.com/' });
  await registration(home, join(home, 'other-installation'), unrelated.configPath);
  assert.deepEqual(await panelExternalInstallation(config, expected, home), { external: false, incomplete: false });
  const alias = join(home, 'config-alias.json');
  await symlink(config, alias);
  await registration(home, join(home, 'custom-installation'), alias);
  assert.equal((await panelExternalInstallation(config, expected, home)).external, true);
});

test('unsafe or truncated own registration inspections refuse migration before touching device state', { skip: process.platform !== 'darwin' }, async t => {
  const { home, config, expected } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = join(home, 'Library/LaunchAgents');
  await mkdir(agents, { recursive: true });
  const unsafe = join(agents, 'org.harness-dock.device.0000000000000000.plist');
  await symlink(config, unsafe);
  assert.deepEqual(await panelExternalInstallation(config, expected, home), { external: false, incomplete: true });
  await assert.rejects(runPanelOperation({ operation: 'install', config }, join(home, 'missing-bundle'), home), /installation_inspection_unavailable/);
  await rm(unsafe);
  const plan = await registration(home, expected, config);
  await rm(plan.path);
  for (let index = 0; index < 17; index++) {
    await writeFile(join(agents, `org.harness-dock.device.${index.toString(16).padStart(16, '0')}.plist`), plan.content, { mode: 0o600 });
  }
  assert.deepEqual(await panelExternalInstallation(config, expected, home), { external: false, incomplete: true });
  await assert.rejects(runPanelOperation({ operation: 'install', config }, join(home, 'missing-bundle'), home), /installation_inspection_unavailable/);
  assert.equal(panelError(new Error('installation_inspection_unavailable')), 'installation_inspection_unavailable');
});
