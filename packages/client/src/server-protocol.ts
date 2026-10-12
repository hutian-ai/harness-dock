import { DockError, id, type DeviceNodeSummary } from '@harness-dock/protocol';

export const SERVER_PROTOCOL_VERSION = 1;
export const SERVER_PROTOCOL_HEADER = 'x-dock-server-version';
export const SERVER_MAX_NODES = 128;
export const SERVER_MAX_CLIENTS = 16;
export const SERVER_DEVICE_METHODS = new Set([
  'inventory', 'prepare', 'execute', 'getExecution', 'events', 'reconcile',
  'cancel', 'steer', 'collect', 'release', 'forgetSession',
]);
export const SERVER_CALLBACK_METHOD = 'execution.callback';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DockError('invalid_request');
  return value as Record<string, unknown>;
}
export function rpcTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 24 * 60 * 60_000)
    throw new DockError('invalid_timeout');
  return value as number;
}
export function nodeSummary(value: unknown): DeviceNodeSummary {
  const item = record(value);
  if (typeof item.connected !== 'boolean' || (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 256)))
    throw new DockError('invalid_node_summary');
  return {
    nodeId: id.parse(item.nodeId), connected: item.connected,
    ...(item.label !== undefined ? { label: item.label as string } : {}),
    ...(item.daemonId !== undefined ? { daemonId: id.parse(item.daemonId) } : {}),
  };
}

/** Disconnect/timeout stops awaiting a callback; it never turns its decision into a retry. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
