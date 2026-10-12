import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../apps/daemon/src/config.ts';
import { control } from '../apps/daemon/src/local-control.ts';

const exec = promisify(execFile);
test('local CLI preserves node identity, authenticates stop and ignores stale PID metadata', async (t) => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/cli-'));
  const home = join(root, 'node'), cwd = join(root, 'work'), auth = join(root, 'synthetic-auth.json');
  await mkdir(cwd);
  await writeFile(auth, '{"synthetic":true}', { mode: 0o600 });
  const cli = async (...args: string[]) => (await exec(process.execPath,
    [resolve('apps/daemon/dist/cli.js'), ...args], { timeout: 15_000 })).stdout;
  const paths = JSON.parse(await cli('init', '--home', home, '--cwd', cwd, '--auth-from', auth,
    '--endpoint', 'ws://127.0.0.1:1/'));
  const config = await readConfig(paths.configPath);
  if ('mode' in config) throw new Error('Expected single-provider configuration');
  assert.notEqual(config.provider, 'zcode');
  if (config.provider === 'zcode') throw new Error('Expected Codex configuration');
  t.after(async () => { await control(config, 'stop'); await rm(root, { recursive: true, force: true }); });
  const original = await readFile(paths.configPath, 'utf8');
  await assert.rejects(cli('init', '--home', home, '--cwd', cwd, '--auth-from', auth), /EEXIST/);
  assert.equal(await readFile(paths.configPath, 'utf8'), original);
  assert.equal((await stat(join(config.codexHome, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  const first = JSON.parse(await cli('start', paths.configPath));
  assert.equal(first.connected, false);
  const duplicate = JSON.parse(await cli('start', paths.configPath));
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.daemonId, first.daemonId);
  await assert.rejects(cli('run', paths.configPath), /locked/);
  const wrong = join(root, 'wrong.json');
  await writeFile(wrong, JSON.stringify({ ...config, token: 'wrong'.repeat(10) }));
  await assert.rejects(cli('stop', wrong), /local_control_rejected:403/);
  assert.equal((await control(config, 'status'))?.daemonId, first.daemonId);
  // A stale/recycled PID must never become a signal target. The test process stays alive.
  await writeFile(join(config.stateDir, 'control.json'), JSON.stringify({ ...first, pid: process.pid }));
  assert.equal((await control(config, 'status'))?.pid, first.pid);
  assert.match(await cli('logs', paths.configPath), /Daemon .* connecting/);
  await rm(cwd, { recursive: true }); // Lost work files must not prevent managing/stopping the owner.
  assert.equal(JSON.parse(await cli('stop', paths.configPath)).stopped, true);
  for (let i = 0; i < 20 && await control(config, 'status'); i++) await delay(50);
  assert.equal(await control(config, 'status'), null);
  await mkdir(cwd);
  const restarted = JSON.parse(await cli('start', paths.configPath));
  assert.notEqual(restarted.daemonId, first.daemonId);
  assert.equal(restarted.nodeId, first.nodeId);
  assert.equal(JSON.parse(await cli('stop', paths.configPath)).stopped, true);
  const zcode = JSON.parse(await cli('init', '--provider', 'zcode', '--home', join(root, 'zcode-node'),
    '--cwd', cwd, '--zcode-home', home, '--zcode-bin', process.execPath));
  const zcodeConfig = await readConfig(zcode.configPath);
  if ('mode' in zcodeConfig) throw new Error('Expected single-provider configuration');
  assert.equal(zcodeConfig.provider, 'zcode');
  assert.ok(!('codexHome' in zcodeConfig));
  if (zcodeConfig.provider === 'zcode') assert.equal(zcodeConfig.zcodeBin, process.execPath);
  const { initializeServer } = await import('../apps/server/src/setup.ts');
  const serverFiles = await initializeServer({ home: join(root, 'server') });
  const serverPairing = JSON.parse(await readFile(serverFiles.devicePairingPath, 'utf8'));
  const device = JSON.parse(await cli('init', '--mode', 'device', '--home', join(root, 'device-node'), '--cwd', cwd, '--pairing', serverFiles.devicePairingPath));
  const deviceConfig = await readConfig(device.configPath);
  assert.ok('mode' in deviceConfig && deviceConfig.mode === 'device');
  assert.equal(deviceConfig.endpoint, 'ws://127.0.0.1:48518/');
  assert.equal(deviceConfig.nodeId, serverPairing.nodeId);
  assert.equal(deviceConfig.token, serverPairing.token);
  assert.ok(!('codexHome' in deviceConfig));
  const pairing = JSON.parse(await readFile(device.controllerPath, 'utf8'));
  assert.equal(pairing.nodes[0].nodeId, deviceConfig.nodeId);
  assert.equal(JSON.parse(await cli('start', device.configPath)).connected, false);
  assert.equal(JSON.parse(await cli('stop', device.configPath)).stopped, true);
});
