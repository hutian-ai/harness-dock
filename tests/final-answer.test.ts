import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
