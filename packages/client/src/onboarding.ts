import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { assertEndpoint, DEVICE_PROTOCOL_VERSION, diagnosticError, id, queryServerHealth, type DiagnosticCheck } from '@harness-dock/protocol';
import { ServerClient, type ServerClientOptions, type ServerPeer } from './server-client.ts';
import { SERVER_PROTOCOL_VERSION, record } from './server-protocol.ts';
import type { DeviceRequestHandler } from './device-controller.ts';

export async function loadClientOptions(path: string): Promise<ServerClientOptions> {
  const file = await stat(path);
  if (!file.isFile() || file.size > 16_384 || process.platform !== 'win32' && (file.mode & 0o077)) throw new Error('invalid_client_file_permissions');
  let input: Record<string, unknown>;
  try { input = record(JSON.parse(await readFile(path, 'utf8'))); } catch { throw new Error('invalid_client_file'); }
  if (Object.keys(input).some(key => !['clientId', 'token', 'endpoint', 'caFile'].includes(key)) || typeof input.endpoint !== 'string'
    || typeof input.token !== 'string' || input.token.length < 32 || input.caFile !== undefined && typeof input.caFile !== 'string') throw new Error('invalid_client_file');
  id.parse(input.clientId); assertEndpoint(input.endpoint);
  return { clientId: input.clientId as string, token: input.token, endpoint: input.endpoint,
    ...(input.caFile ? { ca: await readFile(resolve(dirname(path), input.caFile as string), 'utf8') } : {}) };
}

export async function clientDoctor(options: ServerClientOptions, nodeId?: string, probe = false): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  try {
    const health = await queryServerHealth(options.endpoint, options.ca);
    checks.push({ check: 'server_transport', state: health.status === 'ok' ? 'pass' : 'fail', detail: 'Health reached with normal certificate verification.' });
    checks.push({ check: 'protocol', state: health.deviceProtocol === undefined || health.serverProtocol === undefined ? 'unknown'
      : health.deviceProtocol === DEVICE_PROTOCOL_VERSION && health.serverProtocol === SERVER_PROTOCOL_VERSION ? 'pass' : 'fail', detail: `Server protocol ${health.deviceProtocol ?? 'unknown'}/${health.serverProtocol ?? 'unknown'}; expected ${DEVICE_PROTOCOL_VERSION}/${SERVER_PROTOCOL_VERSION}.` });
  } catch (error) { checks.push({ check: 'server_health', state: 'unknown', detail: diagnosticError(error), next: 'Check TLS/CA and /healthz routing; authentication is checked separately.' }); }
  const client = new ServerClient({ ...options, connectTimeoutMs: 6_000 });
  try {
    await client.ready;
    checks.push({ check: 'application_authentication', state: 'pass', detail: 'Application connection accepted. No device credentials were used.' });
    const nodes = client.listNodes();
    const selected = nodeId ?? (nodes.length === 1 ? nodes[0]!.nodeId : undefined);
    const peer = selected ? client.node(selected) : undefined;
    checks.push({ check: 'device_grant', state: peer ? 'pass' : 'fail', detail: peer ? 'Selected device is granted to this application.' : `No unique granted device selected (${nodes.length} visible).`, next: 'Use nodes and --node-id; ask the server owner to grant the intended device.' });
    if (peer) {
      const boot = peer.daemonId;
      checks.push({ check: 'device_connection', state: peer.connected ? 'pass' : 'fail', detail: peer.connected ? 'Paired device is online.' : 'Device is offline; check its installed doctor.' });
      if (probe && peer.connected) {
        const inventory = record(await peer.request('inventory', {}, 120_000));
        if (!peer.connected || peer.daemonId !== boot || inventory.daemonId !== boot || inventory.nodeId !== peer.nodeId) throw new Error('device_connection_expired');
        const providers = Array.isArray(inventory.providers) ? inventory.providers.map(record) : [];
        const provider = providers.find(value => value.key === 'codex');
        checks.push({ check: 'codex_protocol', state: provider?.status === 'ready' ? 'pass' : 'fail', detail: `Codex probe: ${typeof provider?.status === 'string' ? provider.status : 'unavailable'}.`, next: 'Native login/host failures remain native limitations; this probe does not execute a model.' });
      } else checks.push({ check: 'codex_protocol', state: 'unknown', detail: 'Native protocol not probed.', next: 'Repeat doctor with --probe to explicitly inspect the native ACP environment without a model prompt.' });
    }
  } catch (error) {
    checks.push({ check: 'application_or_device', state: 'fail', detail: diagnosticError(error), next: 'Check application credentials, protocol and existing use of this application identity. No existing connection was replaced.' });
  } finally { await client.close(); }
  return checks;
}

/** A user explicitly selects the native option ID; never infer an allow from its position or name. */
export async function promptNativePermission(payload: Record<string, unknown>, signal: AbortSignal, onInterrupt?: () => void): Promise<unknown> {
  signal.throwIfAborted();
  if (!process.stdin.isTTY) return 'deny';
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  if (onInterrupt) reader.once('SIGINT', onInterrupt);
  try {
    console.error(`Native request: ${String(payload.title ?? 'permission')}`);
    if (payload.details) console.error(JSON.stringify(payload.details, null, 2));
    if (Array.isArray(payload.options)) {
      const options = payload.options.map(record);
      if (!options.length || options.some(option => typeof option.optionId !== 'string') || new Set(options.map(option => option.optionId)).size !== options.length) return 'deny';
      options.forEach((option, index) => console.error(`${index + 1}. ${String(option.name ?? option.optionId)} (${String(option.kind)})`));
      const answer = await reader.question('Choose a numbered native option, or Enter to deny: ', { signal });
      signal.throwIfAborted();
      const index = Number(answer) - 1;
      return answer.trim() && Number.isInteger(index) && options[index] ? { optionId: options[index]!.optionId } : 'deny';
    }
    if (payload.form) {
      const form = record(payload.form);
      console.error(form);
      const answer = await reader.question('Native response JSON {"action":"accept","content":{...}}; Enter declines: ', { signal });
      signal.throwIfAborted();
      if (!answer.trim()) return { action: 'decline' };
      const value = record(JSON.parse(answer));
      if (!['accept', 'decline', 'cancel'].includes(String(value.action))) return { action: 'decline' };
      return value;
    }
    if (payload.canAllow !== true) return 'deny';
    const answer = await reader.question('Allow this request once? Type allow; Enter denies: ', { signal });
    signal.throwIfAborted(); return answer.trim() === 'allow' ? 'allow' : 'deny';
  } catch { return 'deny'; } finally {
    if (onInterrupt) reader.removeListener('SIGINT', onInterrupt);
    reader.close();
  }
}

type FirstTestPeer = Pick<ServerPeer, 'nodeId' | 'daemonId' | 'connected' | 'request'> & {
  onRequest(method: string, handler: DeviceRequestHandler): () => void;
};
export async function runFirstTest(peer: FirstTestPeer, options: { model?: string; approval?: boolean;
  permission?: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  progress?: (value: object) => void;
} = {}) {
  const boot = peer.daemonId, sessionKey = randomUUID(), marker = `DOCK_TEST_${randomBytes(8).toString('hex')}`;
  const runs: string[] = [];
  let activeRun: string | undefined, permissions = 0, delivered = 0, tools = 0;
  const fence = () => { if (!boot || !peer.connected || peer.daemonId !== boot) throw new Error('device_connection_expired'); };
  const handler: DeviceRequestHandler = async (raw, context) => {
    const call = record(raw); context.signal.throwIfAborted(); fence();
    if (context.daemonId !== boot || context.nodeId !== peer.nodeId || call.runId !== activeRun) throw new Error('test_callback_expired');
    const payload = call.payload && typeof call.payload === 'object' ? record(call.payload) : {};
    if (call.kind === 'permission') { permissions++; const decision = options.permission ? await options.permission(payload, context.signal) : 'deny'; context.signal.throwIfAborted(); fence(); return decision; }
    if (call.kind === 'permissionDelivered') { if (payload.success === true) delivered++; return null; }
    if (call.kind === 'toolCall') {
      if (!options.approval || payload.name !== 'onboarding_marker') throw new Error('unexpected_test_tool');
      tools++; return { content: { marker }, isError: false };
    }
    return null;
  };
  fence();
  const remove = peer.onRequest('execution.callback', handler);
  try {
    const inventory = record(await peer.request('inventory', {}, 120_000)); fence();
    if (inventory.nodeId !== peer.nodeId || inventory.daemonId !== boot) throw new Error('device_connection_expired');
    const provider = (Array.isArray(inventory.providers) ? inventory.providers.map(record) : []).find(value => value.key === 'codex');
    if (provider?.status !== 'ready') throw new Error('codex_protocol_not_ready');
    if (!provider.capabilities || record(provider.capabilities).exactFinalAnswer !== true) throw new Error('test_exact_answer_unsupported');
    const models = Array.isArray(provider.models) ? provider.models.filter((model): model is string => typeof model === 'string') : [];
    const model = options.model ?? models[0];
    if (!model || !models.includes(model)) throw new Error('model_unavailable');
    let firstSessionId: string | undefined;
    for (let turn = 0; turn < 2; turn++) {
      fence(); activeRun = randomUUID(); runs.push(activeRun);
      options.progress?.({ phase: 'prepared', runId: activeRun, turn: turn + 1 });
      await peer.request('prepare', { runId: activeRun, sessionKey, files: [] }); fence();
      const input = { provider: 'codex', model, runId: activeRun, sessionKey, retainSession: true,
        ...(firstSessionId ? { previousRunId: runs[0], resumeSessionId: firstSessionId } : {}),
        prompt: turn === 0 ? `Remember ${marker} for the next turn. ${options.approval ? 'Call onboarding_marker exactly once and reply only with its marker. Do not use any other tools.' : 'Reply only with that marker. Do not call tools.'}`
          : 'Reply only with the marker from the previous turn. Do not call tools.',
        ...(options.approval ? { tools: { name: 'onboarding', definitions: [{ name: 'onboarding_marker', description: 'Return an isolated synthetic onboarding marker without external side effects', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } } : {}),
      };
      options.progress?.({ phase: 'dispatching_once', runId: activeRun, turn: turn + 1 });
      const response = record(await peer.request('execute', input, 240_000)); fence();
      const result = record(response.result);
      if (result.state !== 'completed') throw new Error('test_completion_unconfirmed');
      const messages = Array.isArray(result.messages) ? result.messages.map(record) : [];
      const text = messages.filter(message => message.phase === 'final_answer').map(message => String(message.text)).join('\n');
      if (text.trim() !== marker) throw new Error('test_answer_unverified');
      const sessionId = typeof result.threadId === 'string' ? result.threadId : result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('test_session_unverified');
      if (!turn) firstSessionId = sessionId;
      else if (sessionId !== firstSessionId) throw new Error('test_session_changed');
      await peer.request('release', { runId: activeRun }); fence();
      options.progress?.({ phase: 'completed', runId: activeRun, turn: turn + 1 });
    }
    if (options.approval && (tools !== 1 || permissions < 1 || delivered < 1)) throw new Error('test_approval_unverified');
    await peer.request('forgetSession', { sessionKey });
    return { state: 'completed', modelExecutionVerified: true, sameSessionVerified: true, approvalVerified: permissions > 0 && delivered > 0, runs };
  } catch (error) {
    throw new Error(`${diagnosticError(error)}; inspect original runs ${runs.join(',') || 'none'} before any new test. Never automatically replay a prompt or approval.`);
  } finally { remove(); }
}
