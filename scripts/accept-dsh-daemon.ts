import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { control } from '../apps/daemon/src/local-control.ts';
import { DockServer } from '../apps/server/src/index.ts';
import { ServerClient } from '../packages/client/src/index.ts';
import type { DeviceExecuteInput, DeviceExecutionResponse } from '../packages/protocol/src/index.ts';
import { prepareAfterIdle, until } from './accept-device.ts';
import { protectWindowsDirectory } from '../packages/drivers/src/windows-security.ts';

// Real model acceptance through the independently running, CLI-managed daemon.
// No native settings, installed daemon or existing execution identity is replaced.
process.umask(0o077);
await mkdir('.local', { recursive: true, mode: 0o700 });
const root = await mkdtemp(resolve('.local/dsh-daemon-acceptance-'));
await protectWindowsDirectory(root);
const work = join(root, 'work');
await mkdir(work); await mkdir(join(work, '.git'));
await writeFile(join(work, 'user-owned.txt'), 'synthetic user file');
const node = { nodeId: randomUUID(), token: randomBytes(32).toString('hex') };
const app = { clientId: randomUUID(), token: randomBytes(32).toString('hex'), nodeIds: [node.nodeId] };
const server = new DockServer({ nodes: [node], clients: [app], devicePort: 0, clientPort: 0 });
const exec = promisify(execFile);
const cli = async (...args: string[]) => (await exec(process.execPath,
  [resolve('apps/daemon/dist/cli.js'), ...args], { timeout: 30_000, windowsHide: true })).stdout;
const evidence: Record<string, unknown> = { provider: 'dsh', status: 'running', startedAt: new Date().toISOString(),
  scope: 'SDK → Server → independent background daemon → ACPX → installed dsh' };
let client: ServerClient | undefined, configPath: string | undefined;
let calls = 0, ready = 0, activeRun = '';
const contextMarker = `CONTEXT_${randomBytes(12).toString('hex')}`;
const toolMarker = `TOOL_${randomBytes(12).toString('hex')}`;
const text = (value: DeviceExecutionResponse) => (Array.isArray(value.result.messages) ? value.result.messages : [])
  .map(message => message && typeof message === 'object' && typeof message.text === 'string' ? message.text : '').join('\n');
try {
  await server.ready;
  ({ configPath } = await initializeDevice({ home: join(root, 'device'), cwd: work, ...node,
    endpoint: server.deviceEndpoint, resources: { idleTimeoutMs: 2000 }, providers: { codex: { disabled: true } } }));
  const started = JSON.parse(await cli('start', configPath));
  assert.ok(started.daemonId); evidence.daemonId = started.daemonId;
  client = new ServerClient({ endpoint: server.clientEndpoint, ...app });
  await client.ready;
  const peer = client.node(node.nodeId)!;
  await until(() => peer.connected, 'dsh_daemon_connection');
  const inventory = await peer.request('inventory', {}, 120_000);
  evidence.inventory = inventory;
  const provider = inventory.providers.find(value => value.key === 'dsh');
  assert.equal(provider?.status, 'ready', provider?.error);
  const inspected = provider?.inspection as { currentModelId?: string } | undefined;
  const model = process.env.HARNESS_DOCK_ACCEPT_DSH_MODEL ?? inspected?.currentModelId ?? provider?.models[0];
  assert.ok(model && provider?.models.includes(model)); evidence.model = model;
  peer.onExecutionCallback(async callback => {
    assert.equal(callback.runId, activeRun);
    if (callback.kind === 'ready') ready++;
    if (callback.kind === 'toolCall') {
      assert.equal(callback.payload.name, 'synthetic_marker'); calls++;
      return { content: { marker: toolMarker }, isError: false };
    }
    // The synthetic read-only tool needs no filesystem or command escalation.
    return callback.kind === 'permission' ? 'deny' : null;
  });
  const sessionKey = randomUUID();
  const input: DeviceExecuteInput = { provider: 'dsh', runId: activeRun = randomUUID(), sessionKey, model,
    prompt: `Remember ${contextMarker} for the next turn. Call synthetic_marker exactly once, then reply only with its marker. Do not repeat the context marker or use other tools.`,
    retainSession: true, tools: { name: 'acceptance', definitions: [{ name: 'synthetic_marker', description: 'Return a synthetic token without external side effects',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] } };
  await peer.request('prepare', { runId: input.runId, sessionKey, files: [] });
  // Persist dispatch identity before the only execute; uncertain results are never retried.
  await writeFile(join(root, 'request.json'), JSON.stringify(input), { mode: 0o600 });
  const first = await peer.request('execute', input, 240_000); evidence.first = first;
  assert.equal(first.result.state, 'completed'); assert.ok(text(first).includes(toolMarker));
  assert.equal(calls, 1); assert.equal(ready, 1);
  const sessionId = first.result.sessionId;
  assert.ok(typeof sessionId === 'string' && sessionId);
  assert.deepEqual(await peer.request('execute', input), first);
  await assert.rejects(peer.request('execute', { ...input, prompt: 'conflicting input' }), /identity_conflict/);
  await peer.request('release', { runId: input.runId });
  await delay(3000);
  activeRun = randomUUID();
  await prepareAfterIdle(peer, { runId: activeRun, sessionKey, files: [] });
  const second = await peer.request('execute', { ...input, runId: activeRun, previousRunId: input.runId,
    resumeSessionId: sessionId, prompt: 'Without using tools, reply only with the context marker I asked you to remember in the previous turn.' }, 240_000);
  evidence.second = second;
  assert.equal(second.result.state, 'completed'); assert.ok(text(second).includes(contextMarker));
  assert.equal(second.result.sessionId, first.result.sessionId);
  assert.equal(calls, 1); assert.equal(ready, 2);
  await peer.request('release', { runId: activeRun });
  client.disconnect(); await until(() => !client!.connected, 'dsh_SDK_disconnect');
  await until(() => client!.connected && peer.connected, 'dsh_SDK_reconnect');
  assert.equal((await peer.request('getExecution', { runId: activeRun }))?.state, 'completed');
  assert.equal(calls, 1); assert.equal(ready, 2);
  await peer.request('forgetSession', { sessionKey });
  assert.equal(await readFile(join(work, 'user-owned.txt'), 'utf8'), 'synthetic user file');
  assert.equal(JSON.parse(await cli('stop', configPath)).stopped, true);
  await until(async () => !await control(await readConfig(configPath!), 'status'), 'dsh_daemon_stop');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error); throw error;
} finally {
  const settled = await Promise.allSettled([client?.close(), server.close(), configPath ? cli('stop', configPath) : Promise.resolve()]);
  if (settled.some(value => value.status === 'rejected')) {
    evidence.status = 'failed'; evidence.shutdown = 'unconfirmed'; process.exitCode = 1;
  }
  Object.assign(evidence, { calls, ready, finishedAt: new Date().toISOString() });
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: evidence.status, evidence: relative(process.cwd(), join(root, 'evidence.json')) }));
}
