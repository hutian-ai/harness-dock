import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { DeviceSelfTest, type SelfTestOutcome, type SelfTestProvider, type SelfTestSnapshot } from '../apps/daemon/src/device-self-test.ts';

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
    assert.equal(saved.state, 'running'); assert.equal(saved.id, runId); assert.equal(saved.runId, id); assert.equal(saved.provider, 'codex');
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
  assert.equal(saved.provider, undefined, 'legacy Codex receipts retain their original shape');
});

test('dsh receipts remain separate from legacy Codex history and restart never dispatches either receipt', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const legacyId = randomUUID(), daemonId = randomUUID();
  const legacy = JSON.stringify({ id: legacyId, runId: legacyId, daemonId, state: 'passed', phase: 'finished', startedAt: 1, finishedAt: 2 });
  await writeFile(join(root, 'self-test.json'), legacy, { mode: 0o600 });
  const outcome = deferred<SelfTestOutcome>(), entered = deferred<void>();
  let calls = 0;
  const job = new DeviceSelfTest(root, daemonId, async (id, progress) => {
    calls++;
    const saved = JSON.parse(await readFile(join(root, 'self-test-dsh.json'), 'utf8')) as SelfTestSnapshot;
    assert.equal(saved.id, id); assert.equal(saved.provider, 'dsh'); assert.equal(saved.state, 'running');
    progress('executing', 'synthetic-dsh-model'); entered.resolve(); return outcome.promise;
  }, 'dsh');
  assert.throws(() => job.start(legacyId), { message: 'self_test_id_conflict' });
  const id = randomUUID(), started = job.start(id);
  assert.equal(started.provider, 'dsh'); assert.equal(calls, 0);
  assert.deepEqual(job.start(id), started);
  await entered.promise; assert.equal(calls, 1);
  outcome.resolve({ state: 'passed' }); await nextTurn();
  assert.equal(job.status?.state, 'passed');
  await writeFile(join(root, 'self-test-dsh.json'), JSON.stringify({ ...job.status, state: 'running', phase: 'executing', finishedAt: undefined }), { mode: 0o600 });
  let recoveredCalls = 0;
  const recovered = new DeviceSelfTest(root, randomUUID(), async () => { recoveredCalls++; return { state: 'passed' }; }, 'dsh');
  assert.equal(recovered.status?.provider, 'dsh'); assert.equal(recovered.status?.state, 'unknown');
  assert.equal(recovered.start(id).state, 'unknown');
  assert.equal(await readFile(join(root, 'self-test.json'), 'utf8'), legacy, 'dsh never rewrites the legacy Codex receipt');
  await nextTurn(); assert.equal(recoveredCalls, 0);
});

test('the same new self-test id cannot be admitted by both named providers', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = deferred<SelfTestOutcome>(), id = randomUUID(), daemonId = randomUUID();
  let dshCalls = 0;
  const codex = new DeviceSelfTest(root, daemonId, async () => outcome.promise);
  const dsh = new DeviceSelfTest(root, daemonId, async () => { dshCalls++; return { state: 'passed' }; }, 'dsh');
  codex.start(id);
  assert.throws(() => dsh.start(id), { message: 'self_test_id_conflict' });
  await nextTurn(); assert.equal(dshCalls, 0); assert.equal(dsh.status, undefined);
  await assert.rejects(readFile(join(root, 'self-test-dsh.json')), { code: 'ENOENT' });
  outcome.resolve({ state: 'passed' }); await nextTurn();
});

test('mislabelled provider storage fails closed before dispatch and never overwrites the receipt', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  for (const [index, provider, storedProvider] of [
    [0, 'codex', 'dsh'], [1, 'codex', null], [2, 'dsh', 'codex'], [3, 'dsh', undefined], [4, 'dsh', 'other'],
  ] as const) {
    const dir = join(root, String(index)); await mkdir(dir, { mode: 0o700 });
    const id = randomUUID(), path = join(dir, provider === 'codex' ? 'self-test.json' : 'self-test-dsh.json');
    const stored = JSON.stringify({ id, runId: id, daemonId: randomUUID(), provider: storedProvider, state: 'passed', phase: 'finished', startedAt: 1, finishedAt: 2 });
    await writeFile(path, stored, { mode: 0o600 });
    const job = new DeviceSelfTest(dir, randomUUID(), async () => { calls++; return { state: 'passed' }; }, provider);
    assert.equal(job.status, undefined);
    assert.throws(() => job.start(id), { message: 'self_test_storage_unavailable' });
    assert.equal(await readFile(path, 'utf8'), stored);
  }
  const changedDir = join(root, 'changed-after-open'); await mkdir(changedDir, { mode: 0o700 });
  const opened = new DeviceSelfTest(changedDir, randomUUID(), async () => { calls++; return { state: 'passed' }; }, 'dsh');
  const changedId = randomUUID(), changedPath = join(changedDir, 'self-test-dsh.json');
  const changed = JSON.stringify({ id: changedId, runId: changedId, daemonId: randomUUID(), provider: 'codex', state: 'passed', phase: 'finished', startedAt: 1, finishedAt: 2 });
  await writeFile(changedPath, changed, { mode: 0o600 });
  assert.throws(() => opened.start(randomUUID()), { message: 'self_test_storage_unavailable' });
  assert.equal(await readFile(changedPath, 'utf8'), changed);
  await nextTurn(); assert.equal(calls, 0);
  assert.throws(() => new DeviceSelfTest(root, randomUUID(), async () => ({ state: 'passed' }), 'other' as SelfTestProvider), /invalid_self_test_provider/);
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
