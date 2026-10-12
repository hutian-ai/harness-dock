import { randomUUID } from 'node:crypto';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import WebSocket from 'ws';
import {
  assertEndpoint, DeviceInboundBudget, DeviceTransport, DEVICE_TRANSPORT_LIMITS,
  DockError, id, type DeviceNodeSummary,
} from '@harness-dock/protocol';
import type { DeviceRequestHandler } from './device-controller.ts';
import {
  nodeSummary, record, rpcTimeout, SERVER_CALLBACK_METHOD, SERVER_DEVICE_METHODS,
  SERVER_MAX_NODES, SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL_VERSION,
} from './server-protocol.ts';

export interface ServerClientOptions {
  endpoint: string;
  clientId: string;
  token: string;
  ca?: string;
  connectTimeoutMs?: number;
}
interface Connection {
  socket: WebSocket;
  rpc: JSONRPCServerAndClient;
  transport: DeviceTransport;
  heartbeat: NodeJS.Timeout;
  serverId?: string;
  sequence: number;
}

/** A remote node is a stable identity; neither reconnection nor a status event dispatches work. */
export class ServerPeer {
  private state: DeviceNodeSummary;
  private readonly handlers = new Map<string, DeviceRequestHandler>();
  constructor(readonly nodeId: string, private readonly owner: ServerClient) {
    this.state = { nodeId, connected: false };
  }
  get label(): string | undefined { return this.state.label; }
  get connected(): boolean { return this.state.connected && this.owner.connected; }
  get daemonId(): string | undefined { return this.state.daemonId; }
  summary(): DeviceNodeSummary { return { ...this.state, connected: this.connected }; }
  request<T>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    return this.owner.request<T>(this, method, params, timeoutMs);
  }
  onRequest(method: string, handler: DeviceRequestHandler): () => void {
    if (method !== SERVER_CALLBACK_METHOD) throw new DockError('unsupported_callback');
    if (this.handlers.has(method)) throw new DockError('device_handler_already_registered');
    this.handlers.set(method, handler);
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); };
  }
  /** Transport hooks, not execution APIs. */
  update(summary: DeviceNodeSummary): void { this.state = summary; }
  async callback(method: string, params: unknown, daemonId: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!this.connected || this.daemonId !== daemonId) throw new DockError('device_connection_expired');
    const handler = this.handlers.get(method);
    if (!handler) throw new DockError('device_callback_unavailable');
    return await handler(params, { nodeId: this.nodeId, daemonId, signal });
  }
}

/** Outbound SDK for the standalone server. Secrets and node grants stay out of its snapshots. */
export class ServerClient {
  private readonly nodes = new Map<string, ServerPeer>();
  private readonly listeners = new Set<(node: DeviceNodeSummary) => void>();
  private readonly inbound = new DeviceInboundBudget();
  private readonly callbacks = new Map<string, { nodeId: string; controller: AbortController }>();
  private connection?: Connection;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private attempts = 0;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readonly initialTimer: NodeJS.Timeout;
  readonly ready: Promise<void>;
  constructor(private readonly options: ServerClientOptions) {
    assertEndpoint(options.endpoint);
    id.parse(options.clientId);
    if (typeof options.token !== 'string' || options.token.length < 32) throw new DockError('weak_token');
    const timeout = options.connectTimeoutMs ?? 20_000;
    rpcTimeout(timeout);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.initialTimer = setTimeout(() => {
      this.rejectReady(new DockError('server_connection_timeout'));
      void this.close();
    }, timeout);
    this.connect();
  }
  get connected(): boolean {
    return Boolean(this.connection?.serverId && this.connection.socket.readyState === WebSocket.OPEN);
  }
  listNodes(): DeviceNodeSummary[] { return [...this.nodes.values()].map(node => node.summary()); }
  node(nodeId: string): ServerPeer | undefined { return this.nodes.get(nodeId); }
  onConnection(listener: (node: DeviceNodeSummary) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(node: ServerPeer): void {
    for (const listener of this.listeners) {
      try { listener(node.summary()); } catch { /* Consumers own their callback failures. */ }
    }
  }
  private update(summary: DeviceNodeSummary): void {
    let node = this.nodes.get(summary.nodeId);
    if (!node) { node = new ServerPeer(summary.nodeId, this); this.nodes.set(summary.nodeId, node); }
    if (!summary.connected || node.daemonId !== summary.daemonId) {
      for (const callback of this.callbacks.values()) if (callback.nodeId === summary.nodeId)
        callback.controller.abort(new DockError('device_connection_expired'));
    }
    node.update(summary);
    this.changed(node);
  }
  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.options.endpoint, {
      headers: { authorization: `Bearer ${this.options.token}`, 'x-dock-client': this.options.clientId,
        [SERVER_PROTOCOL_HEADER]: String(SERVER_PROTOCOL_VERSION) },
      ca: this.options.ca, rejectUnauthorized: true, handshakeTimeout: 10_000,
      maxPayload: DEVICE_TRANSPORT_LIMITS.messageBytes, perMessageDeflate: false,
    });
    const transport = new DeviceTransport(socket, this.inbound);
    const server = new JSONRPCServer({ errorListener: () => {} });
    server.mapErrorToJSONRPCErrorResponse = (requestId, error: unknown) => ({
      jsonrpc: '2.0', id: requestId, error: { code: -32000,
        message: error instanceof DockError ? error.kind : 'device_callback_failed' },
    });
    const client = new JSONRPCClient(payload => transport.send(payload), randomUUID);
    const rpc = new JSONRPCServerAndClient(server, client, { errorListener: () => {} });
    transport.signal.addEventListener('abort', () => {
      rpc.rejectAllPendingRequests('server_disconnected: mutation outcome may be unknown; no automatic replay');
    }, { once: true });
    let alive = true;
    const connection: Connection = { socket, rpc, transport, sequence: -1,
      heartbeat: setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!alive) socket.terminate();
        else { alive = false; socket.ping(); }
      }, 10_000),
    };
    connection.heartbeat.unref();
    this.connection = connection;
    server.addMethod('server.snapshot', params => {
      const snapshot = record(params);
      if (connection.serverId || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > SERVER_MAX_NODES
        || !Number.isSafeInteger(snapshot.sequence) || (snapshot.sequence as number) < 0)
        throw new DockError('invalid_server_snapshot');
      const summaries = snapshot.nodes.map(nodeSummary);
      if (new Set(summaries.map(node => node.nodeId)).size !== summaries.length) throw new DockError('duplicate_node');
      connection.serverId = id.parse(snapshot.serverId);
      connection.sequence = snapshot.sequence as number;
      for (const old of this.nodes.values()) if (!summaries.some(node => node.nodeId === old.nodeId)) {
        this.update({ ...old.summary(), connected: false }); this.nodes.delete(old.nodeId);
      }
      for (const node of summaries) this.update(node);
      this.attempts = 0;
      clearTimeout(this.initialTimer);
      this.resolveReady();
    });
    server.addMethod('server.node', params => {
      const change = record(params);
      if (!connection.serverId || change.serverId !== connection.serverId || !Number.isSafeInteger(change.sequence)
        || (change.sequence as number) <= connection.sequence) throw new DockError('invalid_node_sequence');
      const summary = nodeSummary(change.node);
      if (!this.nodes.has(summary.nodeId)) throw new DockError('ungranted_node');
      connection.sequence = change.sequence as number;
      this.update(summary);
    });
    server.addMethod('server.callback', async params => {
      const call = record(params);
      const nodeId = id.parse(call.nodeId), daemonId = id.parse(call.daemonId), callbackId = id.parse(call.callbackId);
      if (call.method !== SERVER_CALLBACK_METHOD || this.callbacks.has(callbackId)) throw new DockError('invalid_callback');
      const node = this.nodes.get(nodeId);
      if (!node) throw new DockError('ungranted_node');
      const controller = new AbortController();
      this.callbacks.set(callbackId, { nodeId, controller });
      try {
        const signal = AbortSignal.any([transport.signal, controller.signal]);
        const result = await node.callback(call.method, call.params, daemonId, signal);
        signal.throwIfAborted();
        return result;
      } finally { this.callbacks.delete(callbackId); }
    });
    server.addMethod('server.callbackCancelled', params => {
      const call = record(params);
      this.callbacks.get(id.parse(call.callbackId))?.controller.abort(new DockError('device_callback_expired'));
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', data => {
      void transport.receive(data.toString(), message => rpc.receiveAndSend(message)).catch(() => socket.terminate());
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(connection.heartbeat);
      transport.close(new DockError('server_disconnected'));
      rpc.rejectAllPendingRequests('server_disconnected: mutation outcome may be unknown; no automatic replay');
      if (this.connection !== connection) return;
      this.connection = undefined;
      for (const node of this.nodes.values()) this.update({ ...node.summary(), connected: false });
      if (!this.closed) this.retry = setTimeout(() => this.connect(), Math.min(250 * 2 ** Math.min(this.attempts++, 5), 5_000));
    });
  }
  async request<T>(node: ServerPeer, method: string, params: object, timeoutMs: number): Promise<T> {
    const connection = this.connection;
    if (this.nodes.get(node.nodeId) !== node || !node.connected || !connection) throw new DockError('device_disconnected');
    if (!SERVER_DEVICE_METHODS.has(method)) throw new DockError('unsupported_device_method');
    record(params); rpcTimeout(timeoutMs);
    return await connection.transport.request(() => connection.rpc.timeout(timeoutMs + 1_000).request('node.request', {
      nodeId: node.nodeId, daemonId: node.daemonId, method, params, timeoutMs,
    })) as T;
  }
  /** Drop observation transport only. Reconnection does not repeat requests or decisions. */
  disconnect(): void { this.connection?.socket.terminate(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.retry); clearTimeout(this.initialTimer);
    this.rejectReady(new DockError('server_client_closed'));
    const socket = this.connection?.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => { socket.once('close', resolve); socket.terminate(); });
    }
    this.listeners.clear();
  }
}
