import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import { assertEndpoint, DEVICE_PROTOCOL_HEADER, DEVICE_PROTOCOL_VERSION, DeviceInboundBudget, DeviceTransport, diagnosticError } from '@harness-dock/protocol';
import type { DeviceConfig } from './config.ts';
import { DeviceHost } from './device-host.ts';
import { serveControl } from './local-control.ts';
import { daemonEnvironment } from './provider-environment.ts';

/** Outbound connection recovery restores observation; it never replays requests. */
export class DeviceConnection {
  #socket?: WebSocket;
  #timer?: NodeJS.Timeout;
  #heartbeat?: NodeJS.Timeout;
  #transport?: DeviceTransport;
  readonly #inbound = new DeviceInboundBudget();
  #stopped = false;
  #attempts = 0;
  connectionError?: string;
  constructor(readonly host: DeviceHost, readonly config: DeviceConfig, readonly ca?: string) { assertEndpoint(config.endpoint); }
  get connected() { return this.#socket?.readyState === WebSocket.OPEN; }
  connect(): void {
    if (this.#stopped || this.#socket && this.#socket.readyState !== WebSocket.CLOSED) return;
    const socket = new WebSocket(this.config.endpoint, { headers: {
      authorization: `Bearer ${this.config.token}`, 'x-dock-node': this.host.nodeId,
      'x-dock-daemon': this.host.daemonId, [DEVICE_PROTOCOL_HEADER]: String(DEVICE_PROTOCOL_VERSION),
    }, maxPayload: this.#inbound.limits.messageBytes, perMessageDeflate: false, ca: this.ca, rejectUnauthorized: true });
    this.#socket = socket;
    const transport = new DeviceTransport(socket, this.#inbound);
    this.#transport = transport;
    const client = new JSONRPCClient(request => transport.send(request));
    const server = new JSONRPCServer({ errorListener: () => {} });
    server.mapErrorToJSONRPCErrorResponse = (id, error: unknown) => ({ jsonrpc: '2.0', id,
      error: { code: -32000, message: error instanceof Error ? error.message : 'device_error' } });
    const peer = new JSONRPCServerAndClient(server, client);
    const runId = (params: unknown) => {
      if (!params || typeof params !== 'object' || !('runId' in params) || typeof params.runId !== 'string') throw new Error('invalid_run_id');
      return params.runId;
    };
    server.addMethod('inventory', params => this.host.inventory(params?.refresh === true));
    server.addMethod('prepare', params => this.host.prepare(params));
    server.addMethod('execute', params => this.host.execute(params));
    server.addMethod('getExecution', params => this.host.getExecution(runId(params)));
    server.addMethod('events', params => this.host.events(runId(params), params.after ?? 0));
    server.addMethod('reconcile', params => this.host.reconcile(runId(params)));
    server.addMethod('cancel', params => this.host.cancel(runId(params)));
    server.addMethod('steer', params => this.host.steer(runId(params), params.text));
    server.addMethod('collect', params => this.host.collect(runId(params)));
    server.addMethod('release', params => this.host.release(runId(params)));
    server.addMethod('forgetSession', params => {
      if (typeof params?.sessionKey !== 'string') throw new Error('invalid_session_key');
      return this.host.forgetSession(params.sessionKey);
    });
    let unbind: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    transport.signal.addEventListener('abort', () => {
      unbind?.(); client.rejectAllPendingRequests('controller_disconnected: mutation outcome may be unknown; no automatic replay');
    }, { once: true });
    let alive = true;
    socket.on('pong', () => { alive = true; });
    socket.on('open', () => {
      this.#attempts = 0;
      this.connectionError = undefined;
      unbind = this.host.bind((method, params, timeoutMs = 30_000) => transport.request(() => client.timeout(timeoutMs).request(method, params)));
      this.#heartbeat = heartbeat = setInterval(() => {
        if (!alive) socket.terminate();
        else { alive = false; socket.ping(); }
      }, 10_000);
      heartbeat.unref();
    });
    socket.on('message', data => {
      void transport.receive(data.toString(), message => peer.receiveAndSend(message)).catch(() => {});
    });
    socket.on('error', error => {
      this.connectionError = error.message.startsWith('Unexpected server response:') ? 'handshake_rejected: check pairing, occupied identity and protocol' : diagnosticError(error);
      if (this.#attempts === 0) console.error(`Device connection failed: ${this.connectionError}`);
    });
    socket.on('close', () => {
      transport.close(); clearInterval(heartbeat);
      if (this.#socket !== socket) return;
      this.#socket = undefined; this.#transport = undefined;
      if (!this.#stopped) this.#timer = setTimeout(() => this.connect(), Math.min(250 * 2 ** this.#attempts++, 5_000));
    });
  }
  stop(): void {
    this.#stopped = true; clearTimeout(this.#timer); clearInterval(this.#heartbeat); this.#transport?.close();
  }
}

export async function runDeviceDaemon(config: DeviceConfig): Promise<void> {
  if (!(await stat(config.cwd)).isDirectory()) throw new Error('Working directory must be a directory');
  // LaunchAgent/system-service PATH can omit Node even though this daemon has a valid runtime.
  const runtimeDirectory = dirname(process.execPath);
  const searchPath = process.env.PATH;
  if (!searchPath?.split(delimiter).includes(runtimeDirectory)) process.env.PATH = searchPath ? `${searchPath}${delimiter}${runtimeDirectory}` : runtimeDirectory;
  const permitted = daemonEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(permitted, key)) delete process.env[key];
  const host = new DeviceHost(config);
  const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined;
  const connection = new DeviceConnection(host, config, ca);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { connection.stop(); await host.close(); })();
  let closeControl: (() => Promise<void>) | undefined;
  try {
    closeControl = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId: host.daemonId,
      pid: process.pid, connected: connection.connected, endpoint: config.endpoint,
      ...(connection.connectionError ? { connectionError: connection.connectionError } : {}),
      entrypoint: fileURLToPath(new URL('./cli.js', import.meta.url)), runtime: process.execPath,
      ...host.maintenanceStatus(), selfTest: host.selfTestStatus, selfTests: host.selfTestStatuses, selfTestProviders: host.selfTestProviders }), stop, () => {
        const closing = host.closeIfIdle();
        connection.stop(); stopping = closing;
        return closing;
      }, (id, provider) => host.startSelfTest(id, provider), (id, provider) => host.lookupSelfTest(id, provider));
    connection.connect();
  } catch (error) { await stop().catch(() => {}); await closeControl?.(); throw error; }
  console.log(`Device ${config.nodeId} connecting to ${config.endpoint}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void stop().then(() => closeControl?.()).then(() => process.exit(0), () => process.exit(1));
  });
}
