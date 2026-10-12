import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../apps/daemon/src/engine.ts';
import { DaemonConnection } from '../apps/daemon/src/connection.ts';
import { DockClient } from '../packages/client/src/index.ts';
import type { CodexExecutionInput, CodexEvidence } from '../packages/drivers/src/index.ts';
import type { Observation } from '../packages/protocol/src/index.ts';

class ControlledDriver {
  starts = 0;
  input?: CodexExecutionInput;
  private finish?: (result: CodexEvidence) => void;
  async inspect() {
    return { models: [], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } };
  }
  async execute(input: CodexExecutionInput): Promise<CodexEvidence> {
    this.starts++;
    this.input = input;
    await input.onReady('synthetic-thread');
    return new Promise(resolve => { this.finish = resolve; });
  }
  permission(request: { title: string; details: unknown; canAllow: boolean }, signal: AbortSignal) {
    return this.input!.permission!({ id: randomUUID(), ...request }, signal, Promise.resolve());
  }
  push(text: string) {
    return this.input!.onEvent({ type: 'text_delta', stream: 'output', text });
  }
  complete(state: CodexEvidence['state'] = 'completed') {
    this.finish?.({ runId: this.input!.runId, fingerprint: 'synthetic', messages: [], state });
  }
  async close() {}
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out');
}
test('identity, one active turn, exact session, permission ownership and cancel/result race', async () => {
  const driver = new ControlledDriver();
  const engine = new Engine(driver);
  const input = { runId: randomUUID(), prompt: 'synthetic' };
  const snapshot = engine.start(input);
  assert.equal(engine.start(input).sessionId, snapshot.sessionId);
  assert.equal(driver.starts, 1);
  assert.throws(() => engine.start({ ...input, prompt: 'different' }), /identity_conflict/);
  assert.throws(() => engine.start({ ...input, runId: randomUUID() }), /busy/);
  const permission = driver.permission(
    { title: 'write synthetic marker', details: {}, canAllow: true },
    new AbortController().signal,
  );
  const permissionId = engine.getRun(input.runId).permissions[0]!.permissionId;
  assert.throws(
    () => engine.respondPermission({ runId: randomUUID(), permissionId, decision: 'allow' }),
    /run_not_found/,
  );
  const cancelling = await engine.cancel(input.runId);
  assert.equal(cancelling.state, 'cancel_requested');
  assert.equal(await permission, 'deny');
  assert.throws(
    () => engine.respondPermission({ runId: input.runId, permissionId, decision: 'allow' }),
    /permission_expired/,
  );
  driver.complete('completed');
  await until(() => engine.getRun(input.runId).state === 'completed');
  assert.throws(
    () => engine.start({ runId: randomUUID(), prompt: 'resume', sessionId: randomUUID() }),
    { kind: 'session_unavailable' },
  );
  const second = engine.start({
    runId: randomUUID(),
    prompt: 'resume',
    sessionId: snapshot.sessionId,
  });
  await delay(0);
  const allowed = driver.permission(
    { title: 'once', details: {}, canAllow: true },
    new AbortController().signal,
  );
  const nextPermission = engine.getRun(second.runId).permissions[0]!;
  engine.respondPermission({
    runId: second.runId,
    permissionId: nextPermission.permissionId,
    decision: 'allow',
  });
  assert.equal(await allowed, 'allow');
  assert.throws(
    () =>
      engine.respondPermission({
        runId: second.runId,
        permissionId: nextPermission.permissionId,
        decision: 'allow',
      }),
    /permission_expired/,
  );
  const stopping = engine.shutdown();
  assert.equal(driver.input!.signal.aborted, true);
  driver.complete('cancelled');
  await stopping;
});
test('WebSocket snapshots, disconnect during permission, recovery without redispatch, new daemon unknown', async (t) => {
  const token = randomBytes(32).toString('hex');
  const nodeId = randomUUID();
  const client = new DockClient({ token, nodeId, port: 0 });
  await client.ready;
  const driver = new ControlledDriver();
  const engine = new Engine(driver, { nodeId });
  const rejected = new DaemonConnection(engine, client.endpoint, 'invalid-credential');
  rejected.connect();
  await delay(250);
  assert.equal(client.connected, false);
  rejected.stop();
  const connection = new DaemonConnection(engine, client.endpoint, token);
  connection.connect();
  t.after(async () => {
    connection.stop();
    driver.complete('cancelled');
    await engine.shutdown();
    await client.close();
  });
  await client.waitForConnection();
  const input = { runId: randomUUID(), prompt: 'synthetic' };
  await client.start(input);
  const seen: Observation[] = [];
  const unsubscribe = await client.subscribe(input.runId, (observation) => seen.push(observation));
  assert.equal(seen[0]?.type, 'snapshot');
  driver.push('A');
  await until(() => seen.some((o) => o.type === 'event' && o.event.change.type === 'output'));
  const signal = new AbortController();
  const permission = driver.permission(
    { title: 'ask', details: {}, canAllow: true },
    signal.signal,
  );
  const permissionId = engine.getRun(input.runId).permissions[0]!.permissionId;
  client.disconnect();
  await until(() => !client.connected);
  driver.push('B');
  assert.equal((await client.getRun(input.runId)).state, 'outcome_unknown');
  await client.waitForConnection();
  await until(() => seen.filter((o) => o.type === 'snapshot').length >= 3);
  assert.equal(driver.starts, 1);
  const recovered = await client.getRun(input.runId);
  assert.equal(recovered.output, 'AB');
  assert.equal(recovered.permissions[0]?.permissionId, permissionId);
  await client.respondPermission({ runId: input.runId, permissionId, decision: 'deny' });
  assert.equal(await permission, 'deny');
  const events = seen.filter((o) => o.type === 'event').map((o) => o.event.sequence);
  assert.equal(new Set(events).size, events.length);
  connection.stop();
  await until(() => !client.connected);
  const replacement = new Engine(new ControlledDriver(), { nodeId });
  const replacementConnection = new DaemonConnection(replacement, client.endpoint, token);
  replacementConnection.connect();
  t.after(async () => {
    replacementConnection.stop();
    await replacement.shutdown();
  });
  await client.waitForConnection();
  assert.equal((await client.getRun(input.runId)).state, 'outcome_unknown');
  await assert.rejects(client.start(input), /original daemon is unavailable/);
  await assert.rejects(
    client.respondPermission({ runId: input.runId, permissionId, decision: 'allow' }),
    /outcome_unknown/,
  );
  unsubscribe();
});
test('missing completion evidence stays unknown and prevents another dispatch', async () => {
  const driver = {
    inspect: async () => ({ models: [], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } }),
    execute: async () => {
      throw new Error('transport lost after admission');
    },
    close: async () => { },
  };
  const engine = new Engine(driver);
  const snapshot = engine.start({ runId: randomUUID(), prompt: 'synthetic' });
  await until(() => engine.getRun(snapshot.runId).state === 'outcome_unknown');
  assert.throws(
    () => engine.start({ runId: randomUUID(), prompt: 'another', sessionId: snapshot.sessionId }),
    /busy/,
  );
  await engine.shutdown();
});
