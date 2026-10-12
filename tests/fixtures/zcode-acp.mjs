// Synthetic ACP peer, not ZCode or a model. Exercises the real ACPX transport.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let session = 'synthetic-zcode-session', turn, permission;
const update = value => send({ method: 'session/update', params: { sessionId: session, update: value } });
const finish = stopReason => { if (turn) send({ id: turn.id, result: { stopReason } }); turn = undefined; };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method) appendFileSync(process.env.DOCK_AUDIT, message.method + '\n');
  if (message.id === 'permission' && !message.method) {
    if (!turn) return;
    const allowed = message.result?.outcome?.optionId === 'allow';
    if (allowed) writeFileSync(join(process.cwd(), 'allowed.txt'), 'synthetic');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'allowed' : 'denied' } });
    permission = undefined; finish('end_turn'); return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'synthetic-zcode', version: '1' } } });
  else if (method === 'session/new' || method === 'session/load') send({ id, result: { sessionId: session, modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Approval required' }] } } });
  else if (method === 'session/set_mode') {
    if (process.env.DOCK_REJECT_MODE || params.modeId !== 'build') send({ id, error: { code: -32602, message: 'mode rejected' } });
    else send({ id, result: {} });
  } else if (method === 'session/prompt') {
    turn = message;
    const text = params.prompt[0].text;
    if (text === 'crash') { process.exit(0); return; }
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'synthetic thought' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'synthetic tool', kind: 'execute', status: 'in_progress' });
    if (text === 'wait') return;
    if (text === 'permission') {
      permission = 'permission';
      send({ id: permission, method: 'session/request_permission', params: {
        sessionId: session, toolCall: { toolCallId: 'tool', title: 'write synthetic file', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
      } });
    } else {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      finish('end_turn');
    }
  } else if (method === 'session/cancel') finish('cancelled');
  else if (id !== undefined) send({ id, error: { code: -32601, message: 'unsupported synthetic method' } });
}).on('close', () => process.exit(0));
