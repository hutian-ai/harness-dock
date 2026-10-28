import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceExecuteInput } from '../apps/daemon/src/device-host.ts';

interface Result { provider: string; result: { state: string; threadId?: string; sessionId?: string; turnId?: string; exactFinalAnswer?: boolean; messages?: { phase: string | null; text: string }[] } }
interface Inventory { providers: { key: string; status: string; models: string[]; error?: string;
  readiness?: { level: string; modelExecutionVerified: boolean };
  capabilities?: { protocol: string; sessionResume: string; resultQuery: string; callerSkills: boolean; exactFinalAnswer: boolean; browser: string } }[] }
interface Callback { runId: string; kind: string; payload?: { type?: string; id?: string; name?: string; status?: string; callId?: string; context?: unknown; canAllow?: boolean; success?: boolean; options?: {optionId:string;kind:string}[] } }
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`timeout:${label}`); await delay(50); }
}
/** Only a confirmed pre-admission busy rejection is retryable here. This helper
 * never sends execute, and a lost response immediately stops the acceptance. */
export async function prepareAfterIdle(peer: { request(method: 'prepare', params: { runId: string; sessionKey: string; files: [] }): Promise<unknown> }, input: { runId: string; sessionKey: string; files: [] }): Promise<void> {
  await until(async () => {
    try { await peer.request('prepare', input); return true; }
    catch (error) { if (error instanceof Error && error.message === 'busy') return false; throw error; }
  }, 'idle_release_before_preparation');
}
/** Real provider acceptance always uses an isolated workdir and a distinct node/application identity. */
export async function acceptDevice(paths = {
  daemon: resolve('apps/daemon/dist/cli.js'), server: resolve('apps/server/dist/index.js'), client: resolve('packages/client/dist/index.js'),
}) {
  const provider = 'codex';
  process.umask(0o077);
  const root = resolve('.local/device-acceptance', `${provider}-${new Date().toISOString().replaceAll(':', '-')}`);
  const work = join(root, 'work'), stateDir = join(root, 'state');
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'user-owned.txt'), 'synthetic user file');
  const { DockServer } = await import(pathToFileURL(paths.server).href) as typeof import('../apps/server/src/index.ts');
  const { ServerClient } = await import(pathToFileURL(paths.client).href) as typeof import('../packages/client/src/index.ts');
  const node = { nodeId: randomUUID(), token: randomBytes(32).toString('hex') };
  const app = { clientId: randomUUID(), token: randomBytes(32).toString('hex'), nodeIds: [node.nodeId] };
  const server = new DockServer({ nodes: [node], clients: [app], devicePort: 0, clientPort: 0 });
  const configFile = join(root, 'config.json');
  let daemon: ReturnType<typeof spawn> | undefined, client: InstanceType<typeof ServerClient> | undefined;
  let log = '';
  let daemonExited = false;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const trace: Callback[] = [];
  const evidence: Record<string, unknown> = { provider, startedAt: new Date().toISOString(), status: 'running', trace };
  let ready = 0, tools = 0, activeRun = '', decisions = 0;
  const contextMarker = `CONTEXT_${randomBytes(6).toString('hex')}`, toolMarker = `TOOL_${randomBytes(6).toString('hex')}`;
  const text = (result: Result) => result.result.messages?.filter(m => m.phase === 'final_answer').map(m => m.text).join('\n') ?? '';
  try {
    await server.ready;
    await writeFile(configFile, JSON.stringify({ mode: 'device', ...node, endpoint: server.deviceEndpoint, cwd: work, stateDir,
      resources: { idleTimeoutMs: 2000 } }), { mode: 0o600 });
    daemon = spawn(process.execPath, [paths.daemon, 'run', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [daemon.stdout, daemon.stderr]) stream!.on('data', bytes => { log = (log + String(bytes)).slice(-65536); });
    exited = new Promise(resolve => daemon!.once('exit', (code, signal) => { daemonExited = true; resolve({ code, signal }); }));
    const sdk = client = new ServerClient({ endpoint: server.clientEndpoint, ...app });
    await sdk.ready;
    const peer = sdk.node(node.nodeId)!;
    await until(() => peer.connected, 'device_connection');
    const inventory = await peer.request<Inventory>('inventory', {}, 120000);
    evidence.inventory = inventory;
    const selected = inventory.providers.find(p => p.key === provider)!;
    assert.equal(selected.status, 'ready', selected.error);
    assert.equal(selected.readiness?.level, 'protocol');
    assert.equal(selected.readiness?.modelExecutionVerified, false);
    assert.equal(selected.capabilities?.protocol, 'acp');
    assert.equal(selected.capabilities?.browser, 'unverified');
    assert.equal(selected.capabilities?.resultQuery, 'native');
    const preferred = 'gpt-5.6-sol';
    const model = selected.models.includes(preferred) ? preferred : selected.models[0];
    evidence.model = model;
    console.log(JSON.stringify({ provider, phase: 'inventory_ready', model }));
    peer.onRequest('execution.callback', async value => {
      const callback = value as Callback;
      assert.equal(callback.runId, activeRun);
      trace.push({ runId: callback.runId, kind: callback.kind, payload: { type: callback.payload?.type, name: callback.payload?.name, success: callback.payload?.success, status: callback.payload?.status, callId: callback.payload?.callId, context: callback.payload?.context } });
      if (callback.kind === 'ready') ready++;
      if (callback.kind === 'permission') { decisions++; const options = callback.payload?.options; const once = options?.filter(option => option.kind === 'allow_once'); return options ? once?.length === 1 ? {optionId:once[0]!.optionId} : 'deny' : callback.payload?.canAllow ? 'allow' : 'deny'; }
      if (callback.kind === 'toolCall') {
        assert.equal(callback.payload?.name, 'synthetic_marker'); tools++;
        return { content: { marker: toolMarker }, isError: false, deliveryContext: ['synthetic-acceptance'] };
      }
      return null;
    });
    const sessionKey = randomUUID(), firstRun = activeRun = randomUUID();
    await peer.request('prepare', { runId: activeRun, sessionKey, files: [] });
    const input: DeviceExecuteInput = { provider, runId: activeRun, sessionKey, model,
      config: { effort: 'low' }, retainSession: true,
      prompt: `Remember ${contextMarker} for the next turn. Call synthetic_marker exactly once, then reply only with the marker returned by that tool. Do not repeat the context marker or run other tools.`,
      tools: { name: 'acceptance', definitions: [{ name: 'synthetic_marker', description: 'Return a synthetic marker without external side effects', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } };
    const first = await peer.request<Result>('execute', input, 240000); evidence.first = first;
    assert.equal(first.result.state, 'completed'); assert(text(first).includes(toolMarker));
    assert.equal(ready, 1); assert.equal(tools, 1);
    assert(decisions > 0); assert(trace.some(c => c.kind === 'permissionDelivered' && c.payload?.success));
    console.log(JSON.stringify({ provider, phase: 'first_completed', sessionId: first.result.sessionId, tools }));
    assert.deepEqual(await peer.request('execute', input), first);
    await assert.rejects(peer.request('execute', { ...input, prompt: 'conflicting input' }), /identity_conflict/);
    await peer.request('release', { runId: activeRun });
    // Codex cold resume must survive idle resource release.
    await delay(3000);
    activeRun = randomUUID();
    await prepareAfterIdle(peer, { runId: activeRun, sessionKey, files: [] });
    const second = await peer.request<Result>('execute', { ...input, runId: activeRun, previousRunId: firstRun,
      resumeSessionId: first.result.threadId ?? first.result.sessionId,
      prompt: 'Without calling tools, reply only with the context marker I asked you to remember in the previous turn.' }, 240000);
    evidence.second = second;
    assert.equal(second.result.state, 'completed'); assert(text(second).includes(contextMarker));
    assert.equal(second.result.threadId ?? second.result.sessionId, first.result.threadId ?? first.result.sessionId);
    assert.notEqual(second.result.turnId, first.result.turnId);
    assert.equal(ready, 2); assert.equal(tools, 1);
    console.log(JSON.stringify({ provider, phase: 'same_session_completed' }));
    await peer.request('release', { runId: activeRun });
    const events = await peer.request<unknown[]>('events', { runId: firstRun, after: 0 }); assert(events.length > 0);
    const observations = (events as { payload?: Record<string, unknown> }[]).map(event => event.payload).filter(event => event !== undefined);
    const items = observations.filter(event => event.type === 'codex_event' && event.kind === 'item');
    const completed = items.find(event => event.stage === 'completed' && (event.item as Record<string, unknown>)?.tool === 'synthetic_marker');
    assert(completed, 'native MCP completion must survive standard ACP projection');
    const item = completed.item as Record<string, unknown>;
    assert(items.some(event => event.stage === 'started' && (event.item as Record<string, unknown>)?.id === item.id));
    assert.equal(completed.threadId, first.result.threadId);
    assert.equal(completed.turnId, first.result.turnId);
    assert.notEqual(item.arguments, undefined);
    assert((JSON.stringify(item.result) ?? '').includes(toolMarker), 'projected native tool result must retain its text');
    assert(observations.some(event => event.type === 'tool_call' && event.toolCallId === item.id));
    evidence.observationProjection = { nativeItemEvents: items.length, matchingStandardTool: true, mcpTextPreserved: true };

    const beforeReconnect = trace.length;
    sdk.disconnect(); await until(() => !sdk.connected, 'SDK_disconnect');
    await until(() => sdk.connected && peer.connected, 'SDK_reconnect');
    assert.equal((await peer.request<{ state: string }>('getExecution', { runId: activeRun })).state, 'completed');
    assert.equal(trace.length, beforeReconnect);
    await peer.request('forgetSession', { sessionKey });
    assert.equal(await readFile(join(work, 'user-owned.txt'), 'utf8'), 'synthetic user file');
    await assert.rejects(peer.request('prepare', { runId: randomUUID(), sessionKey }), /session_forgotten/);
    assert.deepEqual(await peer.request('execute', input), first);
    assert.equal(ready, 2); assert.equal(tools, 1);
    evidence.status = 'passed'; evidence.assertions = ['MCP_and_permission_delivery', 'same_session_context', 'duplicate_and_conflict', 'events', 'reconnect_without_dispatch', 'forget_preserves_user_files_and_dedup'];
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    const shutdown = await Promise.allSettled([client?.close(), server.close(), (async () => {
      if (!daemon || !exited) return;
      if (!daemonExited) {
        // Use the authenticated local socket, never a PID read from disk.
        const stop = spawn(process.execPath, [paths.daemon, 'stop', configFile], { stdio: 'ignore' });
        const stopCode = await new Promise<number | null>((resolve, reject) => { stop.once('error', reject); stop.once('exit', resolve); }).catch(() => null);
        evidence.stopCode = stopCode;
        if (stopCode !== 0) { evidence.status = 'failed'; evidence.error ??= 'daemon_stop_unconfirmed'; process.exitCode = 1; daemon.kill('SIGTERM'); }
      }
      const timer = new AbortController();
      const stopped = await Promise.race([exited, delay(15000, null, { signal: timer.signal }).catch(() => null)]);
      timer.abort();
      if (!stopped) { daemon.kill('SIGKILL'); await exited; evidence.status = 'failed'; evidence.error = 'daemon_shutdown_unconfirmed'; process.exitCode = 1; }
      evidence.stopped = stopped;
    })()]);
    const homes = join(stateDir, 'providers', 'codex');
    const cleanup = await Promise.allSettled([
      ...(await readdir(homes).catch(() => [])).map(name => rm(join(homes, name, 'auth.json'), { force: true })),
    ]);
    const failure = [...shutdown, ...cleanup].find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') { evidence.status = 'failed'; evidence.error ??= String(failure.reason); process.exitCode = 1; }
    Object.assign(evidence, { ready, tools, decisions, finishedAt: new Date().toISOString() });
    await writeFile(join(root, 'daemon.log'), log);
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ evidenceDir: root, status: evidence.status, error: evidence.error }));
  }
}
