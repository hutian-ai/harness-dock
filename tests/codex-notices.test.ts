import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCodexEvent } from '../packages/drivers/src/codex-events.ts';

test('Codex native retry metadata becomes status without changing the final reply contract', () => {
  const standard = { type: 'status', tag: 'session_info_update', text: 'session updated' } as const;
  const retry = (error: Record<string, unknown>) => ({ type: 'session_update' as const, sessionId: 'synthetic',
    update: { sessionUpdate: 'session_info_update', _meta: { codex: { error } } }, event: standard });
  assert.deepEqual(decodeCodexEvent(retry({ willRetry: true, message: 'Temporary native failure' })), {
    type: 'status', tag: 'codex_retry', text: 'Temporary native failure',
  });
  assert.deepEqual(decodeCodexEvent(retry({ willRetry: false, message: 'Terminal native failure' })), standard);
  assert.deepEqual(decodeCodexEvent(retry({ willRetry: 'true' })), standard);
});

test('Codex transport warning is status only when it has no native assistant identity', () => {
  const text = 'Warning: Falling back from WebSockets to HTTPS transport. synthetic';
  const standard = { type: 'text_delta', stream: 'output', tag: 'agent_message_chunk', text } as const;
  const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
  assert.deepEqual(decodeCodexEvent({ type: 'session_update', sessionId: 'synthetic', update, event: standard }), {
    type: 'status', tag: 'codex_transport_fallback', text,
  });
  const identified = { ...standard, messageId: 'native-message' };
  assert.deepEqual(decodeCodexEvent({ type: 'session_update', sessionId: 'synthetic', update, event: identified }), identified);
  assert.deepEqual(decodeCodexEvent({ type: 'session_update', sessionId: 'synthetic',
    update: { ...update, _meta: { 'harness-dock': { version: 1, phase: 'final_answer' } } }, event: standard }),
  { ...standard, phase: 'final_answer' });
});
