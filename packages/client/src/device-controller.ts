import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEVICE_PROTOCOL_HEADER,
  DEVICE_PROTOCOL_VERSION,
  DeviceInboundBudget,
  DeviceTransport,
  deviceTransportLimits,
  DockError,
  id,
  isLoopback,
  type DeviceNodeSummary,
  type DeviceTransportLimits,
} from '@harness-dock/protocol';

/** A callback belongs to the authenticated connection that received it. */
export interface DeviceRequestContext {
  nodeId: string;
  daemonId: string;
  signal: AbortSignal;
}
export type DeviceRequestHandler = (params: unknown, context: DeviceRequestContext) => unknown | Promise<unknown>;

export interface DeviceControllerOptions {
  nodes: readonly { nodeId: string; token: string; label?: string }[];
  host?: string;
  port?: number;
  tls?: { key: string; cert: string };
  transportLimits?: Partial<DeviceTransportLimits>;
}

interface Connection {
  daemonId: string;
  socket: WebSocket;
  rpc: JSONRPCServerAndClient;
  transport: DeviceTransport;
  heartbeat: NodeJS.Timeout;
}

/** A paired node identity stays stable across transport reconnects. */
export class DevicePeer {
  private connection?: Connection;
  private lastDaemonId?: string;
  private readonly handlers = new Map<string, DeviceRequestHandler>();
  private readonly inbound: DeviceInboundBudget;
  constructor(readonly nodeId: string, readonly label?: string, limits?: Partial<DeviceTransportLimits>) {
    this.inbound = new DeviceInboundBudget(limits);
  }
  get daemonId(): string | undefined { return this.connection?.daemonId ?? this.lastDaemonId; }
  get connected(): boolean { return this.connection?.socket.readyState === WebSocket.OPEN; }
  summary(): DeviceNodeSummary {
    return { nodeId: this.nodeId, label: this.label, daemonId: this.daemonId, connected: this.connected };
  }
  async request<T>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    const connection = this.connection;
    if (!connection || !this.connected) throw new DockError('device_disconnected');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new DockError('invalid_timeout');
    // A lost response is never retried: a mutation may already have executed.
    return await connection.transport.request(() => connection.rpc.timeout(timeoutMs).request(method, params)) as T;
  }
  onRequest(method: string, handler: DeviceRequestHandler): () => void {
    if (this.handlers.has(method)) throw new DockError('device_handler_already_registered');
    this.handlers.set(method, handler);
    this.installHandler(method, handler);
    return () => {
      if (this.handlers.get(method) !== handler) return;
      this.handlers.delete(method);
      this.connection?.rpc.removeMethod(method);
    };
  }
  private installHandler(method: string, handler: DeviceRequestHandler): void {
    const connection = this.connection;
    if (!connection) return;
    connection.rpc.addMethod(method, async (params) => {
      connection.transport.signal.throwIfAborted();
      if (this.connection !== connection) throw new DockError('device_connection_expired');
      return await handler(params, {
        nodeId: this.nodeId, daemonId: connection.daemonId, signal: connection.transport.signal,
      });
    });
  }
  /** Controller transport hook; application callers use request/onRequest. */
  attach(socket: WebSocket, daemonId: string, changed: () => void): boolean {
    if (this.connection) return false;
    const server = new JSONRPCServer({ errorListener: () => {} });
    server.mapErrorToJSONRPCErrorResponse = (requestId, error: unknown) => ({
      jsonrpc: '2.0', id: requestId,
      error: { code: -32000, message: error instanceof DockError ? error.kind : 'device_callback_failed' },
    });
    const transport = new DeviceTransport(socket, this.inbound);
    const client = new JSONRPCClient(payload => transport.send(payload), randomUUID);
    const rpc = new JSONRPCServerAndClient(server, client, { errorListener: () => {} });
    transport.signal.addEventListener('abort', () => {
      rpc.rejectAllPendingRequests('device_disconnected: mutation outcome may be unknown; no automatic replay');
    }, { once: true });
    let alive = true;
    const connection: Connection = {
      socket, daemonId, rpc, transport,
      heartbeat: setInterval(() => {
        if (!alive) socket.terminate();
        else { alive = false; socket.ping(); }
      }, 10_000),
    };
    connection.heartbeat.unref();
    this.connection = connection;
    this.lastDaemonId = daemonId;
    for (const [method, handler] of this.handlers) this.installHandler(method, handler);
    socket.on('pong', () => { alive = true; });
    socket.on('message', data => {
      void transport.receive(data.toString(), message => rpc.receiveAndSend(message)).catch(() => {});
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(connection.heartbeat);
      transport.close();
      if (this.connection === connection) {
        this.connection = undefined;
        changed();
      }
    });
    changed();
    return true;
  }
  disconnect(): void { this.connection?.transport.close(); }
}

/** One authenticated listener for every paired device; no Provider dependency. */
export class DeviceController {
  private readonly nodes = new Map<string, DevicePeer>();
  private readonly listeners = new Set<(node: DeviceNodeSummary) => void>();
  private readonly server: WebSocketServer;
  private readonly listener: Server;
  private readonly secure: boolean;
  private closing?: Promise<void>;
  readonly ready: Promise<void>;
  constructor(options: DeviceControllerOptions) {
    const limits = deviceTransportLimits(options.transportLimits);
    const tokens = new Map<string, Buffer>();
    const distinctTokens = new Set<string>();
    for (const entry of options.nodes) {
      id.parse(entry.nodeId);
      if (entry.token.length < 32) throw new DockError('weak_token');
      if (this.nodes.has(entry.nodeId)) throw new DockError('duplicate_node');
      if (distinctTokens.has(entry.token)) throw new DockError('duplicate_node_token');
      this.nodes.set(entry.nodeId, new DevicePeer(entry.nodeId, entry.label, limits));
      tokens.set(entry.nodeId, Buffer.from(`Bearer ${entry.token}`));
      distinctTokens.add(entry.token);
    }
    const host = options.host ?? '127.0.0.1';
    if (!isLoopback(host) && !options.tls) throw new DockError('tls_required');
    this.secure = Boolean(options.tls);
    const notFound = (_request: IncomingMessage, response: import('node:http').ServerResponse) => {
      response.writeHead(404).end();
    };
    this.listener = options.tls
      ? createHttpsServer({ ...options.tls, minVersion: 'TLSv1.2' }, notFound)
      : createHttpServer(notFound);
    this.server = new WebSocketServer({
      server: this.listener, path: '/', maxPayload: limits.messageBytes,
      perMessageDeflate: false,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const nodeId = req.headers['x-dock-node'];
        if (typeof nodeId !== 'string') return false;
        const expected = tokens.get(nodeId);
        const actual = Buffer.from(req.headers.authorization ?? '');
        return !this.closing && req.headers.origin === undefined
          && Boolean(expected && actual.length === expected.length && timingSafeEqual(actual, expected))
          && req.headers[DEVICE_PROTOCOL_HEADER] === String(DEVICE_PROTOCOL_VERSION)
          && id.safeParse(req.headers['x-dock-daemon']).success
          && this.nodes.get(nodeId)?.connected === false;
      },
    });
    this.server.on('connection', (socket, request) => {
      const node = this.nodes.get(request.headers['x-dock-node'] as string);
      if (this.closing || !node?.attach(socket, request.headers['x-dock-daemon'] as string, () => {
        for (const listener of this.listeners) {
          try { listener(node!.summary()); } catch { /* callback failure does not alter transport */ }
        }
      })) socket.close(1008);
    });
    this.ready = new Promise((resolve, reject) => {
      this.listener.once('listening', resolve);
      this.listener.once('error', reject);
    });
    this.listener.listen(options.port ?? 48518, host);
  }
  get endpoint(): string {
    const address = this.listener.address();
    if (!address || typeof address === 'string') throw new DockError('not_listening');
    const host = ['::', '0.0.0.0'].includes(address.address) ? '127.0.0.1' : address.address;
    return `${this.secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${address.port}/`;
  }
  listNodes(): DeviceNodeSummary[] { return [...this.nodes.values()].map(node => node.summary()); }
  node(nodeId: string): DevicePeer | undefined { return this.nodes.get(nodeId); }
  onConnection(listener: (node: DeviceNodeSummary) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      for (const node of this.nodes.values()) node.disconnect();
      await new Promise<void>(resolve => this.server.close(() => resolve()));
      await new Promise<void>(resolve => this.listener.close(() => resolve()));
      this.listeners.clear();
    })();
  }
}
