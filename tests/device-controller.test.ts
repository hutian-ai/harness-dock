import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DeviceController } from '../packages/client/src/device-controller.ts';
import { DEVICE_PROTOCOL_HEADER, DEVICE_PROTOCOL_VERSION } from '../packages/protocol/src/device.ts';
import { DeviceInboundBudget, DeviceTransport } from '../packages/protocol/src/device-limits.ts';

const paired = () => ({ nodeId: randomUUID(), token: randomBytes(32).toString('hex') });
const headers = (node: ReturnType<typeof paired>, daemonId = randomUUID()) => ({
  authorization: `Bearer ${node.token}`, 'x-dock-node': node.nodeId, 'x-dock-daemon': daemonId,
  [DEVICE_PROTOCOL_HEADER]: String(DEVICE_PROTOCOL_VERSION),
});
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(5); }
}
async function rejected(endpoint: string, requestHeaders: Record<string, string>) {
  const socket = new WebSocket(endpoint, { headers: requestHeaders });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', () => resolve());
    socket.once('open', () => { socket.terminate(); reject(new Error('unexpected authentication')); });
  });
}
async function connect(endpoint: string, node: ReturnType<typeof paired>, daemonId = randomUUID()) {
  const socket = new WebSocket(endpoint, { headers: headers(node, daemonId) });
  const requests: { id: string; method: string; params: Record<string, unknown> }[] = [];
  const callbacks = new Map<string, (value: Record<string, unknown>) => void>();
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.method) requests.push(message);
    else { callbacks.get(message.id)?.(message); callbacks.delete(message.id); }
  });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket, daemonId, requests,
    reply(id: string, result: unknown) { socket.send(JSON.stringify({ jsonrpc: '2.0', id, result })); },
    callback(method: string, params: object) {
      const id = randomUUID();
      const response = new Promise<Record<string, unknown>>(resolve => callbacks.set(id, resolve));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return response;
    },
  };
}

test('device listener pins credentials and identity while serving two independent nodes', async t => {
  const a = paired(), b = paired();
  assert.throws(() => new DeviceController({ nodes: [a], host: '0.0.0.0' }), /tls_required/);
  assert.throws(() => new DeviceController({ nodes: [a, { ...b, token: a.token }] }), /duplicate_node_token/);
  const controller = new DeviceController({ nodes: [a, b], port: 0 });
  t.after(() => controller.close());
  await controller.ready;
  const valid = headers(a);
  await rejected(controller.endpoint, { ...valid, authorization: `Bearer ${b.token}` });
  await rejected(controller.endpoint, { ...valid, 'x-dock-node': randomUUID() });
  await rejected(controller.endpoint, { ...valid, [DEVICE_PROTOCOL_HEADER]: '999' });
  await rejected(controller.endpoint, { ...valid, origin: 'https://example.com' });
  assert.equal(controller.listNodes().filter(node => node.connected).length, 0);
  const deviceA = await connect(controller.endpoint, a), deviceB = await connect(controller.endpoint, b);
  t.after(() => { deviceA.socket.terminate(); deviceB.socket.terminate(); });
  await rejected(controller.endpoint, headers(a));
  const peerA = controller.node(a.nodeId)!, peerB = controller.node(b.nodeId)!;
  const callbackNodes: string[] = [];
  peerA.onRequest('execution.callback', async (params, context) => {
    callbackNodes.push(context.nodeId);
    return { received: params, daemonId: context.daemonId };
  });
  peerB.onRequest('execution.callback', (_params, context) => ({ node: context.nodeId }));
  const requestA = peerA.request('inventory'), requestB = peerB.request('inventory');
  await until(() => deviceA.requests.length === 1 && deviceB.requests.length === 1);
  // Reverse callbacks are independent of in-flight controller requests.
  const callbackA = await deviceA.callback('execution.callback', { runId: 'a', kind: 'admit' });
  const callbackB = await deviceB.callback('execution.callback', { runId: 'b', kind: 'admit' });
  assert.deepEqual(callbackNodes, [a.nodeId]);
  assert.equal((callbackA.result as Record<string, unknown>).daemonId, deviceA.daemonId);
  assert.deepEqual(callbackB.result, { node: b.nodeId });
  deviceB.reply(deviceB.requests[0]!.id, { provider: 'b' });
  deviceA.reply(deviceA.requests[0]!.id, { provider: 'a' });
  assert.deepEqual(await requestA, { provider: 'a' });
  assert.deepEqual(await requestB, { provider: 'b' });
  assert.equal(controller.listNodes().filter(node => node.connected).length, 2);
});

test('device disconnect aborts callbacks and rejects uncertain mutations without replay', async t => {
  const pairing = paired();
  const controller = new DeviceController({ nodes: [pairing], port: 0 });
  t.after(() => controller.close());
  await controller.ready;
  const connectionStates: boolean[] = [];
  controller.onConnection(node => connectionStates.push(node.connected));
  const peer = controller.node(pairing.nodeId)!;
  let callbackSignal: AbortSignal | undefined;
  peer.onRequest('execution.callback', (_params, context) => {
    callbackSignal = context.signal;
    return { daemonId: context.daemonId };
  });
  const first = await connect(controller.endpoint, pairing);
  await first.callback('execution.callback', {});
  const mutation = peer.request('execute', { provider: 'codex', runId: randomUUID(), prompt: 'synthetic' });
  const rejectedMutation = assert.rejects(mutation, /outcome may be unknown/);
  await until(() => first.requests.length === 1);
  first.socket.terminate();
  await rejectedMutation;
  await until(() => !peer.connected);
  assert.equal(callbackSignal?.aborted, true);
  assert.equal(controller.listNodes()[0]!.connected, false);
  assert.equal(controller.listNodes()[0]!.daemonId, first.daemonId);
  const second = await connect(controller.endpoint, pairing);
  t.after(() => second.socket.terminate());
  assert.equal(controller.node(pairing.nodeId), peer);
  assert.deepEqual((await second.callback('execution.callback', {})).result, { daemonId: second.daemonId });
  assert.equal(second.requests.length, 0, 'no execute or callback is resubmitted on reconnect');
  const timedOut = peer.request('inventory', {}, 20);
  await assert.rejects(timedOut, /timeout/i);
  assert.equal(second.requests.length, 1);
  assert.deepEqual(connectionStates, [true, false, true]);
});

test('pending overload disconnects only that device and never replays its mutations', async t => {
  const a = paired(), b = paired();
  const controller = new DeviceController({ nodes: [a, b], port: 0, transportLimits: { pendingRequests: 2 } });
  t.after(() => controller.close());
  await controller.ready;
  const first = await connect(controller.endpoint, a), other = await connect(controller.endpoint, b);
  t.after(() => { first.socket.terminate(); other.socket.terminate(); });
  const peer = controller.node(a.nodeId)!;
  const requests = [peer.request('execute', { provider: 'codex', runId: 'one', prompt: 'synthetic' }), peer.request('execute', { provider: 'codex', runId: 'two', prompt: 'synthetic' })];
  const settled = Promise.allSettled(requests);
  await until(() => first.requests.length === 2);
  await assert.rejects(peer.request('execute', { provider: 'codex', runId: 'three', prompt: 'synthetic' }), /device_pending_limit/);
  assert.ok((await settled).every(result => result.status === 'rejected' && /outcome may be unknown/.test(String(result.reason))));
  await until(() => !peer.connected);
  const healthy = controller.node(b.nodeId)!.request('inventory');
  await until(() => other.requests.length === 1);
  other.reply(other.requests[0]!.id, { healthy: true });
  assert.deepEqual(await healthy, { healthy: true });
  const reconnected = await connect(controller.endpoint, a);
  t.after(() => reconnected.socket.terminate());
  assert.equal(reconnected.requests.length, 0);
});

test('responses bypass handler quota and unfinished callbacks keep quota across reconnect', async t => {
  const node = paired();
  const controller = new DeviceController({ nodes: [node], port: 0, transportLimits: { incomingHandlers: 1 } });
  t.after(() => controller.close());
  await controller.ready;
  const peer = controller.node(node.nodeId)!;
  let started = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  peer.onRequest('hold', async () => { started++; await held; return true; });
  peer.onRequest('ping', () => 'pong');
  const first = await connect(controller.endpoint, node);
  t.after(() => { release(); first.socket.terminate(); });
  void first.callback('hold', {});
  await until(() => started === 1);
  const inventory = peer.request('inventory');
  await until(() => first.requests.length === 1);
  first.reply(first.requests[0]!.id, { ready: true });
  assert.deepEqual(await inventory, { ready: true }, 'response is not blocked behind held callback');
  first.socket.terminate();
  await until(() => !peer.connected);
  const second = await connect(controller.endpoint, node);
  t.after(() => second.socket.terminate());
  void second.callback('hold', {});
  await until(() => !peer.connected);
  assert.equal(started, 1, 'old callback keeps reservation and second never enters handler');
  release();
  // Drain the already-settling handler, JSON-RPC response and transport finalizers.
  await new Promise<void>(resolve => setImmediate(resolve));
  const third = await connect(controller.endpoint, node);
  t.after(() => third.socket.terminate());
  assert.equal((await third.callback('ping', {})).result, 'pong');
});

test('transport caps queued sends and terminates stalled writes with no retained pending wait', async () => {
  const socket = () => ({
    readyState: 1, bufferedAmount: 0, sent: [] as string[],
    send(value: string, _callback: (error?: Error) => void) { this.sent.push(value); },
    terminate() { this.readyState = 3; },
  });
  const slow = socket();
  const transport = new DeviceTransport(slow, new DeviceInboundBudget({ outgoingBytes: 32, sendTimeoutMs: 1_000 }));
  const first = transport.send({ text: '1234567890' });
  const rejectedFirst = assert.rejects(first, /device_send_limit/);
  await assert.rejects(transport.send({ text: '1234567890' }), /device_send_limit/);
  await rejectedFirst;
  assert.equal(slow.sent.length, 1);
  assert.equal(slow.readyState, 3);
  const stalled = socket();
  const timeout = new DeviceTransport(stalled, new DeviceInboundBudget({ sendTimeoutMs: 10 }));
  await assert.rejects(timeout.request(() => timeout.send({ method: 'permission' })), /device_send_timeout/);
  assert.equal(stalled.readyState, 3);
  assert.equal(timeout.signal.aborted, true);
});

test('transport enforces aggregate inbound bytes and does not dispatch JSON-RPC batches', async () => {
  const socket = { readyState: 1, bufferedAmount: 0, send() {}, terminate() { this.readyState = 3; } };
  const transport = new DeviceTransport(socket, new DeviceInboundBudget({ incomingBytes: 50 }));
  let release!: () => void, dispatches = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = transport.receive('{"method":"hold","params":{}}', async () => { dispatches++; await held; });
  await assert.rejects(transport.receive('{"method":"hold","params":{}}', async () => { dispatches++; }), /device_inbound_limit/);
  assert.equal(dispatches, 1);
  release(); await first;
  const batchSocket = { ...socket, readyState: 1 };
  const batch = new DeviceTransport(batchSocket, new DeviceInboundBudget());
  await assert.rejects(batch.receive('[{"method":"hold"}]', async () => { dispatches++; }), /invalid_rpc_message/);
  assert.equal(dispatches, 1);
});

test('transport still carries the maximum prepared file payload', async () => {
  const socket = {
    readyState: 1, bufferedAmount: 0, sentBytes: 0,
    send(text: string, callback: (error?: Error) => void) { this.sentBytes = Buffer.byteLength(text); callback(); },
    terminate() { this.readyState = 3; },
  };
  const transport = new DeviceTransport(socket, new DeviceInboundBudget());
  const contentBase64 = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  await transport.send({ jsonrpc: '2.0', id: 'large', method: 'prepare', params: {
    files: [{ path: 'a', contentBase64 }, { path: 'b', contentBase64 }],
  } });
  assert.ok(socket.sentBytes > 21 * 1024 * 1024);
  assert.equal(socket.readyState, 1);
  transport.close();
});
