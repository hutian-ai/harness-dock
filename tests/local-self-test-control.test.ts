import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { initializeDevice, readConfig, type DeviceConfig } from '../apps/daemon/src/config.ts';
import { control, serveControl, type LocalStatus } from '../apps/daemon/src/local-control.ts';
import type { SelfTestSnapshot } from '../apps/daemon/src/device-self-test.ts';

async function fixture(t: TestContext, start?: (id: string, status: LocalStatus) => SelfTestSnapshot,
  lookup?: (id: string, status: LocalStatus) => { id: string; found: boolean }) {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/local-self-test-'));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'ws://127.0.0.1:1/' });
  const config = await readConfig(paths.configPath);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const status: LocalStatus = { nodeId: config.nodeId, daemonId: randomUUID(), pid: process.pid,
    connected: true, endpoint: config.endpoint, activeRunIds: [], unresolvedRunIds: [] };
  let shutdowns = 0, closed = false;
  const closeServer = await serveControl(config, () => status, async () => { shutdowns++; }, undefined,
    start ? id => start(id, status) : undefined, lookup ? id => lookup(id, status) : undefined);
  const close = async () => { if (!closed) { closed = true; await closeServer(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  return { config, status, close, shutdowns: () => shutdowns };
}

function snapshot(id: string, daemonId: string, state: SelfTestSnapshot['state'] = 'running'): SelfTestSnapshot {
  return { id, runId: id, daemonId, state, phase: state === 'running' ? 'executing' : 'finished', startedAt: Date.now() };
}

async function raw(config: DeviceConfig, daemonId: string, body: string,
  headers: Record<string, string | undefined> = {}, method = 'POST', path = method === 'GET' ? '/status' : '/self-test') {
  const key = createHash('sha256').update(`${resolve(config.stateDir)}:${daemonId}`).digest('hex').slice(0, 32);
  const socketPath = join(tmpdir(), `hd-${process.getuid?.() ?? 'user'}`, `${key}.sock`);
  const values: Record<string, string | number | undefined> = { authorization: `Bearer ${config.token}`,
    'x-dock-daemon': daemonId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers };
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: values }, res => {
      let response = '';
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: response }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

test('local self-test starts promptly and status polling observes the same daemon-owned run without redispatch', { timeout: 5000 }, async t => {
  let starts = 0;
  const context = await fixture(t, (id, status) => {
    if (status.selfTest?.id === id) return status.selfTest;
    starts++;
    return status.selfTest = snapshot(id, status.daemonId);
  });
  const id = randomUUID();
  const started = await control(context.config, 'self-test', { id });
  assert.equal(started?.selfTest?.state, 'running');
  assert.equal(started?.selfTest?.id, id);
  assert.equal(starts, 1, 'the start request must return without awaiting model completion');
  for (let index = 0; index < 3; index++) assert.equal((await control(context.config, 'status'))?.selfTest?.id, id);
  assert.equal(starts, 1, 'polling must never initiate another run');
  assert.deepEqual((await control(context.config, 'self-test', { id }))?.selfTest, started?.selfTest);
  assert.equal(starts, 1, 'an idempotent owning handler is not replaced or bypassed');
  context.status.selfTest = { ...context.status.selfTest!, state: 'passed', phase: 'finished', finishedAt: Date.now() };
  assert.equal((await control(context.config, 'status'))?.selfTest?.state, 'passed');
  assert.equal(context.shutdowns(), 0);
});

test('local self-test rejects wrong credentials, old boot identities, browser origins and arbitrary prompt bodies', async t => {
  let starts = 0;
  const context = await fixture(t, (id, status) => { starts++; return snapshot(id, status.daemonId); });
  const valid = JSON.stringify({ id: randomUUID() });
  for (const headers of [{ authorization: 'Bearer synthetic-wrong-credential' }, { 'x-dock-daemon': randomUUID() },
    { origin: 'https://example.com' }, { origin: '' }]) {
    assert.equal((await raw(context.config, context.status.daemonId, valid, headers)).status, 403);
  }
  for (const body of ['', 'null', '[]', '{}', JSON.stringify({ id: 'not-a-uuid' }),
    JSON.stringify({ id: randomUUID(), prompt: 'arbitrary external execution must never be accepted' })]) {
    assert.equal((await raw(context.config, context.status.daemonId, body)).status, 400);
  }
  assert.equal((await raw(context.config, context.status.daemonId, valid, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await raw(context.config, context.status.daemonId, 'x'.repeat(257))).status, 413);
  await assert.rejects(control(context.config, 'self-test'), /invalid_self_test_request/);
  await assert.rejects(control(context.config, 'self-test', { id: randomUUID(), prompt: 'unaccepted' } as { id: string }), /invalid_self_test_request/);
  assert.equal(starts, 0);
  assert.equal((await control(context.config, 'status'))?.connected, true);
});

test('self-test refusal and failure are stable and never shut down the local owner', async t => {
  let reason = 'device_busy';
  const context = await fixture(t, () => { throw new Error(reason); });
  for (const code of ['device_busy', 'unresolved_execution', 'device_stopping', 'self_test_id_conflict']) {
    reason = code;
    await assert.rejects(control(context.config, 'self-test', { id: randomUUID() }), new RegExp(`local_control_rejected:409:${code}`));
  }
  reason = 'self_test_storage_unavailable';
  await assert.rejects(control(context.config, 'self-test', { id: randomUUID() }), /local_control_rejected:500:self_test_storage_unavailable/);
  reason = 'private native result and synthetic-secret must never leave local logs';
  const result = await raw(context.config, context.status.daemonId, JSON.stringify({ id: randomUUID() }));
  assert.equal(result.status, 500); assert.deepEqual(JSON.parse(result.body), { error: 'self_test_failed' });
  assert.equal((await control(context.config, 'status'))?.connected, true); assert.equal(context.shutdowns(), 0);
  const unsupported = await fixture(t);
  await assert.rejects(control(unsupported.config, 'self-test', { id: randomUUID() }), /local_control_rejected:409:self_test_unsupported/);
  assert.equal((await control(unsupported.config, 'status'))?.connected, true);
});

test('lost self-test result is observed after a daemon restart, never replayed by a status request', async t => {
  let starts = 0;
  const context = await fixture(t, (id, status) => { starts++; return status.selfTest = snapshot(id, status.daemonId); });
  const id = randomUUID(); await control(context.config, 'self-test', { id });
  const originalBoot = context.status.daemonId, interrupted = { ...context.status.selfTest!, state: 'unknown' as const,
    phase: 'finished' as const, code: 'self_test_interrupted' };
  await context.close();
  const current: LocalStatus = { ...context.status, daemonId: randomUUID(), selfTest: interrupted };
  const close = await serveControl(context.config, () => current, async () => {}, undefined, () => interrupted);
  t.after(close);
  const observed = await control(context.config, 'status');
  assert.equal(observed?.daemonId, current.daemonId); assert.equal(observed?.selfTest?.state, 'unknown');
  assert.equal(observed?.selfTest?.daemonId, originalBoot, 'original test identity remains evidence rather than a new dispatch');
  assert.equal((await control(context.config, 'self-test', { id }))?.selfTest?.state, 'unknown');
  assert.equal(starts, 1);
  assert.equal((await raw(context.config, current.daemonId, JSON.stringify({ id }), { 'x-dock-daemon': originalBoot })).status, 403);
});

test('self-test client fences a mismatched result ID without retrying the mutation', async t => {
  let starts = 0;
  const context = await fixture(t, (_id, status) => { starts++; return snapshot(randomUUID(), status.daemonId); });
  await assert.rejects(control(context.config, 'self-test', { id: randomUUID() }), /local_control_self_test_mismatch/);
  assert.equal(starts, 1);
});

test('receipt lookup resolves an unacknowledged start without ever initiating model work', async t => {
  let starts = 0, lookups = 0;
  const receipts = new Set<string>();
  const context = await fixture(t, (id, status) => { starts++; receipts.add(id); return snapshot(id, status.daemonId); },
    id => { lookups++; return { id, found: receipts.has(id) }; });
  const notReceived = randomUUID();
  assert.deepEqual((await control(context.config, 'self-test-status', { id: notReceived }))?.selfTestReceipt, { id: notReceived, found: false });
  assert.equal(starts, 0);
  const received = randomUUID(); await control(context.config, 'self-test', { id: received });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.deepEqual((await control(context.config, 'self-test-status', { id: received }))?.selfTestReceipt, { id: received, found: true });
  }
  assert.equal(starts, 1); assert.equal(lookups, 4);
});

test('a disconnected start response is recovered by receipt lookup without resending the start', async t => {
  let accepted!: () => void, starts = 0, receivedResponse = false;
  const dispatched = new Promise<void>(done => { accepted = done; }), receipts = new Set<string>();
  const context = await fixture(t, (id, status) => {
    starts++; receipts.add(id); accepted(); return snapshot(id, status.daemonId);
  }, id => ({ id, found: receipts.has(id) }));
  const id = randomUUID(), body = JSON.stringify({ id });
  const key = createHash('sha256').update(`${resolve(context.config.stateDir)}:${context.status.daemonId}`).digest('hex').slice(0, 32);
  const client = request({ socketPath: join(tmpdir(), `hd-${process.getuid?.() ?? 'user'}`, `${key}.sock`), path: '/self-test', method: 'POST',
    headers: { authorization: `Bearer ${context.config.token}`, 'x-dock-daemon': context.status.daemonId,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
  client.on('error', () => {}); client.on('response', () => { receivedResponse = true; });
  const closed = new Promise<void>(done => { client.once('close', done); });
  client.end(body); await dispatched; client.destroy(new Error('synthetic response lost after acceptance')); await closed;
  assert.equal(receivedResponse, false);
  assert.deepEqual((await control(context.config, 'self-test-status', { id }))?.selfTestReceipt, { id, found: true });
  assert.equal(starts, 1);
});

test('receipt lookup uses the same authentication and strict bounded request contract', async t => {
  let lookups = 0;
  const context = await fixture(t, undefined, id => { lookups++; return { id, found: false }; });
  const body = JSON.stringify({ id: randomUUID() }), path = '/self-test-status';
  assert.equal((await raw(context.config, context.status.daemonId, body, { origin: '' }, 'POST', path)).status, 403);
  assert.equal((await raw(context.config, context.status.daemonId, body, { authorization: 'Bearer wrong' }, 'POST', path)).status, 403);
  assert.equal((await raw(context.config, context.status.daemonId, JSON.stringify({ id: randomUUID(), prompt: 'never accepted' }), {}, 'POST', path)).status, 400);
  assert.equal((await raw(context.config, context.status.daemonId, 'x'.repeat(257), {}, 'POST', path)).status, 413);
  await assert.rejects(control(context.config, 'self-test-status'), /invalid_self_test_request/);
  assert.equal(lookups, 0);
  const unsupported = await fixture(t);
  await assert.rejects(control(unsupported.config, 'self-test-status', { id: randomUUID() }), /local_control_rejected:409:self_test_unsupported/);
});

test('receipt lookup does not turn an unmatched or invalid receipt into authoritative absence', async t => {
  const context = await fixture(t, undefined, () => ({ id: randomUUID(), found: false }));
  await assert.rejects(control(context.config, 'self-test-status', { id: randomUUID() }), /local_control_self_test_receipt_mismatch/);
  const invalid = await fixture(t, undefined, id => ({ id, found: 'no' } as unknown as { id: string; found: boolean }));
  await assert.rejects(control(invalid.config, 'self-test-status', { id: randomUUID() }), /local_control_self_test_receipt_mismatch/);
});
