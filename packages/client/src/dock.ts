import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ServerClient, type ServerClientOptions } from './server-client.ts';
import { loadClientOptions } from './onboarding.ts';
import { readRunReceipt, runTask, writeRunReceipt } from './execution-command.ts';

export interface DockExecutionHandle { runId: string; nodeId: string; receipt: string }
export interface DockRunOptions {
  prompt: string;
  /** Use a new private path per task. An existing receipt prevents resubmission. */
  receipt: string;
  nodeId?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  permission?: NonNullable<Parameters<typeof runTask>[2]>['permission'];
  /** Called after durable receipt storage, before any device request; not proof of admission. */
  onReceipt?: (handle: DockExecutionHandle) => void;
  progress?: NonNullable<Parameters<typeof runTask>[2]>['progress'];
  /** Interrupts local observation and pending callbacks; does not cancel the native execution. */
  signal?: AbortSignal;
}

/** Convenience for one-shot tasks; raw client APIs remain available for advanced execution. */
export class Dock {
  constructor(readonly client: ServerClient, private readonly clientId: string) {}
  listNodes() { return this.client.listNodes(); }
  private peer(nodeId?: string) {
    const nodes = this.client.listNodes();
    if (!nodeId && nodes.length !== 1) throw new Error('select_node: pass nodeId from listNodes()');
    const peer = this.client.node(nodeId ?? nodes[0]!.nodeId);
    if (!peer?.connected) throw new Error('device_unavailable');
    return peer;
  }
  async run(options: DockRunOptions) {
    options.signal?.throwIfAborted();
    const peer = this.peer(options.nodeId);
    const input = { provider: options.provider ?? 'codex', runId: randomUUID(), prompt: options.prompt,
      ...(options.model === undefined ? {} : { model: options.model }) };
    const receipt = resolve(options.receipt);
    // Persist identity and original input before any device request. Never overwrite or retry.
    await writeRunReceipt(receipt, { version: 1, clientId: this.clientId, nodeId: peer.nodeId,
      runId: input.runId, createdAt: new Date().toISOString(), input });
    options.onReceipt?.({ runId: input.runId, nodeId: peer.nodeId, receipt });
    const response = await runTask(peer, input, { timeoutMs: options.timeoutMs, permission: options.permission,
      progress: options.progress, signal: options.signal });
    return { ...response, runId: input.runId, nodeId: peer.nodeId, receipt };
  }
  /** Only observes the original task. null is absence of evidence, not permission to resubmit. */
  async status(receiptPath: string) {
    return (await this.observed(receiptPath)).snapshot;
  }
  private async observed(receiptPath: string) {
    const receipt = await readRunReceipt(receiptPath);
    if (receipt.clientId !== this.clientId) throw new Error('receipt_client_mismatch');
    const peer = this.peer(receipt.nodeId);
    const snapshot = await peer.request('getExecution', { runId: receipt.runId });
    if (snapshot && (snapshot.runId !== receipt.runId || snapshot.provider !== receipt.input.provider))
      throw new Error('execution_identity_conflict');
    return { receipt, peer, snapshot };
  }
  private async settled(receiptPath: string) {
    const original = await this.observed(receiptPath);
    const { snapshot } = original;
    if (!snapshot || !['completed', 'failed', 'cancelled'].includes(snapshot.state)) throw new Error('execution_unconfirmed');
    return original;
  }
  /** Explicitly collect a confirmed terminal run. The application verifies and stores its outputs. */
  async collect(receiptPath: string) {
    const { receipt, peer } = await this.settled(receiptPath);
    return peer.request('collect', { runId: receipt.runId });
  }
  /** Call only after accepting and storing needed results. Leaves the receipt and native history intact. */
  async release(receiptPath: string) {
    const { receipt, peer } = await this.settled(receiptPath);
    await peer.request('release', { runId: receipt.runId });
    await peer.request('forgetSession', { sessionKey: receipt.runId });
    return null;
  }
  close() { return this.client.close(); }
}

export async function connectDock(config: string | ServerClientOptions): Promise<Dock> {
  const options = typeof config === 'string' ? await loadClientOptions(config) : config;
  const client = new ServerClient(options);
  try { await client.ready; return new Dock(client, options.clientId); }
  catch (error) { await client.close(); throw error; }
}
