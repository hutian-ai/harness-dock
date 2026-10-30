#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diagnosticError, id, printDiagnostics } from '@harness-dock/protocol';
import { ServerClient, type ServerPeer } from './server-client.ts';
import { clientDoctor, loadClientOptions, promptNativePermission, runFirstTest } from './onboarding.ts';
import { DEFAULT_EXECUTION_TIMEOUT_MS, ExecutionCommandError, MAX_PROMPT_BYTES, readRunReceipt, runTask, validateRunInput, writeRunReceipt, type RunInput } from './execution-command.ts';
import { rpcTimeout } from './server-protocol.ts';

process.umask(0o077);
const usage = `harness-dock-client nodes <client.json>
harness-dock-client doctor <client.json> [--node-id <UUID>] [--probe] [--json]
harness-dock-client test <client.json> [--node-id <UUID>] [--model <native-model>] [--approval]
harness-dock-client run <client.json> (--prompt <text> | --prompt-file <file>)
  [--node-id <UUID>] [--provider codex] [--model <native-model>]
  [--run-id <UUID>] [--receipt <new-private-file>] [--timeout-ms <N>]
harness-dock-client status <client.json> --node-id <UUID> --run-id <UUID>
harness-dock-client status <client.json> --receipt <request-record.json>
harness-dock-client --version
run sends one real task and can use model quota. Native approvals prompt on an interactive stdin; otherwise they are denied. No automatic approvals.
run saves the original request at .local/client-runs/<runId>.json before submitting. Existing receipts are never overwritten. Native model defaults are preserved unless --model is given.
run writes progress/approvals to stderr and one result JSON to stdout. Exit 0: completed; 1: failed/cancelled, invalid input or not_submitted; 2: attempted execution with unknown/unconfirmed result. Default execute timeout: 3600000 ms (maximum 86400000).
Ctrl-C/SIGTERM only stop observation (exit 130/143), not confirmed native cancellation. Query status with the original receipt; never automatically repeat run. Outputs are not automatically released.
status only queries the original execution. A successful query is not proof of task completion; null means no stored evidence, not that nothing executed.
test explicitly sends two synthetic model prompts and can use model quota. --approval requires a TTY and exposes only a synthetic test tool. It never auto-allows native permissions.
Use a dedicated application credential: one application identity supports one active connection. doctor never replaces an existing application or device connection.`;

async function executeCommand(client: ServerClient, peer: ServerPeer, clientId: string, configPath: string,
  input: RunInput, receiptPath: string, timeoutMs: number): Promise<void> {
  await writeRunReceipt(receiptPath, { version: 1, clientId, nodeId: peer.nodeId, runId: input.runId, createdAt: new Date().toISOString(), input });
  const identity = { runId: input.runId, nodeId: peer.nodeId, provider: input.provider, receipt: receiptPath };
  console.error(JSON.stringify({ phase: 'request_saved', ...identity }));
  const controller = new AbortController();
  let interrupted: number | undefined;
  const stop = (code: number) => {
    interrupted = code;
    controller.abort(new Error('observation_interrupted'));
    void client.close();
  };
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const response = await runTask(peer, input, { timeoutMs, signal: controller.signal,
      permission: (payload, signal) => promptNativePermission(payload, signal, interrupt), progress: value => console.error(JSON.stringify(value)),
    });
    console.log(JSON.stringify({ ...identity, state: response.result.state, result: response.result }, null, 2));
    process.exitCode = response.result.state === 'completed' ? 0 : response.result.state === 'unknown' ? 2 : 1;
  } catch (error) {
    const attempted = error instanceof ExecutionCommandError && error.executionAttempted;
    console.log(JSON.stringify({ ...identity, ...(attempted ? { state: 'unknown' } : { state: null, submission: 'not_submitted' }), error: diagnosticError(error) }, null, 2));
    process.exitCode = interrupted ?? (attempted ? 2 : 1);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  console.error(`Query this run: harness-dock-client status ${quote(configPath)} --receipt ${quote(receiptPath)}. Do not automatically repeat run.`);
}

async function main(): Promise<void> {
  const { positionals: [command, path, ...extra], values } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' }, probe: { type: 'boolean' },
    'node-id': { type: 'string' }, 'run-id': { type: 'string' }, model: { type: 'string' }, approval: { type: 'boolean' },
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, provider: { type: 'string' }, receipt: { type: 'string' },
    'timeout-ms': { type: 'string' },
  } });
  if (values.version) console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (!command || command === 'help' || values.help) console.log(usage);
  else {
    const flags: Record<string, readonly string[]> = {
      nodes: ['json'], doctor: ['node-id', 'probe', 'json'], test: ['node-id', 'model', 'approval', 'json'],
      status: ['node-id', 'run-id', 'receipt', 'json'],
      run: ['node-id', 'provider', 'model', 'run-id', 'prompt', 'prompt-file', 'receipt', 'timeout-ms', 'json'],
    };
    if (!path || extra.length || !Object.hasOwn(flags, command)) throw new Error(usage);
    for (const key of Object.keys(values)) if (!flags[command]!.includes(key)) throw new Error(`unsupported_option: ${command} --${key}`);
    if (values['node-id']) id.parse(values['node-id']);
    if (values['run-id']) id.parse(values['run-id']);
    let input: RunInput | undefined;
    let timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS;
    if (command === 'run') {
      if ((values.prompt === undefined) === (values['prompt-file'] === undefined)) throw new Error('run requires exactly one of --prompt or --prompt-file');
      if (values['timeout-ms'] !== undefined) {
        if (!/^[1-9]\d*$/.test(values['timeout-ms'])) throw new Error('invalid_timeout');
        timeoutMs = rpcTimeout(Number(values['timeout-ms']));
      }
      let prompt = values.prompt;
      if (values['prompt-file'] !== undefined) {
        const file = await stat(values['prompt-file']);
        if (!file.isFile() || file.size > MAX_PROMPT_BYTES) throw new Error('invalid_prompt_file');
        prompt = await readFile(values['prompt-file'], 'utf8');
      }
      input = { provider: values.provider ?? 'codex', runId: values['run-id'] ?? randomUUID(), prompt: prompt!,
        ...(values.model !== undefined ? { model: values.model } : {}) };
      validateRunInput(input);
    }
    const options = await loadClientOptions(path);
    const receipt = command === 'status' && values.receipt ? await readRunReceipt(values.receipt) : undefined;
    if (receipt && (receipt.clientId !== options.clientId || values['node-id'] !== undefined && values['node-id'] !== receipt.nodeId
      || values['run-id'] !== undefined && values['run-id'] !== receipt.runId)) throw new Error('receipt_identity_conflict');
    if (command === 'status' && !receipt && !values['run-id']) throw new Error('status requires --run-id or --receipt');
    if (command === 'doctor') printDiagnostics(await clientDoctor(options, values['node-id'], values.probe), values.json);
    else {
      if (command === 'test' && values.approval && !process.stdin.isTTY) throw new Error('approval_test_requires_interactive_terminal');
      const client = new ServerClient(options);
      try {
        await client.ready;
        if (command === 'nodes') console.log(JSON.stringify(client.listNodes(), null, 2));
        else {
          const nodes = client.listNodes(), nodeId = receipt?.nodeId ?? values['node-id'] ?? (nodes.length === 1 ? nodes[0]!.nodeId : undefined);
          const peer = nodeId ? client.node(nodeId) : undefined;
          if (!peer) throw new Error('select_granted_device: use nodes and --node-id');
          if (!peer.connected) throw new Error('device_offline: start its daemon and check its doctor');
          if (command === 'status') {
            const snapshot = await peer.request('getExecution', { runId: receipt?.runId ?? values['run-id']! });
            console.log(JSON.stringify(snapshot, null, 2));
            if (snapshot === null) console.error('No stored execution evidence. This does not prove the task never executed; do not automatically resubmit it.');
          } else if (command === 'run') {
            const receiptPath = resolve(values.receipt ?? `.local/client-runs/${input!.runId}.json`);
            await executeCommand(client, peer, options.clientId, path, input!, receiptPath, timeoutMs);
          } else console.log(JSON.stringify(await runFirstTest(peer, { model: values.model, approval: values.approval,
            permission: promptNativePermission, progress: value => console.error(JSON.stringify(value)) }), null, 2));
        }
      } finally { await client.close(); }
    }
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'client_command_failed'); process.exitCode = 1; });
