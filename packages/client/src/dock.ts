import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ServerClient, type ServerClientOptions } from './server-client.ts';
import { loadClientOptions } from './onboarding.ts';
import { readRunReceipt, runTask, writeRunReceipt } from './execution-command.ts';

export interface DockRunOptions {
  prompt: string;
  /** Use a new private path per task. An existing receipt prevents resubmission. */
  receipt: string;
  nodeId?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  permission?: NonNullable<Parameters<typeof runTask>[2]>['permission'];
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
    const peer = this.peer(options.nodeId);
    const input = { provider: options.provider ?? 'codex', runId: randomUUID(), prompt: options.prompt,
      ...(options.model === undefined ? {} : { model: options.model }) };
    const receipt = resolve(options.receipt);
    // Persist identity and original input before any device request. Never overwrite or retry.
    await writeRunReceipt(receipt, { version: 1, clientId: this.clientId, nodeId: peer.nodeId,
      runId: input.runId, createdAt: new Date().toISOString(), input });
    const response = await runTask(peer, input, { timeoutMs: options.timeoutMs, permission: options.permission });
    return { ...response, runId: input.runId, nodeId: peer.nodeId, receipt };
  }
  /** Only observes the original task. null is absence of evidence, not permission to resubmit. */
  async status(receiptPath: string) {
    const receipt = await readRunReceipt(receiptPath);
    if (receipt.clientId !== this.clientId) throw new Error('receipt_client_mismatch');
    return this.peer(receipt.nodeId).request('getExecution', { runId: receipt.runId });
  }
  close() { return this.client.close(); }
}

export async function connectDock(config: string | ServerClientOptions): Promise<Dock> {
  const options = typeof config === 'string' ? await loadClientOptions(config) : config;
  const client = new ServerClient(options);
  try { await client.ready; return new Dock(client, options.clientId); }
  catch (error) { await client.close(); throw error; }
}
