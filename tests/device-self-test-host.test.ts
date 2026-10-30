import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import type { DeviceConfig } from '../apps/daemon/src/config.ts';
import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import type { CodexEvidence, CodexHostInput, NativePermissionDecision } from '../packages/drivers/src/index.ts';
import type { SelfTestSnapshot } from '../apps/daemon/src/device-self-test.ts';

const turn = () => new Promise<void>(done => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function evidence(input: CodexHostInput<unknown>, state: CodexEvidence['state'] = 'completed'): CodexEvidence {
  const marker = /DOCK_SELF_TEST_[a-f0-9]{24}/u.exec(input.prompt)?.[0];
  return { runId: input.runId, fingerprint: 'synthetic', state, threadId: `thread:${input.runId}`, turnId: `turn:${input.runId}`,
    messages: [{ id: input.runId, phase: 'final_answer', text: marker ?? input.prompt }] };
}
async function finished(host: DeviceHost, id: string): Promise<SelfTestSnapshot> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = host.selfTestStatus;
    if (status?.id === id && status.phase === 'finished' && status.state !== 'running') { await turn(); return status; }
    await delay(10);
  }
  throw new Error('synthetic_self_test_did_not_finish');
}
async function fixture(t: TestContext, options: {
  execute?: (input: CodexHostInput<unknown>) => Promise<CodexEvidence>;
  inspect?: () => Promise<void>; readOnly?: boolean;
} = {}) {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/self-test-host-')), executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.1.0"\n', { mode: 0o700 });
  const config: DeviceConfig = { mode: 'device', nodeId: randomUUID(), token: 'synthetic-self-test-token-value-12345',
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'), providers: { codex: { executable, home: root }, dsh: { disabled: true } } };
  const inputs: CodexHostInput<unknown>[] = [], runPorts = new Map<string, number>(), closes: number[] = [];
  const adapters = createProviderAdapters(() => {
    const port = closes.length; closes.push(0);
    return {
      async inspect() {
        await options.inspect?.();
        return { models: [{ id: 'synthetic', efforts: ['low'], serviceTiers: [] }],
          permissionModes: options.readOnly === false ? [] : [{ value: 'read-only', name: 'Read-only' }],
          config: { sandbox: 'read-only', approvalPolicy: 'on-request', nativeMemoryDisabled: false } };
      },
      async execute(input: CodexHostInput<unknown>) {
        inputs.push(input); runPorts.set(input.runId, port);
        if (options.execute) return options.execute(input);
        await input.onReady(`thread:${input.runId}`); return evidence(input);
      },
      reconcile: async () => null, close: async () => { closes[port] = closes[port]! + 1; },
    };
  });
  let host = new DeviceHost(config, adapters);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, root, inputs, runPorts, closes,
    restart: async () => { await host.close(); host = new DeviceHost(config, adapters); return host; } };
}

test('fixed local self-test runs once read-only and preserves remote callbacks and retained sessions', { timeout: 10000 }, async t => {
  const context = await fixture(t), host = context.host;
  const remote: { runId: string; kind: string }[] = [];
  host.bind(async (_method, value) => { remote.push(value as { runId: string; kind: string }); return null; });
  await host.inventory();
  await host.prepare({ runId: 'ordinary-before', sessionKey: 'retained-remote' });
  await host.execute({ provider: 'codex', runId: 'ordinary-before', sessionKey: 'retained-remote', prompt: 'ordinary', model: 'synthetic', retainSession: true });
  await host.release('ordinary-before');
  const originalPort = context.runPorts.get('ordinary-before')!; remote.length = 0;
  await writeFile(join(context.root, 'user-owned.txt'), 'preserve user work');
  const id = randomUUID(), started = host.startSelfTest(id);
  assert.equal(started.state, 'running'); assert.equal(started.runId, id); assert.deepEqual(host.startSelfTest(id), started);
  const done = await finished(host, id);
  assert.equal(done.state, 'passed'); assert.equal(done.model, 'synthetic');
  const local = context.inputs.filter(value => value.runId === id);
  assert.equal(local.length, 1); assert.equal(local[0]!.mode, 'read-only'); assert.equal(local[0]!.effort, 'low');
  assert.equal(local[0]!.retainSession, false); assert.deepEqual(local[0]!.tools.definitions, []);
  assert.equal(context.closes[originalPort], 0, 'cleanup must not close an ordinary retained session');
  assert.equal(remote.length, 0); assert.equal(await readFile(join(context.root, 'user-owned.txt'), 'utf8'), 'preserve user work');
  assert.equal(host.getExecution(id)?.state, 'completed'); assert.equal(host.startSelfTest(id).state, 'passed');
  assert.equal(context.inputs.filter(value => value.runId === id).length, 1);
  host.bind(async (_method, value) => { remote.push(value as { runId: string; kind: string }); return null; });
  local[0]!.onSteeringReady?.(async () => 'accepted');
  assert.equal(await local[0]!.permission!({ id: 'late', title: 'Late local request', details: {}, canAllow: true }, new AbortController().signal, Promise.resolve()), 'deny');
  await turn(); assert.equal(remote.length, 0, 'late local callbacks never fall back to the current remote binding');
  await host.prepare({ runId: 'ordinary-after', sessionKey: 'retained-remote' });
  await host.execute({ provider: 'codex', runId: 'ordinary-after', sessionKey: 'retained-remote', prompt: 'ordinary again', model: 'synthetic', retainSession: true });
  assert.equal(context.runPorts.get('ordinary-after'), originalPort);
  assert(remote.some(value => value.runId === 'ordinary-after' && value.kind === 'ready'));
});

test('self-test reserves admission before probing and blocks ordinary work and maintenance until completion', { timeout: 10000 }, async t => {
  const probing = deferred(), releaseProbe = deferred(), executing = deferred(), releaseExecution = deferred();
  t.after(() => { releaseProbe.resolve(); releaseExecution.resolve(); });
  const context = await fixture(t, {
    inspect: async () => { probing.resolve(); await releaseProbe.promise; },
    execute: async input => { await input.onReady(`thread:${input.runId}`); executing.resolve(); await releaseExecution.promise; return evidence(input); },
  });
  const host = context.host, id = randomUUID(); host.startSelfTest(id); await probing.promise;
  assert.deepEqual(host.activeRunIds, []);
  await assert.rejects(host.prepare({ runId: 'ordinary-prepare' }), /device_busy/);
  await assert.rejects(host.execute({ provider: 'codex', runId: 'ordinary-execute', prompt: 'must not dispatch' }), /device_busy/);
  await assert.rejects(host.forgetSession('ordinary-session'), /device_busy/);
  assert.throws(() => host.closeIfIdle(), /device_busy/); assert.throws(() => host.startSelfTest(randomUUID()), /device_busy/);
  releaseProbe.resolve(); await executing.promise;
  assert.throws(() => host.cancel(id), /device_busy/);
  await assert.rejects(host.steer(id, 'external steering'), /device_busy/); assert.throws(() => host.closeIfIdle(), /device_busy/);
  releaseExecution.resolve(); assert.equal((await finished(host, id)).state, 'passed');
  const preparing = host.prepare({ runId: 'ordinary-pending' });
  assert.throws(() => host.startSelfTest(randomUUID()), /device_busy/); await preparing;
});

test('a native permission request is denied locally and cannot yield a passed self-test', { timeout: 10000 }, async t => {
  let decision: NativePermissionDecision | undefined;
  const context = await fixture(t, { execute: async input => {
    await input.onReady(`thread:${input.runId}`);
    decision = await input.permission!({ id: 'native-request', title: 'Unexpected native permission', details: {}, canAllow: true,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }] }, input.signal, Promise.resolve());
    return evidence(input);
  } });
  const remote: unknown[] = []; context.host.bind(async (_method, value) => { remote.push(value); return 'allow'; });
  const id = randomUUID(); context.host.startSelfTest(id); const done = await finished(context.host, id);
  assert.equal(decision, 'deny'); assert.notEqual(done.state, 'passed'); assert.equal(done.code, 'self_test_permission_requested'); assert.equal(remote.length, 0);
});

test('a native tool event invalidates exact echo success without reaching the application', { timeout: 10000 }, async t => {
  const context = await fixture(t, { execute: async input => {
    await input.onReady(`thread:${input.runId}`);
    await input.onEvent({ type: 'codex_event', threadId: `thread:${input.runId}`, turnId: `turn:${input.runId}`,
      kind: 'item', stage: 'started', item: { type: 'commandExecution', id: 'unexpected-command', command: 'synthetic never executed' } });
    return evidence(input);
  } });
  const remote: unknown[] = []; context.host.bind(async (_method, value) => { remote.push(value); return null; });
  const id = randomUUID(); context.host.startSelfTest(id); const done = await finished(context.host, id);
  assert.notEqual(done.state, 'passed'); assert.equal(done.code, 'self_test_unexpected_tool'); assert.equal(remote.length, 0);
});

test('oversized native tool events cannot hide a self-test violation behind observation truncation', { timeout: 10000 }, async t => {
  const context = await fixture(t, { execute: async input => {
    await input.onReady(`thread:${input.runId}`);
    await input.onEvent({ type: 'codex_event', threadId: `thread:${input.runId}`, turnId: `turn:${input.runId}`,
      kind: 'item', stage: 'started', item: { type: 'commandExecution', id: 'oversized-command', command: 'synthetic never executed', output: 'x'.repeat(300_000) } });
    return evidence(input);
  } });
  const remote: unknown[] = []; context.host.bind(async (_method, value) => { remote.push(value); return null; });
  const id = randomUUID(); context.host.startSelfTest(id); const done = await finished(context.host, id);
  assert.notEqual(done.state, 'passed'); assert.equal(done.code, 'self_test_unexpected_tool'); assert.equal(remote.length, 0);
});

test('unknown native evidence survives restart and prevents replay or unsafe cleanup', { timeout: 10000 }, async t => {
  const context = await fixture(t, { execute: async input => { await input.onReady(`thread:${input.runId}`); return evidence(input, 'unknown'); } });
  const id = randomUUID(); context.host.startSelfTest(id);
  assert.equal((await finished(context.host, id)).state, 'unknown'); assert.equal(context.host.getExecution(id)?.state, 'unknown');
  await assert.rejects(context.host.release(id), /unresolved_execution/);
  await assert.rejects(context.host.forgetSession(`self-test:${id}`), /session_in_use/);
  const restored = await context.restart();
  assert.equal(restored.selfTestStatus?.state, 'unknown'); assert.equal(restored.getExecution(id)?.state, 'unknown');
  assert.equal(restored.startSelfTest(id).state, 'unknown'); assert.throws(() => restored.startSelfTest(randomUUID()), /unresolved_execution/);
  assert.equal(context.inputs.length, 1);
});

test('local self-test requires native read-only support before model dispatch', { timeout: 10000 }, async t => {
  const context = await fixture(t, { readOnly: false }), id = randomUUID();
  context.host.startSelfTest(id); const done = await finished(context.host, id);
  assert.equal(done.state, 'failed'); assert.equal(done.code, 'self_test_read_only_unavailable');
  assert.equal(context.inputs.length, 0); assert.equal(context.host.getExecution(id), null);
});

test('ordinary active work and existing ordinary run identities cannot be taken over by self-test', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const context = await fixture(t, { execute: async input => {
    await input.onReady(`thread:${input.runId}`); entered.resolve(); await release.promise; return evidence(input);
  } });
  const host = context.host, ordinary = randomUUID();
  host.bind(async () => null); await host.inventory(); await host.prepare({ runId: ordinary });
  const running = host.execute({ provider: 'codex', runId: ordinary, prompt: 'ordinary caller input', model: 'synthetic' });
  await entered.promise;
  assert.throws(() => host.startSelfTest(randomUUID()), /device_busy/);
  assert.equal(host.selfTestStatus, undefined);
  release.resolve(); await running;
  assert.throws(() => host.startSelfTest(ordinary), /self_test_id_conflict/);
  assert.equal(host.selfTestStatus, undefined); assert.equal(context.inputs.length, 1);
});

test('native failure after ready remains unknown rather than becoming a retriable self-test failure', { timeout: 10000 }, async t => {
  const context = await fixture(t, { execute: async input => {
    await input.onReady(`thread:${input.runId}`); throw new Error('synthetic connection loss after native dispatch');
  } });
  const id = randomUUID(); context.host.startSelfTest(id); const done = await finished(context.host, id);
  assert.equal(done.state, 'unknown'); assert.equal(done.code, 'self_test_unconfirmed');
  assert.equal(context.host.getExecution(id)?.state, 'unknown');
  await assert.rejects(context.host.release(id), /unresolved_execution/);
  assert.equal(context.host.startSelfTest(id).state, 'unknown'); assert.equal(context.inputs.length, 1);
});
