// An ACP peer for testing the installed, patched runtime without a model service.
import { createInterface } from 'node:readline';
const sessionId = 'fixture-session';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const update = (value) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const extension = (value) => ({
  'harness-dock': { version: 1, ...value },
  secret: 'must-not-forward',
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === 'initialize')
    result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
  else if (request.method === 'session/new') result = { sessionId };
  else if (request.method === 'session/prompt') {
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'answer',
      content: { type: 'text', text: 'partial delta' },
      _meta: extension({ phase: 'final_answer' }),
    });
    for (const [stage, status] of [['started', 'inProgress'], ['completed', 'completed']]) update({
      sessionUpdate: 'session_info_update',
      _meta: extension({ event: { kind: 'item', threadId: sessionId, turnId: 'provider-turn', stage,
        item: { type: 'commandExecution', id: 'command', command: 'cat note.txt',
          commandActions: [{ type: 'read', name: 'note.txt', path: '/sandbox/note.txt' }], status,
          ...(stage === 'completed' ? { aggregatedOutput: 'synthetic', exitCode: 0, durationMs: 25 } : {}) } } }),
    });
    update({ sessionUpdate: 'session_info_update', _meta: extension({ event: {
      kind: 'item', threadId: sessionId, turnId: 'provider-turn', stage: 'future', item: { id: 'invalid', type: 'commandExecution' },
    } }) });
    const message = {
      messageId: 'answer',
      providerTurnId: 'provider-turn',
      phase: 'final_answer',
      text: '  complete\nanswer  ',
    };
    update({
      sessionUpdate: 'session_info_update',
      _meta: extension({ messageCompleted: message }),
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: extension({ messageCompleted: message }),
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: extension({ messageCompleted: { ...message, messageId: 'empty', text: '' } }),
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: extension({
        messageCompleted: { ...message, messageId: 'unclassified', phase: 'future_phase' },
      }),
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: extension({ messageCompleted: { ...message, messageId: 'invalid', text: 1 } }),
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: {
        'harness-dock': {
          version: 2,
          messageCompleted: { ...message, messageId: 'wrong-version' },
        },
      },
    });
    result = { stopReason: 'end_turn' };
  }
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
}
