import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceExecuteInput } from '../apps/daemon/src/device-host.ts';

interface Result { provider: string; result: { state: string; threadId?: string; sessionId?: string; turnId?: string; text?: string; exactFinalAnswer?: boolean; messages?: { phase: string | null; text: string }[] } }
interface Inventory { providers: { key: string; status: string; models: string[]; error?: string }[] }
interface Callback { runId: string; kind: string; payload?: { type?: string; id?: string; name?: string; canAllow?: boolean; success?: boolean } }
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`timeout:${label}`); await delay(50); }
}
/** Real provider acceptance always uses an isolated workdir and a distinct node/application identity. */
export async function acceptDevice(provider: 'codex' | 'zcode', paths = {
  daemon: resolve('apps/daemon/dist/cli.js'), server: resolve('apps/server/dist/index.js'), client: resolve('packages/client/dist/index.js'),
}) {
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
  await server.ready;
  const zcodeHome = join(root, 'zcode-home');
  const zcodeFiles = ['v2/credentials.json', 'provider_config.json', 'config.json'];
  if (provider === 'zcode') {
    await mkdir(join(zcodeHome, 'v2'), { recursive: true });
    for (const file of zcodeFiles) {
      try { await copyFile(join(process.env.ZCODE_HOME ?? join(homedir(), '.zcode'), file), join(zcodeHome, file)); await chmod(join(zcodeHome, file), 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const configFile = join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ mode: 'device', ...node, endpoint: server.deviceEndpoint, cwd: work, stateDir,
    resources: { idleTimeoutMs: provider === 'codex' ? 2000 : 60000 },
    providers: { ...Object.fromEntries(['codex', 'lobi', 'deepseek-harness', 'zcode'].filter(key => key !== provider).map(key => [key, { disabled: true }])), ...(provider === 'zcode' ? { zcode: { home: zcodeHome } } : {}) } }), { mode: 0o600 });
  const daemon = spawn(process.execPath, [paths.daemon, 'run', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', bytes => { log = (log + String(bytes)).slice(-65536); });
  const exited = new Promise(resolve => daemon.once('exit', (code, signal) => resolve({ code, signal })));
  const client = new ServerClient({ endpoint: server.clientEndpoint, ...app });
  const trace: Callback[] = [];
  const evidence: Record<string, unknown> = { provider, startedAt: new Date().toISOString(), status: 'running', trace };
  let ready = 0, tools = 0, activeRun = '', decisions = 0;
  const contextMarker = `CONTEXT_${randomBytes(6).toString('hex')}`, toolMarker = `TOOL_${randomBytes(6).toString('hex')}`;
  const text = (result: Result) => provider === 'codex'
    ? result.result.messages?.filter(m => m.phase === 'final_answer').map(m => m.text).join('\n') ?? '' : result.result.text ?? '';
  try {
    await client.ready;
    const peer = client.node(node.nodeId)!;
    await until(() => peer.connected, 'device_connection');
    const inventory = await peer.request<Inventory>('inventory', {}, 120000);
    evidence.inventory = inventory;
    const selected = inventory.providers.find(p => p.key === provider)!;
    assert.equal(selected.status, 'ready', selected.error);
    const model = selected.models.includes('gpt-5.6-sol') ? 'gpt-5.6-sol' : selected.models[0];
    peer.onRequest('execution.callback', async value => {
      const callback = value as Callback;
      assert.equal(callback.runId, activeRun);
      trace.push({ runId: callback.runId, kind: callback.kind, payload: { type: callback.payload?.type, success: callback.payload?.success } });
      if (callback.kind === 'ready') ready++;
      if (callback.kind === 'permission') { decisions++; return callback.payload?.canAllow ? 'allow' : 'deny'; }
      if (callback.kind === 'toolCall') {
        assert.equal(callback.payload?.name, 'synthetic_marker'); tools++;
        return { content: { marker: toolMarker }, isError: false, deliveryContext: ['synthetic-acceptance'] };
      }
      return null;
    });
    const sessionKey = randomUUID(), firstRun = activeRun = randomUUID();
    await peer.request('prepare', { runId: activeRun, sessionKey, files: [] });
    const input: DeviceExecuteInput = { provider, runId: activeRun, sessionKey, model,
      ...(provider === 'codex' ? { config: { effort: 'low' } } : {}), retainSession: true,
      prompt: `Remember ${contextMarker} for the next turn. Call synthetic_marker exactly once, then reply only with the marker returned by that tool. Do not repeat the context marker or run other tools.`,
      tools: { name: 'acceptance', definitions: [{ name: 'synthetic_marker', description: 'Return a synthetic marker without external side effects', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } };
    const first = await peer.request<Result>('execute', input, 240000); evidence.first = first;
    assert.equal(first.result.state, 'completed'); assert(text(first).includes(toolMarker));
    if (provider === 'zcode') assert.equal(first.result.exactFinalAnswer, false);
    assert.equal(ready, 1); assert.equal(tools, 1); assert(decisions > 0);
    assert(trace.some(c => c.kind === 'permissionDelivered' && c.payload?.success));
    assert.deepEqual(await peer.request('execute', input), first);
    await assert.rejects(peer.request('execute', { ...input, prompt: 'conflicting input' }), /identity_conflict/);
    await peer.request('release', { runId: activeRun });
    // Codex cold resume must survive idle resource release; ZCode explicitly offers warm resume only.
    if (provider === 'codex') await delay(3000);
    activeRun = randomUUID();
    await peer.request('prepare', { runId: activeRun, sessionKey, files: [] });
    const second = await peer.request<Result>('execute', { ...input, runId: activeRun, previousRunId: firstRun,
      resumeSessionId: first.result.threadId ?? first.result.sessionId,
      prompt: 'Without calling tools, reply only with the context marker I asked you to remember in the previous turn.' }, 240000);
    evidence.second = second;
    assert.equal(second.result.state, 'completed'); assert(text(second).includes(contextMarker));
    assert.equal(second.result.threadId ?? second.result.sessionId, first.result.threadId ?? first.result.sessionId);
    if (provider === 'codex') assert.notEqual(second.result.turnId, first.result.turnId);
    assert.equal(ready, 2); assert.equal(tools, 1);
    await peer.request('release', { runId: activeRun });
    const events = await peer.request<unknown[]>('events', { runId: firstRun, after: 0 }); assert(events.length > 0);
    const beforeReconnect = trace.length;
    client.disconnect(); await until(() => !client.connected, 'SDK_disconnect');
    await until(() => client.connected && peer.connected, 'SDK_reconnect');
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
    await client.close(); daemon.kill('SIGTERM');
    const timer = new AbortController();
    const stopped = await Promise.race([exited, delay(15000, null, { signal: timer.signal }).catch(() => null)]);
    timer.abort();
    if (!stopped) { daemon.kill('SIGKILL'); await exited; evidence.status = 'failed'; evidence.error = 'daemon_shutdown_unconfirmed'; process.exitCode = 1; }
    await server.close();
    const homes = join(stateDir, 'providers', 'codex');
    for (const name of await readdir(homes).catch(() => [])) await rm(join(homes, name, 'auth.json'), { force: true });
    if (provider === 'zcode') for (const file of zcodeFiles) await rm(join(zcodeHome, file), { force: true });
    Object.assign(evidence, { ready, tools, decisions, stopped, finishedAt: new Date().toISOString() });
    await writeFile(join(root, 'daemon.log'), log);
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ evidenceDir: root, status: evidence.status, error: evidence.error }));
  }
}
