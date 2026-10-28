import { z } from 'zod';
export * from './device.ts';
export * from './device-limits.ts';
export * from './health.ts';
export * from './execution.ts';
export const id = z.uuid();
export class DockError extends Error {
  constructor(
    readonly kind: string,
    message = kind,
  ) {
    super(message);
    this.name = 'DockError';
  }
}
export function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', '[::1]'].includes(host);
}
export function assertEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (
    !(url.protocol === 'wss:' || (url.protocol === 'ws:' && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new DockError('invalid_endpoint', 'Use verified wss:// or loopback ws:// without credentials, query or path');
}
