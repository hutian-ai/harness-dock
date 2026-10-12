import { Buffer } from 'node:buffer';

export interface DeviceTransportLimits {
  messageBytes: number;
  pendingRequests: number;
  incomingHandlers: number;
  incomingBytes: number;
  outgoingBytes: number;
  sendTimeoutMs: number;
}
export const DEVICE_TRANSPORT_LIMITS: Readonly<DeviceTransportLimits> = Object.freeze({
  messageBytes: 64 * 1024 * 1024,
  pendingRequests: 32,
  incomingHandlers: 16,
  incomingBytes: 64 * 1024 * 1024,
  outgoingBytes: 64 * 1024 * 1024,
  sendTimeoutMs: 60_000,
});

export function deviceTransportLimits(overrides: Partial<DeviceTransportLimits> = {}): Readonly<DeviceTransportLimits> {
  const limits = { ...DEVICE_TRANSPORT_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)
    || limits.sendTimeoutMs > 2_147_483_647) throw new Error('invalid_transport_limits');
  return Object.freeze(limits);
}

/** Kept by a stable peer, so reconnect cannot discard still-running handlers. */
export class DeviceInboundBudget {
  readonly limits: Readonly<DeviceTransportLimits>;
  #handlers = 0;
  #bytes = 0;
  constructor(limits: Partial<DeviceTransportLimits> = {}) { this.limits = deviceTransportLimits(limits); }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid_inbound_bytes');
    if (this.#handlers >= this.limits.incomingHandlers || bytes > this.limits.incomingBytes - this.#bytes)
      throw new Error('device_inbound_limit');
    this.#handlers++; this.#bytes += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false; this.#handlers--; this.#bytes -= bytes;
    };
  }
}

/** Structural socket port: usable by Daemon, listener and remote SDK without a ws dependency. */
export interface DeviceTransportSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}

/** One socket generation. It never owns a Provider, retry queue or permission decision. */
export class DeviceTransport {
  readonly #socket: DeviceTransportSocket;
  readonly #inbound: DeviceInboundBudget;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<(error: Error) => void>();
  readonly #writes = new Set<(error?: Error) => void>();
  #outgoingBytes = 0;
  get signal(): AbortSignal { return this.#lifetime.signal; }
  constructor(socket: DeviceTransportSocket, inbound: DeviceInboundBudget) {
    this.#socket = socket; this.#inbound = inbound;
  }
  #open(): void {
    this.signal.throwIfAborted();
    if (this.#socket.readyState !== 1) throw new Error('device_disconnected');
  }
  close(reason = new Error('device_disconnected: mutation outcome may be unknown; no automatic replay')): void {
    if (this.signal.aborted) return;
    this.#lifetime.abort(reason);
    for (const reject of this.#pending) reject(reason);
    this.#pending.clear();
    for (const finish of [...this.#writes]) finish(reason);
    // Incoming handlers retain their shared reservation until they actually settle.
    this.#socket.terminate();
  }
  async request<T>(operation: () => PromiseLike<T>): Promise<T> {
    this.#open();
    if (this.#pending.size >= this.#inbound.limits.pendingRequests) {
      const error = new Error('device_pending_limit: mutation outcome may be unknown; no automatic replay');
      this.close(error); throw error;
    }
    let pending: ((error: Error) => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        pending = reject; this.#pending.add(pending);
        try { Promise.resolve(operation()).then(resolve, reject); } catch (error) { reject(error); }
      });
    } finally {
      if (pending) this.#pending.delete(pending);
    }
  }
  async send(payload: unknown): Promise<void> {
    this.#open();
    let text: string;
    try {
      const value = JSON.stringify(payload);
      if (value === undefined) throw new Error('invalid_rpc_message');
      text = value;
    } catch (error) { this.close(error instanceof Error ? error : new Error('invalid_rpc_message')); throw error; }
    const bytes = Buffer.byteLength(text);
    const limits = this.#inbound.limits;
    if (bytes > limits.messageBytes || bytes > limits.outgoingBytes - this.#outgoingBytes
      || bytes > limits.outgoingBytes - this.#socket.bufferedAmount) {
      const error = new Error('device_send_limit: mutation outcome may be unknown; no automatic replay');
      this.close(error); throw error;
    }
    this.#outgoingBytes += bytes;
    return await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        this.#writes.delete(finish); this.#outgoingBytes -= bytes;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => this.close(new Error('device_send_timeout: mutation outcome may be unknown; no automatic replay')), limits.sendTimeoutMs);
      this.#writes.add(finish);
      try {
        this.#socket.send(text, error => {
          if (error) this.close(error);
          finish(error);
        });
      } catch (error) { this.close(error instanceof Error ? error : new Error('device_send_failed')); }
    });
  }
  async receive(text: string, dispatch: (payload: unknown) => PromiseLike<void>): Promise<void> {
    let release: (() => void) | undefined;
    try {
      this.#open();
      const bytes = Buffer.byteLength(text);
      if (bytes > this.#inbound.limits.messageBytes) throw new Error('device_message_limit');
      const message: unknown = JSON.parse(text);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid_rpc_message');
      // Responses must keep flowing while a request waits for a tool or approval callback.
      if ('method' in message) release = this.#inbound.reserve(bytes);
      await dispatch(message);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('device_receive_failed'));
      throw error;
    } finally { release?.(); }
  }
}
