#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ServerClient, type ServerPeer } from './server-client.ts';

process.umask(0o077);
const configPath = resolve(process.argv[2] ?? '.local/control/client.json');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  clientId: string; token: string; endpoint: string; caFile?: string;
};
const controller = new ServerClient({
  endpoint: config.endpoint, clientId: config.clientId, token: config.token,
  ca: config.caFile ? await readFile(resolve(dirname(configPath), config.caFile), 'utf8') : undefined,
});
await controller.ready;
const initialNodes = controller.listNodes();
let selectedNode = initialNodes.length === 1 ? initialNodes[0]!.nodeId : undefined;
const runs = new Map<string, { runId: string; pending: boolean }>();
const permissions = new Map<string, { nodeId: string; runId: string; canAllow: boolean; decide(value: 'allow' | 'deny'): void }>();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
for (const node of controller.listNodes()) {
  const peer = controller.node(node.nodeId)!;
  peer.onRequest('execution.callback', async (value, context) => {
    const callback = object(value), payload = object(callback.payload);
    const runId = String(callback.runId ?? '');
    if (runs.get(node.nodeId)?.runId !== runId) throw new Error('run_not_owned_by_console');
    context.signal.throwIfAborted();
    if (callback.kind === 'permission') {
      const permissionId = randomUUID();
      console.log(`\n审批 ${permissionId}，节点 ${node.nodeId}，执行 ${runId}`);
      console.dir(payload, { depth: 4 });
      console.log(`allow ${permissionId} / deny ${permissionId}`);
      return await new Promise<'allow' | 'deny'>(resolve => {
        const finish = (decision: 'allow' | 'deny') => {
          if (!permissions.delete(permissionId)) return;
          context.signal.removeEventListener('abort', abort);
          resolve(decision);
        };
        const abort = () => finish('deny');
        permissions.set(permissionId, { nodeId: node.nodeId, runId, canAllow: payload.canAllow === true, decide: finish });
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
      });
    }
    if (callback.kind === 'toolCall') return { content: { error: 'No tools registered by this console' }, isError: true };
    if (payload.type === 'text_delta' && typeof payload.text === 'string') process.stdout.write(payload.text);
    else if (callback.kind !== 'fileChanges') console.log(`\n[${node.nodeId} ${callback.kind}]`, callback.payload);
    return null;
  });
}
controller.onConnection(node => console.log(`\n节点 ${node.label ?? node.nodeId}: ${node.connected ? '已连接' : '离线'}`));
console.log(`设备控制端: ${config.endpoint}\n命令: nodes | use <nodeId> | inventory | run <provider> <prompt> | status [runId] | allow <id> | deny <id> | cancel | quit`);
console.table(controller.listNodes());
function selected(): ServerPeer {
  const peer = selectedNode ? controller.node(selectedNode) : undefined;
  if (!peer) throw new Error('先用 use <nodeId> 选择节点');
  return peer;
}
function finishPermissions(nodeId: string, runId: string): void {
  for (const permission of permissions.values())
    if (permission.nodeId === nodeId && permission.runId === runId) permission.decide('deny');
}
async function execute(peer: ServerPeer, provider: string, prompt: string): Promise<void> {
  if (runs.get(peer.nodeId)?.pending) throw new Error('此节点仍有未确认的执行；请先查 status');
  if (!provider || !prompt) throw new Error('用法: run <provider> <prompt>');
  const runId = randomUUID();
  runs.set(peer.nodeId, { runId, pending: true });
  console.log(`执行身份: ${runId}`);
  let dispatched = false;
  try {
    const inventory = object(await peer.request('inventory', {}, 120_000));
    const providers = Array.isArray(inventory.providers) ? inventory.providers.map(object) : [];
    const selected = providers.find(candidate => candidate.key === provider);
    if (!selected || selected.status !== 'ready') throw new Error('所选引擎未通过探测，请先查看 inventory');
    const model = Array.isArray(selected.models) && typeof selected.models[0] === 'string' ? selected.models[0] : undefined;
    const preparation = await peer.request('prepare', { runId, files: [] });
    console.log('节点执行目录:', preparation);
    if (model) console.log('模型:', model);
    dispatched = true;
    const result = await peer.request('execute', { provider, runId, prompt, ...(model ? { model } : {}) }, 24 * 60 * 60_000);
    console.log('\n执行结果:');
    console.dir(result, { depth: 6 });
    runs.set(peer.nodeId, { runId, pending: object(object(result).result).state === 'unknown' });
  } catch (error) {
    if (!dispatched) runs.set(peer.nodeId, { runId, pending: false });
    console.error(dispatched ? '执行响应未确认；查询同一 runId，不自动重发:' : '执行未派发:', error instanceof Error ? error.message : error);
  } finally { finishPermissions(peer.nodeId, runId); }
}
const readline = createInterface({ input: process.stdin, output: process.stdout });
for await (const line of readline) {
  const [command, ...args] = line.trim().split(/\s+/u);
  try {
    if (command === 'quit') break;
    if (command === 'nodes') console.table(controller.listNodes());
    else if (command === 'use') {
      if (!args[0] || !controller.node(args[0])) throw new Error('未知节点');
      selectedNode = args[0]; console.log('当前节点:', selectedNode);
    } else if (command === 'inventory') console.dir(await selected().request('inventory', {}, 120_000), { depth: 6 });
    else if (command === 'run') void execute(selected(), args[0] ?? '', args.slice(1).join(' ')).catch(error => console.error(error.message));
    else if (command === 'status') {
      const peer = selected(), runId = args[0] ?? runs.get(peer.nodeId)?.runId;
      if (!runId) throw new Error('没有执行身份');
      const result = await peer.request('getExecution', { runId });
      console.dir(result, { depth: 6 });
      const state = object(result).state;
      if (runs.get(peer.nodeId)?.runId === runId && ['completed', 'cancelled', 'failed'].includes(String(state)))
        runs.set(peer.nodeId, { runId, pending: false });
    } else if (command === 'allow' || command === 'deny') {
      const pending = permissions.get(args[0] ?? '');
      if (!pending) throw new Error('审批已失效或不存在');
      if (command === 'allow' && !pending.canAllow) throw new Error('此请求不支持单次允许');
      pending.decide(command);
    } else if (command === 'cancel') {
      const peer = selected(), runId = runs.get(peer.nodeId)?.runId;
      if (!runId) throw new Error('没有执行身份');
      finishPermissions(peer.nodeId, runId);
      console.log(await peer.request('cancel', { runId }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : error); }
}
for (const permission of permissions.values()) permission.decide('deny');
await controller.close();
readline.close();
process.stdin.pause();
