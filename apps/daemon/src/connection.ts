import WebSocket from 'ws';
import { JSONRPCServer } from 'json-rpc-2.0';
import {
  assertEndpoint,
  DockError,
  permissionSchema,
  listSchema,
  runSchema,
  startSchema,
  VERSION,
} from '@harness-dock/protocol';
import type { Engine } from './engine.ts';

export class DaemonConnection {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private attempts = 0;
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  constructor(
    private readonly engine: Engine,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly tls: { ca?: string; } = {},
  ) {
    assertEndpoint(endpoint);
  }
  connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.endpoint, {
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-dock-daemon': this.engine.daemonId,
        'x-dock-node': this.engine.nodeId,
        'x-dock-version': VERSION,
      },
      maxPayload: 8 * 1024 * 1024,
      ca: this.tls.ca,
      rejectUnauthorized: true,
    });
    this.socket = socket;
    const subscribed = new Set<string>();
    const server = new JSONRPCServer({ errorListener: () => { } });
    server.mapErrorToJSONRPCErrorResponse = (id, error: unknown) => ({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error instanceof DockError ? error.kind : 'invalid_request_or_driver_error',
      },
    });
    server.addMethod('listRuns', (params) => {
      const { limit, offset } = listSchema.parse(params);
      return this.engine.listRuns(limit, offset);
    });
    server.addMethod('probe', () => this.engine.probe());
    server.addMethod('start', (params) => this.engine.start(startSchema.parse(params)));
    server.addMethod('getRun', (params) => this.engine.getRun(runSchema.parse(params).runId));
    server.addMethod('subscribe', (params) => {
      const { runId } = runSchema.parse(params);
      const snapshot = this.engine.getRun(runId);
      subscribed.add(runId);
      return snapshot;
    });
    server.addMethod('unsubscribe', (params) => {
      subscribed.delete(runSchema.parse(params).runId);
      return null;
    });
    server.addMethod('respondPermission', (params) =>
      this.engine.respondPermission(permissionSchema.parse(params)),
    );
    server.addMethod('cancel', (params) => this.engine.cancel(runSchema.parse(params).runId));
    const remove = this.engine.onEvent((event) => {
      if (subscribed.has(event.runId) && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'run.event', params: event }));
    });
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('open', () => {
      this.attempts = 0;
      this.heartbeat = setInterval(() => {
        if (!alive) socket.terminate();
        else {
          alive = false;
          socket.ping();
        }
      }, 10_000);
    });
    socket.on('message', (data) => {
      void Promise.resolve(server.receiveJSON(data.toString()))
        .then((response) => {
          if (response && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify(response));
        })
        .catch(() => socket.close(1002));
    });
    socket.on('error', (error) => {
      if (this.attempts === 0) console.error(`Controller connection failed: ${error.message}`);
    });
    socket.on('close', () => {
      remove();
      clearInterval(this.heartbeat);
      if (!this.stopped)
        this.timer = setTimeout(() => this.connect(), Math.min(200 * 2 ** this.attempts++, 3000));
    });
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}
