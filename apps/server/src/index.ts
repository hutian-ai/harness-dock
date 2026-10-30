import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DeviceController, abortable, record, rpcTimeout, SERVER_CALLBACK_METHOD, SERVER_DEVICE_METHODS,
  SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL_VERSION, type DeviceRequestContext,
} from '@harness-dock/client';
import {
  DeviceInboundBudget, DeviceTransport, DEVICE_TRANSPORT_LIMITS, DEVICE_PROTOCOL_VERSION, DockError, id, type DeviceNodeSummary,
} from '@harness-dock/protocol';
import { parseServerConfig, serverConfigRevision, type ServerConfig } from './config.ts';
import { serveInvitation } from './invitation-http.ts';
export { parseServerConfig, readServerConfig, type ServerConfig } from './config.ts';
export { initializeServer, type ServerSetupOptions } from './setup.ts';

export type DockServerOptions = Omit<ServerConfig, 'host' | 'devicePort' | 'clientPort' | 'tls'> & {
  host?: string; devicePort?: number; clientPort?: number; tls?: { key: string; cert: string }; invitationStateDir?: string;
};
interface ClientSlot {
  nodeIds: Set<string>;
  token: Buffer;
  inbound: DeviceInboundBudget;
  connection?: ClientConnection;
}
interface ClientConnection {
  socket: WebSocket;
  rpc: JSONRPCServerAndClient;
  transport: DeviceTransport;
  heartbeat: NodeJS.Timeout;
}

/** One process routes authenticated devices to their explicitly assigned application owner. */
export class DockServer {
  readonly serverId = randomUUID();
  private readonly controller: DeviceController;
  private readonly slots = new Map<string, ClientSlot>();
  private readonly owners = new Map<string, ClientSlot>();
  private readonly listener: Server;
  private readonly sockets: WebSocketServer;
  private readonly secure: boolean;
  private sequence = 0;
  private closing?: Promise<void>;
  readonly ready: Promise<void>;
  constructor(options: DockServerOptions) {
    const { invitationStateDir, ...settings } = options;
    const config = parseServerConfig({ ...settings, tls: options.tls ? { keyFile: 'inline', certFile: 'inline' } : undefined });
    this.secure = Boolean(options.tls);
    for (const client of config.clients) {
      const slot: ClientSlot = { nodeIds: new Set(client.nodeIds), token: Buffer.from(`Bearer ${client.token}`), inbound: new DeviceInboundBudget() };
      this.slots.set(client.clientId, slot);
      for (const nodeId of client.nodeIds) this.owners.set(nodeId, slot);
    }
    this.controller = new DeviceController({ nodes: config.nodes, host: config.host, port: config.devicePort, tls: options.tls });
    for (const node of this.controller.listNodes()) {
      this.controller.node(node.nodeId)!.onRequest(SERVER_CALLBACK_METHOD, (params, context) => this.callback(params, context));
    }
    this.controller.onConnection(node => {
      const slot = this.owners.get(node.nodeId)!;
      const payload = { serverId: this.serverId, sequence: ++this.sequence, node };
      if (slot.connection) void this.notify(slot.connection, 'server.node', payload).catch(() => {});
    });
    const health = { version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      deviceProtocol: DEVICE_PROTOCOL_VERSION, serverProtocol: SERVER_PROTOCOL_VERSION, configRevision: serverConfigRevision(config) };
    const handle = (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(this.closing ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: this.closing ? 'stopping' : 'ok', ...health }));
      } else if (!this.closing && serveInvitation(request, response, config, invitationStateDir)) return;
      else response.writeHead(404).end();
    };
    this.listener = options.tls
      ? createHttpsServer({ ...options.tls, minVersion: 'TLSv1.2' }, handle)
      : createHttpServer(handle);
    this.sockets = new WebSocketServer({ server: this.listener, path: '/',
      maxPayload: DEVICE_TRANSPORT_LIMITS.messageBytes, perMessageDeflate: false,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const clientId = req.headers['x-dock-client'];
        const slot = typeof clientId === 'string' ? this.slots.get(clientId) : undefined;
        const actual = Buffer.from(req.headers.authorization ?? '');
        return !this.closing && !slot?.connection && req.headers.origin === undefined
          && req.headers[SERVER_PROTOCOL_HEADER] === String(SERVER_PROTOCOL_VERSION)
          && Boolean(slot && actual.length === slot.token.length && timingSafeEqual(actual, slot.token));
      },
    });
    this.sockets.on('connection', (socket, request) => {
      const slot = this.slots.get(request.headers['x-dock-client'] as string);
      if (!slot || slot.connection || this.closing) { socket.close(1008); return; }
      this.attach(slot, socket);
    });
    const listening = new Promise<void>((resolve, reject) => {
      this.listener.once('listening', resolve); this.listener.once('error', reject);
    });
    this.listener.listen(config.clientPort, config.host);
    this.ready = Promise.all([this.controller.ready, listening]).then(() => {}, async error => {
      await this.close(); throw error;
    });
  }
  get deviceEndpoint(): string { return this.controller.endpoint; }
  get clientEndpoint(): string {
    const address = this.listener.address();
    if (!address || typeof address === 'string') throw new DockError('not_listening');
    const host = ['::', '0.0.0.0'].includes(address.address) ? '127.0.0.1' : address.address;
    return `${this.secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${address.port}/`;
  }
  private snapshot(slot: ClientSlot): DeviceNodeSummary[] {
    return [...slot.nodeIds].map(nodeId => this.controller.node(nodeId)!.summary());
  }
  private notify(connection: ClientConnection, method: string, params: object): Promise<void> {
    return connection.transport.send({ jsonrpc: '2.0', method, params });
  }
  private attach(slot: ClientSlot, socket: WebSocket): void {
    const transport = new DeviceTransport(socket, slot.inbound);
    const server = new JSONRPCServer({ errorListener: () => {} });
    server.mapErrorToJSONRPCErrorResponse = (requestId, error: unknown) => ({
      jsonrpc: '2.0', id: requestId, error: { code: -32000,
        message: error instanceof DockError ? error.kind
          : error instanceof Error && (/^[a-z_]+$/.test(error.message) || /^resource_exhausted:(managed_state_bytes|persistence_unconfirmed)$/.test(error.message)) ? error.message
            : error instanceof Error && error.message.startsWith('unresolved_execution:') ? 'unresolved_execution' : 'device_request_failed' },
    });
    const client = new JSONRPCClient(payload => transport.send(payload), randomUUID);
    const rpc = new JSONRPCServerAndClient(server, client, { errorListener: () => {} });
    transport.signal.addEventListener('abort', () => rpc.rejectAllPendingRequests('application_disconnected'), { once: true });
    let alive = true;
    const connection: ClientConnection = { socket, rpc, transport,
      heartbeat: setInterval(() => {
        if (!alive) socket.terminate(); else { alive = false; socket.ping(); }
      }, 10_000),
    };
    connection.heartbeat.unref(); slot.connection = connection;
    server.addMethod('node.request', async params => {
      transport.signal.throwIfAborted();
      const call = record(params), nodeId = id.parse(call.nodeId);
      if (!slot.nodeIds.has(nodeId)) throw new DockError('device_access_denied');
      if (typeof call.method !== 'string' || !SERVER_DEVICE_METHODS.has(call.method)) throw new DockError('unsupported_device_method');
      const payload = record(call.params), timeoutMs = rpcTimeout(call.timeoutMs);
      const node = this.controller.node(nodeId)!;
      if (!node.connected || node.daemonId !== id.parse(call.daemonId)) throw new DockError('device_connection_expired');
      // The device retains execution ownership when this client's transport disappears.
      // Method and node grants were checked above; the relay does not project a
      // provider-specific response or invent a compile-time response type.
      return await node.request<unknown>(call.method, payload, timeoutMs);
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', data => {
      void transport.receive(data.toString(), payload => rpc.receiveAndSend(payload)).catch(() => socket.terminate());
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(connection.heartbeat); transport.close(new DockError('application_disconnected'));
      rpc.rejectAllPendingRequests('application_disconnected');
      if (slot.connection === connection) slot.connection = undefined;
    });
    void this.notify(connection, 'server.snapshot', {
      serverId: this.serverId, sequence: this.sequence, nodes: this.snapshot(slot),
    }).catch(() => {});
  }
  private async callback(params: unknown, context: DeviceRequestContext): Promise<unknown> {
    const slot = this.owners.get(context.nodeId), connection = slot?.connection;
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) throw new DockError('application_disconnected');
    const payload = record(params), callbackId = randomUUID();
    const timeoutMs = payload.kind === 'permission' ? 30 * 60_000 : payload.kind === 'toolCall' ? 5 * 60_000 : 30_000;
    const signal = AbortSignal.any([context.signal, connection.transport.signal]);
    let completed = false;
    try {
      const pending = connection.transport.request(() => connection.rpc.timeout(timeoutMs).request('server.callback', {
        nodeId: context.nodeId, daemonId: context.daemonId, method: SERVER_CALLBACK_METHOD, params, callbackId,
      }));
      const result = await abortable(pending, signal);
      signal.throwIfAborted();
      if (slot?.connection !== connection) throw new DockError('application_connection_expired');
      completed = true;
      return result;
    } finally {
      if (!completed && !connection.transport.signal.aborted) {
        void this.notify(connection, 'server.callbackCancelled', { callbackId }).catch(() => {});
      }
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      for (const slot of this.slots.values()) slot.connection?.socket.terminate();
      await this.controller.close();
      await new Promise<void>(resolve => this.sockets.close(() => resolve()));
      await new Promise<void>(resolve => this.listener.close(() => resolve()));
    })();
  }
}
