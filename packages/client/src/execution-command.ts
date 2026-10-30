import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { id, type DeviceExecuteInput, type DeviceExecutionCallback, type DeviceExecutionResponse } from '@harness-dock/protocol';
import type { ServerPeer } from './server-client.ts';
import { record, rpcTimeout } from './server-protocol.ts';

export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60_000;
export type RunInput = Pick<DeviceExecuteInput, 'provider' | 'runId' | 'prompt' | 'model'>;
export type ExecutionPeer = Pick<ServerPeer, 'nodeId' | 'daemonId' | 'connected' | 'request' | 'onExecutionCallback'>;
export class ExecutionCommandError extends Error {
  constructor(cause: unknown, readonly executionAttempted: boolean) {
    super(cause instanceof Error ? cause.message : 'execution_request_failed', { cause });
    this.name = 'ExecutionCommandError';
  }
}
export interface RunReceipt {
  version: 1;
  clientId: string;
  nodeId: string;
  runId: string;
  createdAt: string;
  input: RunInput;
}

export function validateRunInput(input: RunInput): void {
  id.parse(input.runId);
  if (typeof input.provider !== 'string' || !input.provider.trim() || input.provider.length > 128) throw new Error('invalid_provider');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) throw new Error('invalid_prompt: provide nonempty text up to 8 MiB');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim())) throw new Error('invalid_model');
}

/** Immutable caller input, never a claim that the device admitted or completed it. */
export async function writeRunReceipt(path: string, receipt: RunReceipt): Promise<void> {
  validateRunInput(receipt.input);
  id.parse(receipt.clientId); id.parse(receipt.nodeId); id.parse(receipt.runId);
  if (receipt.runId !== receipt.input.runId) throw new Error('invalid_run_receipt');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
}

export async function readRunReceipt(path: string): Promise<RunReceipt> {
  const file = await stat(path);
  if (!file.isFile() || file.size > 64 * 1024 * 1024 || process.platform !== 'win32' && (file.mode & 0o077)) throw new Error('invalid_run_receipt_permissions');
  const value = record(JSON.parse(await readFile(path, 'utf8'))), input = record(value.input);
  if (value.version !== 1 || typeof value.createdAt !== 'string'
    || Object.keys(input).some(key => !['provider', 'runId', 'prompt', 'model'].includes(key))) throw new Error('invalid_run_receipt');
  id.parse(value.clientId); id.parse(value.nodeId); id.parse(value.runId);
  validateRunInput(input as unknown as RunInput);
  if (value.runId !== input.runId) throw new Error('invalid_run_receipt');
  return value as unknown as RunReceipt;
}

/** One SDK execution. A lost response never becomes a retry or an automatic release. */
export async function runTask(peer: ExecutionPeer, input: RunInput, options: {
  permission?: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  progress?: (value: DeviceExecutionCallback) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<DeviceExecutionResponse> {
  validateRunInput(input);
  const timeoutMs = rpcTimeout(options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);
  const boot = peer.daemonId;
  let active = true;
  let executionAttempted = false;
  let permissions: Promise<void> = Promise.resolve();
  const fence = (signal?: AbortSignal) => {
    options.signal?.throwIfAborted(); signal?.throwIfAborted();
    if (!active || !boot || !peer.connected || peer.daemonId !== boot) throw new Error('device_connection_expired');
  };
  fence();
  const remove = peer.onExecutionCallback(async (call, context) => {
    const signal = options.signal ? AbortSignal.any([options.signal, context.signal]) : context.signal;
    fence(signal);
    if (context.nodeId !== peer.nodeId || context.daemonId !== boot || call.runId !== input.runId) throw new Error('execution_callback_expired');
    options.progress?.(call);
    if (call.kind === 'permission') {
      const answer = permissions.then(async () => {
        fence(signal);
        const decision = options.permission ? await options.permission(record(call.payload), signal) : 'deny';
        fence(signal);
        return decision;
      });
      permissions = answer.then(() => {}, () => {});
      return answer;
    }
    if (call.kind === 'toolCall') throw new Error('cli_caller_tool_unavailable');
    return null;
  });
  try {
    const inventory = record(await peer.request('inventory', {}, 120_000)); fence();
    if (inventory.nodeId !== peer.nodeId || inventory.daemonId !== boot) throw new Error('device_connection_expired');
    const provider = (Array.isArray(inventory.providers) ? inventory.providers.map(record) : []).find(value => value.key === input.provider);
    if (provider?.status !== 'ready') throw new Error('provider_not_ready');
    if (input.model !== undefined && (!Array.isArray(provider.models) || !provider.models.includes(input.model))) throw new Error('model_unavailable');
    await peer.request('prepare', { runId: input.runId, files: [] }); fence();
    executionAttempted = true;
    const response = record(await peer.request('execute', input, timeoutMs)); fence();
    const result = record(response.result);
    if (response.provider !== input.provider || !['completed', 'failed', 'cancelled', 'unknown'].includes(String(result.state))) throw new Error('invalid_execution_response');
    return response as unknown as DeviceExecutionResponse;
  } catch (error) { throw new ExecutionCommandError(error, executionAttempted); }
  finally { active = false; remove(); }
}
