import { createAcpRuntime, createRuntimeStore, type AcpRuntimeEvent } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeCodexEvent, decodeCodexEvents, type CodexEvent } from '../packages/drivers/src/codex-events.ts';

const sessionStatus = { type: 'status', text: 'session updated', tag: 'session_info_update' } as const;

async function fixtureTurn(rawSessionUpdates: boolean, text = 'synthetic') {
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
      text,
      rawSessionUpdates,
    });
    void turn.promptStarted.catch(() => { });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) events.push(event);
    assert.equal((await turn.result).status, 'completed');
    return events;
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}

async function* iterable(events: AcpRuntimeEvent[]) { yield* events; }

test('local Codex decoder preserves the complete ordered event contract through the installed ACPX seam', async () => {
  const raw = await fixtureTurn(true);
  assert.equal(raw.length, 10);
  assert.ok(raw.every(event => event.type === 'session_update' && event.sessionId === 'fixture-session'));
  const events: CodexEvent[] = [];
  for await (const event of decodeCodexEvents(iterable(raw))) events.push(event);
  const item = {
    type: 'commandExecution', id: 'command', command: 'cat note.txt',
    commandActions: [{ type: 'read', name: 'note.txt', path: '/sandbox/note.txt' }],
  };
  const completed = {
    type: 'message_completed', messageId: 'answer', providerTurnId: 'provider-turn',
    phase: 'final_answer', text: '  complete\nanswer  ',
  };
  // This exact sequence was captured from the previous installed patch before migration.
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'partial delta', stream: 'output', tag: 'agent_message_chunk', messageId: 'answer', phase: 'final_answer' },
    { type: 'codex_event', threadId: 'fixture-session', turnId: 'provider-turn', kind: 'item', stage: 'started', item: { ...item, status: 'inProgress' } },
    { type: 'codex_event', threadId: 'fixture-session', turnId: 'provider-turn', kind: 'item', stage: 'completed',
      item: { ...item, status: 'completed', aggregatedOutput: 'synthetic', exitCode: 0, durationMs: 25 } },
    sessionStatus,
    completed,
    completed,
    { ...completed, messageId: 'empty', text: '' },
    { ...completed, messageId: 'unclassified', phase: null },
    sessionStatus,
    sessionStatus,
  ]);
  assert.ok(!JSON.stringify(events).includes('must-not-forward'));
  assert.ok(!JSON.stringify(events).includes('session_update'));
});

test('default ACPX events keep upstream normalization and do not expose raw metadata', async () => {
  const events = await fixtureTurn(false);
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'partial delta', stream: 'output', tag: 'agent_message_chunk', messageId: 'answer' },
    ...Array.from({ length: 9 }, () => sessionStatus),
  ]);
  assert.ok(!JSON.stringify(events).includes('must-not-forward'));
});

function envelope(update: Record<string, unknown>, event: Exclude<AcpRuntimeEvent, { type: 'session_update' }> | null = sessionStatus): AcpRuntimeEvent {
  return { type: 'session_update', sessionId: 'fixture-session', update, event };
}
function extension(value: Record<string, unknown>, version = 1) {
  return { 'harness-dock': { version, ...value }, secret: 'must-not-forward' };
}

test('decoder preserves extension precedence and malformed metadata fallback', () => {
  const message = { messageId: ' answer ', providerTurnId: ' turn ', phase: 'future', text: '' };
  const provider = { kind: 'turn_started', threadId: '', turnId: ' ' };
  const update = (value: Record<string, unknown>, version = 1) => envelope({ sessionUpdate: 'session_info_update', _meta: extension(value, version) });
  assert.deepEqual(decodeCodexEvent(update({ event: provider, messageCompleted: message })), {
    type: 'codex_event', kind: 'turn_started', threadId: '', turnId: ' ',
  });
  assert.deepEqual(decodeCodexEvent(update({ event: { ...provider, kind: 'future' }, messageCompleted: message })), {
    type: 'message_completed', messageId: 'answer', providerTurnId: 'turn', phase: null, text: '',
  });
  for (const input of [
    update({ messageCompleted: { ...message, messageId: ' ' } }),
    update({ messageCompleted: { ...message, text: 1 } }),
    update({ messageCompleted: message }, 2),
    envelope({ sessionUpdate: 'session_info_update', _meta: { 'harness-dock': [] } }),
    envelope({ sessionUpdate: 'current_mode_update', _meta: extension({ messageCompleted: message }) }),
  ]) assert.deepEqual(decodeCodexEvent(input), sessionStatus);
  assert.equal(decodeCodexEvent(envelope({ sessionUpdate: 'unknown', _meta: extension({ messageCompleted: message }) }, null)), null);
});

test('decoder preserves upstream text origin fields and applies phase only to ACP message chunks', () => {
  const delta = {
    type: 'text_delta', text: '  delta\n', stream: 'thought', tag: 'agent_thought_chunk',
    messageId: 'message', meta: { origin: 'assistant', kind: 'reasoning', source: 'native' },
  } as const;
  const update = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '  delta\n' },
    _meta: { ...extension({ phase: 'commentary' }), origin: ' assistant ', source: 'native', kind: 'reasoning', nested: { secret: 'must-not-forward' } } };
  assert.deepEqual(decodeCodexEvent(envelope(update, delta)), { ...delta, phase: 'commentary' });
  assert.deepEqual(decodeCodexEvent(envelope({ ...update, _meta: extension({ phase: 'future' }) }, delta)), delta);
  assert.deepEqual(decodeCodexEvent(envelope({ ...update, sessionUpdate: 'thought' }, delta)), delta);
  assert.deepEqual(decodeCodexEvent(delta), delta);
  assert.ok(!JSON.stringify(decodeCodexEvent(envelope(update, delta))).includes('must-not-forward'));
});

test('decoder keeps native usage validation and allows only the existing native item categories', () => {
  const total = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 3 };
  const native = (event: Record<string, unknown>) => envelope({ sessionUpdate: 'session_info_update', _meta: extension({ event: { threadId: 'thread', turnId: 'turn', ...event } }) });
  assert.deepEqual(decodeCodexEvent(native({ kind: 'usage', total })), { type: 'codex_event', threadId: 'thread', turnId: 'turn', kind: 'usage', total });
  for (const value of [-1, Number.MAX_SAFE_INTEGER + 1, NaN, undefined]) {
    assert.deepEqual(decodeCodexEvent(native({ kind: 'usage', total: { ...total, inputTokens: value } })), sessionStatus);
  }
  for (const type of ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange', 'reasoning']) {
    const item = { id: '', type, customDetail: 'must-not-forward', content: ['raw-reasoning'] };
    assert.deepEqual(decodeCodexEvent(native({ kind: 'item', stage: 'completed', item })), {
      type: 'codex_event', threadId: 'thread', turnId: 'turn', kind: 'item', stage: 'completed', item: { id: '', type },
    });
  }
  assert.deepEqual(decodeCodexEvent(native({ kind: 'item', stage: 'completed', item: { id: 'future', type: 'future' } })), sessionStatus);
});

test('native display reuses ordered standard ACP tool facts, including partial updates and binary filtering', async () => {
  const events: CodexEvent[] = [];
  for await (const event of decodeCodexEvents(iterable(await fixtureTurn(true, 'standard-facts')))) events.push(event);
  const native = events.filter(event => event.type === 'codex_event' && event.kind === 'item');
  assert.equal(native.length, 6);
  const command = native[1];
  assert.ok(command?.type === 'codex_event' && command.kind === 'item');
  assert.deepEqual(command.item, { id: 'command', type: 'commandExecution', command: 'cat note.txt', cwd: '/sandbox', status: 'completed',
    durationMs: 25, exitCode: 0, commandActions: [{ type: 'read', name: 'note.txt', path: '/sandbox/note.txt' }], aggregatedOutput: 'from ACP' });
  const mcp = native[3];
  assert.ok(mcp?.type === 'codex_event' && mcp.kind === 'item');
  assert.deepEqual(mcp.item, { id: 'mcp', type: 'mcpToolCall', status: 'completed', server: 'fixture', tool: 'read', arguments: { path: 'note.txt' },
    durationMs: 3, result: { content: [{ type: 'text', text: 'MCP result' }] } });
  const dynamic = native[5];
  assert.ok(dynamic?.type === 'codex_event' && dynamic.kind === 'item');
  assert.deepEqual(dynamic.item, { id: 'dynamic', type: 'dynamicToolCall', tool: 'fixture', status: 'completed', arguments: { key: 'retained' }, success: true,
    contentItems: [{ type: 'text', text: 'x'.repeat(16000) + '\n…输出已截断' }] });
  assert.equal(JSON.stringify(native).includes('must-not-forward'), false);
  // Every native start/end follows the corresponding upstream tool event, without replacing it.
  for (let i = 0; i < events.length; i++) if (events[i]?.type === 'codex_event') assert.equal(events[i - 1]?.type, 'tool_call');
});

test('native tool metadata cannot cross session/item identities or turn unknown categories into observations', async () => {
  const nativeItem = { threadId: 'fixture-session', turnId: 'turn', stage: 'started', item: { id: 'tool', type: 'commandExecution' } };
  const updates = [
    { ...nativeItem, threadId: 'child-session' },
    { ...nativeItem, stage: 'future' },
    { ...nativeItem, item: { id: 'other-tool', type: 'commandExecution' } },
    ...['future', '__proto__', 'constructor'].map(type => ({ ...nativeItem, item: { id: 'tool', type } })),
  ].map(value => envelope({ sessionUpdate: 'tool_call', toolCallId: 'tool', _meta: extension({ nativeItem: value }) }));
  const events = [];
  for await (const event of decodeCodexEvents(iterable(updates))) events.push(event);
  assert.deepEqual(events, updates.map(() => sessionStatus));
});
