import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import type { DshHostInput } from '../packages/drivers/src/dsh.ts';
import type { SelfTestSnapshot } from '../apps/daemon/src/device-self-test.ts';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
const marker = (input: { prompt: string }) => /DOCK_SELF_TEST_[a-f0-9]{24}/u.exec(input.prompt)?.[0] ?? '';
async function finished(host: DeviceHost, id: string): Promise<SelfTestSnapshot> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = host.selfTestStatuses.find(test => test.id === id);
    if (value?.phase === 'finished' && value.state !== 'running') { await delay(0); return value; }
    await delay(10);
  }
  throw new Error('synthetic_dsh_self_test_timeout');
}
async function fixture(t: TestContext, behavior?: (input: DshHostInput) => Promise<void>, stopReason = 'end_turn') {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/panel-dsh-self-test-'));
  const codex = join(root, 'codex'), dsh = join(root, 'dsh');
  await writeFile(codex, '#!/bin/sh\necho "codex-cli 0.1.0"\n', { mode: 0o700 });
  await writeFile(dsh, '#!/bin/sh\necho "0.1.2-rc.1"\n', { mode: 0o700 });
  const inputs: DshHostInput[] = [], callbacks: unknown[] = [];
  const host = new DeviceHost({ mode: 'device', nodeId: randomUUID(), token: 'synthetic'.repeat(5), endpoint: 'ws://127.0.0.1:1/',
    cwd: root, stateDir: join(root, 'state'), providers: { codex: { executable: codex, home: root }, dsh: { executable: dsh, home: root } },
  }, createProviderAdapters(() => ({
    inspect: async () => ({ models: [{ id: 'codex-model', efforts: ['low'], serviceTiers: [] }],
      permissionModes: [{ value: 'read-only', name: 'Read-only' }], config: { sandbox: 'read-only', approvalPolicy: 'on-request', nativeMemoryDisabled: false } }),
    execute: async input => { await input.onReady(`codex:${input.runId}`); return { runId: input.runId, fingerprint: 'synthetic', state: 'completed',
      threadId: `codex:${input.runId}`, turnId: input.runId, messages: [{ id: input.runId, phase: 'final_answer', text: marker(input) }] }; },
    reconcile: async () => null, close: async () => {},
  }), () => ({
    inspect: async () => ({ models: [{ id: '["synthetic","dsh"]', efforts: ['low'] }], currentModelId: '["synthetic","dsh"]', configOptions: [], sessionResume: true, mcpCapabilities: { http: true } }),
    execute: async input => { inputs.push(input); await input.onReady(`dsh:${input.runId}`); await behavior?.(input);
      return { runId: input.runId, state: 'completed', sessionId: `dsh:${input.runId}`, stopReason, messages: [{ id: input.runId, text: marker(input) }] }; },
    close: async () => {},
  })));
  host.bind(async (_method, callback) => { callbacks.push(callback); return 'allow'; });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { host, inputs, callbacks };
}

test('panel keeps Codex and dsh self-test identities and histories separate', { skip: !supported }, async t => {
  const { host, inputs, callbacks } = await fixture(t);
  const codex = randomUUID(), dsh = randomUUID();
  host.startSelfTest(codex); assert.equal((await finished(host, codex)).state, 'passed');
  host.startSelfTest(dsh, 'dsh'); const done = await finished(host, dsh);
  assert.equal(done.state, 'passed'); assert.equal(done.provider, 'dsh');
  assert.equal(host.selfTestStatus?.id, codex, 'legacy Codex status must never become a dsh success');
  assert.equal(host.selfTestStatuses.length, 2);
  assert.throws(() => host.lookupSelfTest(codex, 'dsh'), /self_test_id_conflict/);
  assert.throws(() => host.lookupSelfTest(dsh, 'codex'), /self_test_id_conflict/);
  assert.deepEqual(host.lookupSelfTest(randomUUID(), 'dsh').found, false);
  assert.equal(host.startSelfTest(dsh, 'dsh').state, 'passed');
  assert.throws(() => host.startSelfTest(dsh, 'codex'), /self_test_id_conflict/);
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.retainSession, false); assert.equal(inputs[0]!.effort, 'low');
  assert.deepEqual(inputs[0]!.tools.definitions, []); assert.equal(callbacks.length, 0);
});

test('panel dsh echo requires normal native completion rather than text alone', { skip: !supported }, async t => {
  const { host } = await fixture(t, undefined, 'max_tokens');
  const id = randomUUID(); host.startSelfTest(id, 'dsh');
  const done = await finished(host, id);
  assert.equal(done.state, 'failed'); assert.equal(done.code, 'self_test_answer_mismatch');
});

test('panel dsh rejects unexpected tools and approvals without calling the application', { skip: !supported }, async t => {
  let answer: unknown;
  const { host, callbacks } = await fixture(t, async input => {
    answer = await input.permission!({ id: 'unexpected', title: 'Unexpected', details: {}, canAllow: true,
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] }, input.signal, Promise.resolve());
  });
  const id = randomUUID(); host.startSelfTest(id, 'dsh'); const done = await finished(host, id);
  assert.equal(answer, 'deny'); assert.equal(done.state, 'failed'); assert.equal(done.code, 'self_test_permission_requested');
  assert.equal(callbacks.length, 0);
});
