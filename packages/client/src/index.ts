import { randomUUID, timingSafeEqual } from 'node:crypto';
export { DeviceController, DevicePeer, type DeviceControllerOptions, type DeviceRequestContext, type DeviceRequestHandler } from './device-controller.ts';
export { ServerClient, ServerPeer, type ServerClientOptions } from './server-client.ts';
export * from './server-protocol.ts';
export type { DeviceNodeSummary } from '@harness-dock/protocol';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { JSONRPCClient } from 'json-rpc-2.0';
import {
  applyEvent,
  DockError,
  id,
  isLoopback,
  terminal,
  VERSION,
  type Observation,
  type PermissionInput,
  type Probe,
  type RunEvent,
  type RunSummary,
  type RunSnapshot,
  type StartInput,
} from '@harness-dock/protocol';

export { DockError };
export type {
  CompletedMessage, Decision, Observation, OutputEvent, Permission, PermissionInput,
  Probe, RunEvent, RunSnapshot, RunState, RunSummary, StartInput,
} from '@harness-dock/protocol';

interface Peer {
  daemonId: string;
  socket: WebSocket;
  rpc: JSONRPCClient;
}
export interface DockClientOptions {
  token: string;
  nodeId: string;
  host?: string;
  port?: number;
  tls?: { key: string; cert: string; };
}
interface Watch {
  listeners: Set<(observation: Observation) => void>;
  buffer?: RunEvent[];
}
export class DockClient {
  private readonly server: WebSocketServer;
  private readonly listener: Server;
  private readonly secure: boolean;
  private peer?: Peer;
  private readonly watches = new Map<string, Watch>();
  private readonly cache = new Map<string, RunSnapshot>();
  private readonly dispatched = new Map<string, string>();
  private readonly connections = new EventEmitter();
  private closed = false;
  readonly ready: Promise<void>;
  constructor(options: DockClientOptions) {
    if (options.token.length < 32) throw new DockError('weak_token');
    id.parse(options.nodeId);
    const host = options.host ?? '127.0.0.1';
    if (!isLoopback(host) && !options.tls) throw new DockError('tls_required');
    this.secure = Boolean(options.tls);
    const notFound = (_req: IncomingMessage, res: import('node:http').ServerResponse) => {
      res.writeHead(404).end();
    };
    this.listener = options.tls
      ? createHttpsServer({ ...options.tls, minVersion: 'TLSv1.2' }, notFound)
      : createHttpServer(notFound);
    this.server = new WebSocketServer({
      server: this.listener,
      path: '/',
      maxPayload: 8 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage; }) => {
        const actual = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${options.token}`);
        return (
          !req.headers.origin &&
          !this.peer &&
          actual.length === expected.length &&
          timingSafeEqual(actual, expected) &&
          req.headers['x-dock-version'] === String(VERSION) &&
          req.headers['x-dock-node'] === options.nodeId &&
          id.safeParse(req.headers['x-dock-daemon']).success
        );
      },
    });
    this.ready = new Promise((resolve, reject) => {
      this.listener.once('listening', resolve);
      this.listener.once('error', reject);
    });
    this.server.on('connection', (socket, request) =>
      this.attach(socket, request.headers['x-dock-daemon'] as string),
    );
    this.listener.listen(options.port ?? 48517, host);
  }
  get endpoint(): string {
    const address = this.listener.address();
    if (!address || typeof address === 'string') throw new DockError('not_listening');
    const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
    return `${this.secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${address.port}/`;
  }
  get connected(): boolean {
    return this.peer?.socket.readyState === WebSocket.OPEN;
  }
  async waitForConnection(timeoutMs = 20_000): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.connections.off('connected', done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.connections.off('connected', done);
        reject(new DockError('connection_timeout'));
      }, timeoutMs);
      this.connections.on('connected', done);
    });
  }
  private attach(socket: WebSocket, daemonId: string): void {
    if (this.closed || this.peer) {
      socket.close();
      return;
    }
    const rpc = new JSONRPCClient((payload) => {
      if (socket.readyState !== WebSocket.OPEN) throw new DockError('connection_lost');
      socket.send(JSON.stringify(payload));
    }, randomUUID);
    const peer = { socket, daemonId, rpc };
    this.peer = peer;
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.method === 'run.event') {
          const event = message.params as RunEvent;
          if (event.daemonId !== daemonId) throw new DockError('daemon_mismatch');
          const watch = this.watches.get(event.runId);
          if (watch?.buffer) watch.buffer.push(event);
          else this.deliver(event);
        } else rpc.receive(message);
      } catch {
        socket.close(1002);
      }
    });
    socket.on('error', () => { });
    socket.on('close', () => {
      rpc.rejectAllPendingRequests(
        'connection_lost: mutation outcome may be unknown; query before deciding',
      );
      if (this.peer !== peer) return;
      this.peer = undefined;
      for (const [runId, watch] of this.watches) {
        watch.buffer = [];
        this.notify(runId, { type: 'connection', connected: false });
        const snapshot = this.cache.get(runId);
        if (snapshot) this.notify(runId, { type: 'snapshot', snapshot: this.unknown(snapshot) });
      }
    });
    for (const [runId, watch] of this.watches) {
      watch.buffer = [];
      void this.restore(runId, peer).catch(() => { });
    }
    this.connections.emit('connected');
  }
  private notify(runId: string, observation: Observation): void {
    for (const listener of this.watches.get(runId)?.listeners ?? []) {
      // A UI callback must not break protocol processing or another subscriber.
      try {
        listener(structuredClone(observation));
      } catch {
        /* consumer owns its errors */
      }
    }
  }
  private unknown(snapshot: RunSnapshot): RunSnapshot {
    return terminal(snapshot.state)
      ? structuredClone(snapshot)
      : {
        ...structuredClone(snapshot),
        state: 'outcome_unknown',
        permissions: [],
        error: 'Daemon unavailable; completion unconfirmed. No automatic replay.',
      };
  }
  private deliver(event: RunEvent): void {
    const snapshot = this.cache.get(event.runId);
    if (!snapshot || event.sequence <= snapshot.sequence) return;
    applyEvent(snapshot, event);
    this.notify(event.runId, { type: 'event', event });
  }
  private async request<T>(method: string, params: object = {}, peer = this.peer): Promise<T> {
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) throw new DockError('disconnected');
    return (await peer.rpc.timeout(30_000).request(method, params)) as T;
  }
  async probe(): Promise<Probe> {
    return this.request('probe');
  }
  async listRuns(options: { limit?: number; offset?: number; } = {}): Promise<RunSummary[]> {
    return this.request('listRuns', options);
  }
  async start(input: StartInput): Promise<RunSnapshot> {
    const peer = this.peer;
    const owner = this.dispatched.get(input.runId) ?? this.cache.get(input.runId)?.daemonId;
    if (owner && owner !== peer?.daemonId)
      throw new DockError(
        'outcome_unknown',
        'The original daemon is unavailable; do not replay this run',
      );
    if (peer) this.dispatched.set(input.runId, peer.daemonId);
    const snapshot = await this.request<RunSnapshot>('start', input, peer);
    this.remember(snapshot);
    return snapshot;
  }
  private remember(snapshot: RunSnapshot): void {
    const previous = this.cache.get(snapshot.runId);
    if (!previous || snapshot.sequence >= previous.sequence)
      this.cache.set(snapshot.runId, structuredClone(snapshot));
  }
  async getRun(runId: string): Promise<RunSnapshot> {
    const cached = this.cache.get(runId);
    if (cached && !this.connected)
      return this.unknown(cached);
    const owner = this.dispatched.get(runId);
    if (owner && !this.connected)
      throw new DockError('outcome_unknown');
    let snapshot: RunSnapshot;
    try { snapshot = await this.request<RunSnapshot>('getRun', { runId }); }
    catch (error) {
      if (cached && cached.daemonId !== this.peer?.daemonId) return this.unknown(cached);
      throw error;
    }
    this.remember(snapshot);
    return snapshot;
  }
  private async restore(runId: string, peer: Peer): Promise<void> {
    const watch = this.watches.get(runId);
    if (!watch) return;
    const cached = this.cache.get(runId);
    let snapshot: RunSnapshot;
    try { snapshot = await this.request<RunSnapshot>('subscribe', { runId }, peer); }
    catch (error) {
      if (cached && cached.daemonId !== peer.daemonId) {
        this.notify(runId, { type: 'snapshot', snapshot: this.unknown(cached) });
        return;
      }
      throw error;
    }
    if (this.peer !== peer || this.watches.get(runId) !== watch) return;
    this.cache.set(runId, structuredClone(snapshot));
    this.notify(runId, { type: 'snapshot', snapshot });
    const buffered = watch.buffer ?? [];
    watch.buffer = undefined;
    for (const event of buffered) this.deliver(event);
    this.notify(runId, { type: 'connection', connected: true });
  }
  async subscribe(
    runId: string,
    listener: (observation: Observation) => void,
  ): Promise<() => void> {
    let watch = this.watches.get(runId);
    if (!watch) {
      watch = { listeners: new Set(), buffer: [] };
      this.watches.set(runId, watch);
    }
    const first = watch.listeners.size === 0;
    watch.listeners.add(listener);
    try {
      if (first && this.peer && this.connected) await this.restore(runId, this.peer);
      else {
        const snapshot = this.cache.get(runId);
        if (snapshot)
          listener({
            type: 'snapshot',
            snapshot:
              this.peer?.daemonId === snapshot.daemonId
                ? structuredClone(snapshot)
                : this.unknown(snapshot),
          });
        else if (!this.peer) throw new DockError('disconnected');
      }
    } catch (error) {
      watch.listeners.delete(listener);
      if (watch.listeners.size === 0) this.watches.delete(runId);
      throw error;
    }
    return () => {
      watch.listeners.delete(listener);
      if (watch.listeners.size === 0) {
        this.watches.delete(runId);
        if (this.peer) void this.request('unsubscribe', { runId }).catch(() => { });
      }
    };
  }
  private assertOwner(runId: string): void {
    const snapshot = this.cache.get(runId);
    if (snapshot && snapshot.daemonId !== this.peer?.daemonId)
      throw new DockError('outcome_unknown');
  }
  async respondPermission(input: PermissionInput): Promise<RunSnapshot> {
    this.assertOwner(input.runId);
    return this.request('respondPermission', input);
  }
  async cancel(runId: string): Promise<RunSnapshot> {
    this.assertOwner(runId);
    return this.request('cancel', { runId });
  }
  /** Drops only transport, useful for manual recovery experiments. */
  disconnect(): void {
    this.peer?.socket.terminate();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.peer?.socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
  }
}
