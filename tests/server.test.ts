import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DockServer, initializeServer, parseServerConfig, readServerConfig } from '../apps/server/src/index.ts';
import { ServerClient } from '../packages/client/src/server-client.ts';
import { SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL_VERSION } from '../packages/client/src/server-protocol.ts';
import { DEVICE_PROTOCOL_HEADER, DEVICE_PROTOCOL_VERSION } from '../packages/protocol/src/device.ts';

const node = () => ({ nodeId: randomUUID(), token: randomBytes(32).toString('hex') });
const owner = (nodeIds: string[]) => ({ clientId: randomUUID(), token: randomBytes(32).toString('hex'), nodeIds });
const clientHeaders = (client: ReturnType<typeof owner>) => ({
  authorization: `Bearer ${client.token}`, 'x-dock-client': client.clientId,
  [SERVER_PROTOCOL_HEADER]: String(SERVER_PROTOCOL_VERSION),
});
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(5); }
}
async function connect(endpoint: string, headers: Record<string, string>) {
  const socket = new WebSocket(endpoint, { headers });
  const requests: { id: string; method: string; params: Record<string, unknown> }[] = [];
  const replies = new Map<string, (value: Record<string, unknown>) => void>();
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.method) requests.push(message);
    else { replies.get(message.id)?.(message); replies.delete(message.id); }
  });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket, requests,
    reply(id: string, result: unknown) { socket.send(JSON.stringify({ jsonrpc: '2.0', id, result })); },
    call(method: string, params: object) {
      const id = randomUUID();
      const response = new Promise<Record<string, unknown>>(resolve => replies.set(id, resolve));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); return response;
    },
  };
}
async function device(endpoint: string, pairing: ReturnType<typeof node>) {
  const daemonId = randomUUID();
  return { ...await connect(endpoint, {
    authorization: `Bearer ${pairing.token}`, 'x-dock-node': pairing.nodeId, 'x-dock-daemon': daemonId,
    [DEVICE_PROTOCOL_HEADER]: String(DEVICE_PROTOCOL_VERSION),
  }), daemonId };
}
async function rejected(endpoint: string, headers: Record<string, string>) {
  const socket = new WebSocket(endpoint, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', () => resolve());
    socket.once('open', () => { socket.terminate(); reject(new Error('unexpected authentication')); });
  });
}

test('server enforces unique ownership, grants, method allowlist and separate credentials', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'harness-server-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = join(temporary, 'control'), files = await initializeServer({ home });
  await assert.rejects(initializeServer({ home }), /EEXIST/);
  const setup = (await readServerConfig(files.serverPath)).config;
  const clientFile = JSON.parse(await readFile(files.clientPath, 'utf8'));
  const deviceFile = JSON.parse(await readFile(files.devicePairingPath, 'utf8'));
  assert.equal(clientFile.token, setup.clients[0]!.token);
  assert.equal(deviceFile.token, setup.nodes[0]!.token);
  assert.notEqual(clientFile.token, deviceFile.token);
  assert.equal(clientFile.nodes, undefined);
  assert.equal(deviceFile.clients, undefined);
  if (process.platform !== 'win32') for (const path of Object.values(files)) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const a = node(), b = node(), clientA = owner([a.nodeId]), clientB = owner([b.nodeId]);
  const options = { devicePort: 0, clientPort: 0, nodes: [a, b], clients: [clientA, clientB] };
  assert.throws(() => parseServerConfig({ ...options, host: '0.0.0.0' }), /tls_required/);
  assert.throws(() => parseServerConfig({ ...options, clients: [clientA, { ...clientB, nodeIds: [a.nodeId] }] }), /duplicate_node_owner/);
  assert.throws(() => parseServerConfig({ ...options, clients: [{ ...clientA, token: a.token }, clientB] }), /duplicate_token/);
  assert.throws(() => parseServerConfig({ ...options, clients: [clientA] }), /unowned_node/);
  assert.throws(() => parseServerConfig({ ...options, extra: true }), /unknown_config_field/);
  const server = new DockServer(options);
  t.after(() => server.close()); await server.ready;
  assert.deepEqual(await (await fetch(server.clientEndpoint.replace('ws:', 'http:') + 'healthz')).json(), { status: 'ok' });
  const valid = clientHeaders(clientA);
  await rejected(server.clientEndpoint, { ...valid, authorization: `Bearer ${a.token}` });
  await rejected(server.clientEndpoint, { ...valid, [SERVER_PROTOCOL_HEADER]: '999' });
  await rejected(server.clientEndpoint, { ...valid, origin: 'https://example.com' });
  const app = await connect(server.clientEndpoint, valid);
  t.after(() => app.socket.terminate());
  await rejected(server.clientEndpoint, valid);
  await until(() => app.requests.length === 1);
  const snapshot = app.requests[0]!.params;
  assert.deepEqual((snapshot.nodes as { nodeId: string }[]).map(item => item.nodeId), [a.nodeId]);
  assert.ok(!JSON.stringify(snapshot).includes(clientA.token));
  const forbidden = await app.call('node.request', { nodeId: b.nodeId, daemonId: randomUUID(), method: 'execute', params: {}, timeoutMs: 100 });
  assert.equal((forbidden.error as { message: string }).message, 'device_access_denied');
  const method = await app.call('node.request', { nodeId: a.nodeId, daemonId: randomUUID(), method: 'shell', params: {}, timeoutMs: 100 });
  assert.equal((method.error as { message: string }).message, 'unsupported_device_method');
  const sdk = new ServerClient({ endpoint: server.clientEndpoint, ...clientB });
  t.after(() => sdk.close()); await sdk.ready;
  assert.deepEqual(sdk.listNodes().map(item => item.nodeId), [b.nodeId]);
  assert.equal(sdk.node(a.nodeId), undefined);
});

test('remote SDK routes callbacks, aborts obsolete decisions and never replays execution on reconnect', async t => {
  const pairing = node(), application = owner([pairing.nodeId]);
  const server = new DockServer({ nodes: [pairing], clients: [application], devicePort: 0, clientPort: 0 });
  t.after(() => server.close()); await server.ready;
  const first = await device(server.deviceEndpoint, pairing);
  t.after(() => first.socket.terminate());
  const sdk = new ServerClient({ endpoint: server.clientEndpoint, ...application });
  t.after(() => sdk.close()); await sdk.ready;
  const peer = sdk.node(pairing.nodeId)!;
  assert.equal(peer.connected, true);
  const seen: AbortSignal[] = [];
  const unbind = peer.onRequest('execution.callback', async (params, context) => {
    seen.push(context.signal);
    if ((params as { kind: string }).kind === 'permission') {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return 'allow'; // A late approval must be rejected even if a consumer returns it after abort.
    }
    return { nodeId: context.nodeId, daemonId: context.daemonId };
  });
  t.after(unbind);
  const runId = randomUUID();
  const pending = peer.request('execute', { runId });
  const uncertain = assert.rejects(pending, /disconnected|unknown/);
  await until(() => first.requests.length === 1);
  const accepted = await first.call('execution.callback', { runId, kind: 'ready' });
  assert.deepEqual(accepted.result, { nodeId: pairing.nodeId, daemonId: first.daemonId });
  const permission = first.call('execution.callback', { runId, kind: 'permission' });
  await until(() => seen.length === 2);
  sdk.disconnect();
  await uncertain;
  const denied = await permission;
  assert.ok(denied.error, 'disconnect must not deliver late allow');
  await until(() => seen[1]!.aborted && sdk.connected);
  assert.equal(sdk.node(pairing.nodeId), peer);
  assert.equal(first.requests.length, 1, 'reconnect must not dispatch execute again');
  // The daemon can still finish the admitted execution while the caller reconnects and queries it.
  first.reply(first.requests[0]!.id, { state: 'completed', runId });
  const lookup = peer.request('getExecution', { runId });
  await until(() => first.requests.length === 2);
  assert.equal(first.requests[1]!.method, 'getExecution');
  first.reply(first.requests[1]!.id, { state: 'completed', runId });
  assert.deepEqual(await lookup, { state: 'completed', runId });
  const another = first.call('execution.callback', { runId, kind: 'permission' });
  void another;
  await until(() => seen.length === 3);
  first.socket.terminate();
  await until(() => !peer.connected && seen[2]!.aborted);
  const second = await device(server.deviceEndpoint, pairing);
  t.after(() => second.socket.terminate());
  await until(() => peer.connected && peer.daemonId === second.daemonId);
  assert.equal(sdk.node(pairing.nodeId), peer);
  assert.equal(second.requests.length, 0, 'new daemon receives no old prompt or approval');
});
