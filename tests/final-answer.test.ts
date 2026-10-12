import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import {
  applyEvent,
  type CompletedMessage,
  type RunChange,
  type RunSnapshot,
  type RunState,
} from '../packages/protocol/src/index.ts';

function run(): RunSnapshot {
  return {
    nodeId: 'node',
    daemonId: 'daemon',
    sessionId: 'session',
    runId: 'run',
    sequence: 0,
    state: 'running',
    output: '',
    messages: [],
    finalAnswer: null,
    permissions: [],
    tools: [],
  };
}
function change(snapshot: RunSnapshot, change: RunChange): void {
  applyEvent(snapshot, {
    daemonId: snapshot.daemonId,
    runId: snapshot.runId,
    sequence: snapshot.sequence + 1,
    change,
  });
}
const answer: CompletedMessage = {
  messageId: 'answer',
  providerTurnId: 'turn',
  phase: 'final_answer',
  text: '  exact\nanswer  ',
};
test('final answer uses complete messages only after success; missing phase and cancellation stay unavailable', () => {
  const snapshot = run();
  change(snapshot, {
    type: 'output',
    output: {
      type: 'text',
      text: 'interim + partial answer',
      messageId: 'answer',
      phase: 'final_answer',
    },
  });
  change(snapshot, {
    type: 'output',
    output: {
      type: 'message_completed',
      messageId: 'comment',
      providerTurnId: 'turn',
      phase: 'commentary',
      text: 'interim',
    },
  });
  for (let i = 0; i < 2; i++)
    change(snapshot, { type: 'output', output: { type: 'message_completed', ...answer } });
  assert.equal(snapshot.output, 'interim + partial answer');
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.finalAnswer, null);
  change(snapshot, { type: 'state', state: 'completed' });
  assert.deepEqual(snapshot.finalAnswer, [answer]);
  const missing = run();
  change(missing, {
    type: 'output',
    output: { type: 'text', text: 'looks final', phase: 'final_answer' },
  });
  change(missing, { type: 'state', state: 'completed' });
  assert.equal(missing.finalAnswer, null);
  for (const state of [
    'cancel_requested',
    'cancelled',
    'failed',
    'outcome_unknown',
  ] satisfies RunState[]) {
    const interrupted = run();
    change(interrupted, { type: 'output', output: { type: 'message_completed', ...answer } });
    change(interrupted, { type: 'state', state });
    assert.equal(interrupted.finalAnswer, null);
  }
  const unknown = run();
  change(unknown, {
    type: 'output',
    output: { type: 'message_completed', ...answer, phase: null },
  });
  change(unknown, { type: 'state', state: 'completed' });
  assert.equal(unknown.finalAnswer, null);
  assert.throws(
    () =>
      change(snapshot, {
        type: 'output',
        output: { type: 'message_completed', ...answer, text: 'conflicting body' },
      }),
    /message_conflict/,
  );
  const multiple = run();
  for (const message of [answer, { ...answer, messageId: 'second', text: '' }])
    change(multiple, { type: 'output', output: { type: 'message_completed', ...message } });
  change(multiple, { type: 'state', state: 'completed' });
  assert.deepEqual(
    multiple.finalAnswer?.map((message) => message.text),
    [answer.text, ''],
  );
});
test('installed ACPX patch decodes completion separately, preserves exact text and filters malformed metadata', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local/runtime-test-'));
  const runtime = createAcpRuntime({
    cwd: directory,
    sessionStore: createRuntimeStore({ stateDir: directory }),
    agentRegistry: createAgentRegistry({
      overrides: { fixture: [process.execPath, resolve('tests/fixtures/acp-messages.mjs')] },
    }),
    permissionMode: 'deny-all',
    fs: false,
    terminal: false,
  });
  try {
    const handle = await runtime.ensureSession({
      sessionKey: 'fixture',
      agent: 'fixture',
      mode: 'persistent',
      cwd: directory,
    });
    const turn = runtime.startTurn({
      handle,
      requestId: 'fixture-run',
      mode: 'prompt',
      text: 'synthetic',
    });
    void turn.promptStarted.catch(() => { });
    const events = [];
    for await (const event of turn.events) events.push(event);
    assert.equal((await turn.result).status, 'completed');
    const items = events.filter((event) => event.type === 'codex_event' && event.kind === 'item');
    assert.deepEqual(items.map(event => event.stage), ['started', 'completed']);
    assert.deepEqual(items[0]?.item.commandActions, [{ type: 'read', name: 'note.txt', path: '/sandbox/note.txt' }]);
    assert.equal(items[1]?.item.exitCode, 0);
    assert.equal(items[1]?.item.aggregatedOutput, 'synthetic');
    const completed = events.filter((event) => event.type === 'message_completed');
    assert.equal(completed.length, 4);
    assert.equal(completed[0]?.text, '  complete\nanswer  ');
    assert.equal(completed[2]?.text, '');
    assert.equal(completed[3]?.phase, null);
    const deltas = events.filter((event) => event.type === 'text_delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0]?.phase, 'final_answer');
    assert.ok(!JSON.stringify(events).includes('must-not-forward'));
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
