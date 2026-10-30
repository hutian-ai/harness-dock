import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { DeviceSelfTest, type SelfTestOutcome, type SelfTestSnapshot } from '../apps/daemon/src/device-self-test.ts';

async function directory() {
  await mkdir('.local', { recursive: true });
  return mkdtemp(resolve('.local/self-test-job-'));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('self-test receipt is durable before dispatch and duplicate/lost receipts never redispatch', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = deferred<SelfTestOutcome>(), entered = deferred<void>(), daemon = randomUUID(), id = randomUUID();
  let calls = 0;
  const job = new DeviceSelfTest(root, daemon, async (runId, progress) => {
    calls++;
    const saved = JSON.parse(await readFile(join(root, 'self-test.json'), 'utf8')) as SelfTestSnapshot;
    assert.equal(saved.state, 'running'); assert.equal(saved.id, runId); assert.equal(saved.runId, id);
    progress('executing', 'synthetic-model');
    entered.resolve();
    return outcome.promise;
  });
  const started = job.start(id);
  assert.equal(calls, 0); assert.equal(job.running, true);
  assert.deepEqual(job.start(id), started);
  assert.throws(() => job.start(randomUUID()), /device_busy/);
  assert.equal((await stat(join(root, 'self-test.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await entered.promise;
  assert.equal(calls, 1); assert.equal(job.status?.phase, 'executing');
  const copy = job.status!; copy.state = 'passed';
  assert.equal(job.status?.state, 'running');
  outcome.resolve({ state: 'passed', model: 'synthetic-model' });
  await nextTurn();
  assert.equal(job.running, false); assert.equal(job.status?.state, 'passed'); assert.equal(job.status?.phase, 'finished');
  assert.deepEqual(job.start(id), job.status); assert.equal(calls, 1);
  let restartedCalls = 0;
  const restarted = new DeviceSelfTest(root, randomUUID(), async () => { restartedCalls++; return { state: 'passed' }; });
  assert.equal(restarted.status?.daemonId, daemon);
  assert.equal(restarted.start(id).state, 'passed');
  await nextTurn(); assert.equal(restartedCalls, 0);
});

test('restart turns an interrupted stored job into unknown without creating native work', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), daemonId = randomUUID();
  await writeFile(join(root, 'self-test.json'), JSON.stringify({ id, runId: id, daemonId, state: 'running', phase: 'executing', startedAt: 1 }), { mode: 0o600 });
  let calls = 0;
  const job = new DeviceSelfTest(root, randomUUID(), async () => { calls++; return { state: 'passed' }; });
  assert.equal(job.running, false); assert.equal(job.status?.state, 'unknown');
  assert.equal(job.status?.code, 'self_test_interrupted'); assert.equal(job.status?.daemonId, daemonId);
  assert.deepEqual(job.start(id), job.status);
  await nextTurn(); assert.equal(calls, 0);
  const saved = JSON.parse(await readFile(join(root, 'self-test.json'), 'utf8'));
  assert.equal(saved.state, 'unknown'); assert.equal(saved.phase, 'finished');
});

test('native run rejection is unconfirmed with a stable code and no raw exception persistence', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const job = new DeviceSelfTest(root, randomUUID(), async () => { throw new Error('private native payload must never be persisted'); });
  job.start(randomUUID()); await nextTurn();
  assert.equal(job.running, false); assert.equal(job.status?.state, 'unknown');
  assert.equal(job.status?.code, 'self_test_unconfirmed');
  assert.ok(!(await readFile(join(root, 'self-test.json'), 'utf8')).includes('private native'));
});

test('unsafe, oversized and malformed stored receipts refuse new starts before native dispatch', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const run = async (): Promise<SelfTestOutcome> => { calls++; return { state: 'passed' }; };
  const cases = ['symlink', 'broad_permissions', 'oversized', 'invalid_uuid', 'unknown_field', 'invalid_phase', 'inconsistent_time'];
  for (const kind of cases) {
    const dir = join(root, kind); await mkdir(dir, { mode: 0o700 });
    const path = join(dir, 'self-test.json'), id = randomUUID();
    const valid = { id, runId: id, daemonId: randomUUID(), state: 'passed', phase: 'finished', startedAt: 1, finishedAt: 2 };
    if (kind === 'symlink') { const target = join(root, 'outside.json'); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, path); }
    else {
      const value = kind === 'oversized' ? ' '.repeat(4097) : JSON.stringify({ ...valid,
        ...(kind === 'invalid_uuid' ? { id: 'invalid-id' } : {}),
        ...(kind === 'unknown_field' ? { private: 'must not enter an exception' } : {}),
        ...(kind === 'invalid_phase' ? { phase: 'invented' } : {}),
        ...(kind === 'inconsistent_time' ? { finishedAt: 0 } : {}),
      });
      await writeFile(path, value, { mode: 0o600 });
      if (kind === 'broad_permissions') await chmod(path, 0o644);
    }
    const job = new DeviceSelfTest(dir, randomUUID(), run);
    assert.throws(() => job.start(randomUUID()), { message: 'self_test_storage_unavailable' }, kind);
  }
  await nextTurn(); assert.equal(calls, 0);
});

test('failed initial persistence keeps the previous validated receipt and never dispatches new work', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const job = new DeviceSelfTest(root, randomUUID(), async () => { calls++; return { state: 'failed', code: 'self_test_answer_mismatch' }; });
  job.start(randomUUID()); await nextTurn();
  const original = job.status;
  await rm(join(root, 'self-test.json')); await mkdir(join(root, 'self-test.json'));
  assert.throws(() => job.start(randomUUID()), { message: 'self_test_storage_unavailable' });
  assert.equal(job.running, false); assert.deepEqual(job.status, original);
  await nextTurn(); assert.equal(calls, 1);
});

test('progress persistence failure stays unknown while holding the lease until actual completion', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = deferred<SelfTestOutcome>();
  let progress!: (phase: 'checking' | 'executing', model?: string) => void;
  const job = new DeviceSelfTest(root, randomUUID(), async (_id, report) => { progress = report; return outcome.promise; });
  const id = randomUUID(); job.start(id); await nextTurn();
  await rm(join(root, 'self-test.json')); await mkdir(join(root, 'self-test.json'));
  progress('executing', 'synthetic-model');
  assert.equal(job.status?.state, 'unknown'); assert.equal(job.status?.code, 'self_test_storage_unavailable');
  assert.equal(job.running, true); assert.equal(job.start(id).state, 'unknown');
  assert.throws(() => job.start(randomUUID()), /device_busy/);
  outcome.resolve({ state: 'passed' }); await nextTurn();
  assert.equal(job.running, false); assert.equal(job.status?.state, 'unknown');
  assert.equal(job.status?.code, 'self_test_storage_unavailable');
  assert.throws(() => job.start(randomUUID()), /self_test_storage_unavailable/);
});

test('outcome persistence failure cannot publish passed and preserves an original failure code', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const state of ['passed', 'failed'] as const) {
    const dir = join(root, state); await mkdir(dir, { mode: 0o700 });
    const outcome = deferred<SelfTestOutcome>();
    const job = new DeviceSelfTest(dir, randomUUID(), async () => outcome.promise);
    job.start(randomUUID()); await nextTurn();
    await rm(join(dir, 'self-test.json')); await mkdir(join(dir, 'self-test.json'));
    outcome.resolve(state === 'passed' ? { state } : { state, code: 'self_test_answer_mismatch' });
    await nextTurn();
    assert.equal(job.running, false); assert.equal(job.status?.state, 'unknown');
    assert.equal(job.status?.code, state === 'passed' ? 'self_test_storage_unavailable' : 'self_test_answer_mismatch');
  }
});
