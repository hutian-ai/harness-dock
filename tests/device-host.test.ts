import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { managedStateBytes, forgetSessionDirectories } from '../apps/daemon/src/device-files.ts';
import { RotatingLog } from '../apps/daemon/src/rotating-log.ts';
import { DeviceStore } from '../apps/daemon/src/device-store.ts';

test('device preparation preserves identity and stable skills, and output publication rejects links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-device-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { mode: 'device' as const, nodeId: randomUUID(), token: 'x'.repeat(32), endpoint: 'ws://127.0.0.1:48518/', cwd: root, stateDir: join(root, 'state') };
  const host = new DeviceHost(config);
  t.after(() => host.close());
  const files = [{ path: 'skill/SKILL.md', contentBase64: Buffer.from('synthetic').toString('base64') }];
  const first = await host.prepare({ runId: 'run:one', sessionKey: 'session', files });
  assert.deepEqual(await host.prepare({ runId: 'run:one', sessionKey: 'session', files }), first);
  assert.equal(first.workdir, root);
  assert.equal(await readFile(join(first.skillDirectory, 'skill/SKILL.md'), 'utf8'), 'synthetic');
  await assert.rejects(host.prepare({ runId: 'run:one', files: [] }), /identity_conflict/);
  await assert.rejects(host.prepare({ runId: 'unsafe', files: [{ path: '../escape', contentBase64: '' }] }), /unsafe_file_path/);
  await host.release('run:one');
  const second = await host.prepare({ runId: 'run:two', sessionKey: 'session', files });
  assert.equal(second.skillDirectory, first.skillDirectory);
  assert.notEqual(second.outputDirectory, first.outputDirectory);
  await writeFile(join(second.outputDirectory, 'safe.txt'), 'public');
  assert.equal((await host.collect('run:two'))[0]?.contentBase64, Buffer.from('public').toString('base64'));
  const outside = join(root, 'secret'); await writeFile(outside, 'private');
  await symlink(outside, join(second.outputDirectory, 'link'));
  await assert.rejects(host.collect('run:two'), /unsafe_output_path/);
  await rm(join(second.outputDirectory, 'link'));
  await link(outside, join(second.outputDirectory, 'hardlink'));
  await assert.rejects(host.collect('run:two'), /unsafe_output_path/);
  await rm(join(second.outputDirectory, 'hardlink'));
  const outsidePrepared = join(root, 'outside-prepared');
  const runName = basename(dirname(second.outputDirectory));
  const outsideRun = join(outsidePrepared, runName);
  const secret = join(outsideRun, 'output', 'secret.txt');
  await mkdir(dirname(secret), { recursive: true });
  await writeFile(secret, 'must not be published or deleted');
  for (const [ancestor, destination] of [
    [join(config.stateDir, 'prepared'), outsidePrepared],
    [dirname(second.outputDirectory), outsideRun],
  ]) {
    const backup = `${ancestor}.saved`;
    await rename(ancestor!, backup);
    await symlink(destination!, ancestor!);
    try {
      await assert.rejects(host.collect('run:two'), /unsafe_managed_directory/);
      await assert.rejects(host.release('run:two'), /unsafe_managed_directory/);
      assert.equal(await readFile(secret, 'utf8'), 'must not be published or deleted');
    } finally {
      await rm(ancestor!);
      await rename(backup, ancestor!);
    }
  }
  assert.equal((await host.collect('run:two'))[0]?.contentBase64, Buffer.from('public').toString('base64'));
  await writeFile(join(second.skillDirectory, 'skill/SKILL.md'), 'tampered');
  await assert.rejects(host.prepare({ runId: 'run:two', sessionKey: 'session', files }), /skill_cache_mismatch/);
  await assert.rejects(host.prepare({ runId: 'run:three', sessionKey: 'session', files }), /skill_cache_mismatch/);
  await host.release('run:two');
  assert.equal(await readFile(secret, 'utf8'), 'must not be published or deleted');
});

test('device admission is durable and restart leaves interrupted executions unknown without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-device-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeId = randomUUID();
  const first = new DeviceStore(nodeId, root);
  first.admit({ runId: 'run', provider: 'codex', input: 'fingerprint', state: 'running' });
  first.observe('run', 'event', { type: 'text_delta', text: 'synthetic' });
  assert.throws(() => new DeviceStore(nodeId, root), /locked/);
  assert.throws(() => first.admit({ runId: 'run', provider: 'codex', input: 'other', state: 'running' }), /UNIQUE/);
  first.close();
  const second = new DeviceStore(nodeId, root);
  assert.equal(second.get('run')?.state, 'unknown');
  assert.deepEqual(second.unresolved(), ['run']);
  assert.equal(second.get('run')?.input, 'fingerprint');
  assert.deepEqual(second.events('run', 0)[0]?.payload, { type: 'text_delta', text: 'synthetic' });
  assert.deepEqual(second.events('other', 0), []);
  second.close();
  assert.throws(() => new DeviceStore(randomUUID(), root), /state_node_mismatch/);
});


test('ACP probes preserve base environment and exclude inherited control secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-device-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'observations.jsonl'), executable = join(root, 'provider');
  await writeFile(executable, String.raw`#!${process.execPath}
const {appendFileSync} = require('node:fs');
appendFileSync(${JSON.stringify(output)}, JSON.stringify({
  secret: process.env.DEVICE_TEST_CONTROL_SECRET,
  path: process.env.PATH, home: process.env.HOME, providerHome: process.env.DSH_HOME
}) + '\n');
console.log('0.0.0');
`, { mode: 0o700 });
  const previous = process.env.DEVICE_TEST_CONTROL_SECRET;
  process.env.DEVICE_TEST_CONTROL_SECRET = 'synthetic-control-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.DEVICE_TEST_CONTROL_SECRET;
    else process.env.DEVICE_TEST_CONTROL_SECRET = previous;
  });
  const providerHome = join(root, 'provider-home');
  const host = new DeviceHost({ mode: 'device', nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:48518/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { disabled: true }, zcode: { disabled: true },
      lobi: { executable }, 'deepseek-harness': { executable, home: providerHome } } });
  t.after(() => host.close());
  await host.inventory();
  const observations = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(observations.length, 4); // Version and command checks for both ACP Providers.
  for (const observation of observations) {
    assert.equal(observation.secret, undefined);
    assert.equal(observation.path, process.env.PATH);
    assert.equal(observation.home, process.env.HOME);
  }
  assert.equal(observations.filter(item => item.providerHome === providerHome).length, 2);
});


test('history expiry keeps admission identities and unknown evidence; limits produce an explicit gap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-resource-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DeviceStore(randomUUID(), root, { historyRetentionMs: 10, maxRunEvents: 2, maxEventBytes: 512, maxPageBytes: 512, maxIdentities: 3 });
  t.after(() => store.close());
  const directories = { workdir: root, skillDirectory: root, outputDirectory: root };
  for (const runId of ['done', 'unknown', 'unreleased']) {
    store.prepare(runId, { input: runId, sessionKey: runId, directories });
    store.admit({ runId, provider: 'codex', input: runId, state: 'running' });
  }
  assert.throws(() => store.assertCapacity(), /node_storage_full/);
  store.assertCapacity('done');
  for (let index = 0; index < 5; index++) store.observe('done', 'event', { text: 'x'.repeat(300) });
  const page = store.events('done', 0);
  assert.equal(page.length, 1);
  const remainder = store.events('done', page[0]!.sequence);
  assert.equal(remainder.at(-1)?.kind, 'history_truncated');
  assert.equal(store.get('done')?.historyTruncated, true);
  store.save({ ...store.get('done')!, state: 'completed', result: { text: 'finished' } });
  store.markReleased('done');
  store.save({ ...store.get('unknown')!, state: 'unknown' });
  store.markReleased('unknown');
  store.save({ ...store.get('unreleased')!, state: 'failed' });
  assert.equal(store.expireDetails(Date.now() + 100), 1);
  assert.equal(store.get('done')?.input, 'done');
  assert.equal(store.get('done')?.detailsExpired, true);
  assert.equal(store.get('done')?.result, undefined);
  assert.throws(() => store.events('done', 0), /execution_details_expired/);
  assert.equal(store.get('unknown')?.detailsExpired, undefined);
  assert.equal(store.get('unreleased')?.detailsExpired, undefined);
  assert.throws(() => store.forgetSession('unknown'), /session_in_use/);
  assert.throws(() => store.forgetSession('unreleased'), /session_in_use/);
  assert.deepEqual(store.forgetSession('done').runIds, ['done']);
  assert.throws(() => store.assertSessionOpen('done'), /session_forgotten/);
  assert.throws(() => store.admit({ runId: 'done', input: 'new', provider: 'codex', state: 'running' }), /UNIQUE/);
});

test('managed cleanup avoids user directories and background logs rotate while running', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'); await mkdir(stateDir);
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'user file');
  await symlink(outside, join(stateDir, 'sessions'));
  assert.ok(await managedStateBytes(stateDir, 1024) < 1024);
  await assert.rejects(forgetSessionDirectories(stateDir, 'session'), /unsafe_managed_directory/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'user file');
  const log = new RotatingLog(stateDir, 128, 3);
  for (let index = 0; index < 10; index++) log.write(String(index).repeat(100));
  log.close();
  assert.equal((await readFile(join(stateDir, 'daemon.log'), 'utf8')), '9'.repeat(100));
  assert.equal((await readFile(join(stateDir, 'daemon.log.2'), 'utf8')), '7'.repeat(100));
  await assert.rejects(readFile(join(stateDir, 'daemon.log.3')), /ENOENT/);
});
