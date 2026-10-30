import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DockServer } from '../apps/server/src/index.ts';
import { DEVICE_PROTOCOL_HEADER, DEVICE_PROTOCOL_VERSION } from '../packages/protocol/src/device.ts';

type RpcMessage = { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type CliResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(5); }
}

function startCli(cwd: string, args: string[]): { child: ChildProcessWithoutNullStreams; done: Promise<CliResult> } {
  const child = spawn(process.execPath, [resolve('packages/client/dist/cli.js'), ...args], { cwd, stdio: 'pipe' });
  child.stdin.end(); // A pipe deliberately cannot answer interactive native approval requests.
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<CliResult>((resolveResult, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('execution CLI did not exit')); }, 12_000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}

async function fixture(t: TestContext, options: { permission?: boolean; hold?: boolean; models?: string[]; providerStatus?: 'ready' | 'unavailable' } = {}) {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/execution-cli-'));
  const pairing = { nodeId: randomUUID(), token: randomBytes(32).toString('hex') };
  const application = { clientId: randomUUID(), token: randomBytes(32).toString('hex'), nodeIds: [pairing.nodeId] };
  const daemonId = randomUUID();
  const server = new DockServer({ nodes: [pairing], clients: [application], devicePort: 0, clientPort: 0 });
  await server.ready;
  const clientFile = join(root, 'client.json');
  await writeFile(clientFile, JSON.stringify({ endpoint: server.clientEndpoint, clientId: application.clientId, token: application.token }), { mode: 0o600 });
  const socket = new WebSocket(server.deviceEndpoint, { headers: {
    authorization: `Bearer ${pairing.token}`, 'x-dock-node': pairing.nodeId, 'x-dock-daemon': daemonId,
    [DEVICE_PROTOCOL_HEADER]: String(DEVICE_PROTOCOL_VERSION),
  } });
  socket.on('error', () => {});
  const methods: string[] = [], executions: Record<string, unknown>[] = [], decisions: unknown[] = [], errors: unknown[] = [];
  const callbackReplies = new Map<string, (message: RpcMessage) => void>();
  const receipts: unknown[] = [];
  let expectedReceipt: string | undefined;
  function reply(id: string | undefined, result: unknown) {
    assert.ok(id); socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }
  async function callback(params: object) {
    const id = randomUUID();
    const response = new Promise<RpcMessage>(resolveReply => callbackReplies.set(id, resolveReply));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'execution.callback', params }));
    return response;
  }
  socket.on('message', data => {
    const message = JSON.parse(data.toString()) as RpcMessage;
    if (!message.method) {
      if (message.id) { callbackReplies.get(message.id)?.(message); callbackReplies.delete(message.id); }
      return;
    }
    methods.push(message.method);
    void (async () => {
      if (message.method === 'inventory') {
        if (expectedReceipt) receipts.push(JSON.parse(await readFile(expectedReceipt, 'utf8')));
        reply(message.id, { nodeId: pairing.nodeId, daemonId, workdir: root, platform: { platform: 'darwin', arch: 'arm64', release: 'synthetic', hostname: 'synthetic' },
          activeRunIds: [], unresolvedRunIds: [], resources: {}, providers: [{ key: 'codex', displayName: 'Synthetic Codex', status: options.providerStatus ?? 'ready', version: null,
            models: options.models ?? ['synthetic'], sessionResumeMode: 'unsupported', capabilities: { protocol: 'acp', sessionResume: 'unsupported', resultQuery: 'unsupported',
              exactFinalAnswer: false, callerSkills: false, permissionInteractions: ['options'], desktopTools: 'not_reported', browser: 'unverified' } }] });
      } else if (message.method === 'prepare') {
        if (expectedReceipt) receipts.push(JSON.parse(await readFile(expectedReceipt, 'utf8')));
        reply(message.id, { workdir: root, skillDirectory: join(root, 'skills'), outputDirectory: join(root, 'outputs') });
      } else if (message.method === 'execute') {
        const input = message.params!; executions.push(input);
        if (expectedReceipt) receipts.push(JSON.parse(await readFile(expectedReceipt, 'utf8')));
        if (options.hold) return;
        if (options.permission) {
          const decision = await callback({ runId: input.runId, kind: 'permission', payload: { id: randomUUID(), title: 'Synthetic native action', details: {}, canAllow: true,
            options: [{ optionId: 'native-allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'native-reject-once', name: 'Reject once', kind: 'reject_once' }] } });
          assert.equal(decision.error, undefined); decisions.push(decision.result);
        }
        reply(message.id, { provider: 'codex', result: { state: 'completed', nativeDetail: { answer: 'synthetic result' } } });
      } else if (message.method === 'getExecution') {
        const runId = message.params?.runId;
        reply(message.id, executions.some(input => input.runId === runId)
          ? { runId, provider: 'codex', state: options.hold ? 'unknown' : 'completed', detailsExpired: false, historyTruncated: false,
            ...(options.hold ? {} : { result: { state: 'completed', nativeDetail: { answer: 'synthetic result' } } }) } : null);
      } else throw new Error('Unexpected device method: ' + message.method);
    })().catch(error => {
      errors.push(error);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'synthetic_device_error' } }));
    });
  });
  await new Promise<void>((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
  t.after(async () => { socket.terminate(); await server.close(); await rm(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { root, clientFile, application, pairing, methods, executions, decisions, receipts,
    expectReceipt(file: string) { expectedReceipt = file; },
    run(...args: string[]) { return startCli(root, args).done; },
  };
}

test('execution CLI persists private identity before dispatch, preserves native defaults, and queries the original receipt', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const runId = randomUUID(), receiptPath = join(f.root, '.local/client-runs', runId + '.json');
  f.expectReceipt(receiptPath);
  const output = await f.run('run', f.clientFile, '--prompt', 'Synthetic task with caller-owned input', '--run-id', runId);
  assert.equal(output.code, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.runId, runId); assert.equal(result.nodeId, f.pairing.nodeId); assert.equal(result.provider, 'codex');
  assert.equal(result.state, 'completed'); assert.deepEqual(result.result.nativeDetail, { answer: 'synthetic result' });
  assert.equal(resolve(f.root, result.receipt), receiptPath);
  const source = await readFile(receiptPath, 'utf8'), receipt = JSON.parse(source);
  assert.equal(receipt.version, 1); assert.equal(receipt.clientId, f.application.clientId); assert.equal(receipt.nodeId, f.pairing.nodeId);
  assert.deepEqual(receipt.input, { provider: 'codex', runId, prompt: 'Synthetic task with caller-owned input' });
  assert.equal(receipt.runId, runId); assert.ok(!source.includes(f.application.token)); assert.ok(!source.includes(f.pairing.token));
  if (process.platform !== 'win32') assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  assert.deepEqual(f.methods, ['inventory', 'prepare', 'execute']);
  assert.equal(f.receipts.length, 3, 'identity and original input must exist before all device work');
  assert.equal(f.executions.length, 1); assert.equal(f.executions[0]!.model, undefined);
  assert.equal(f.executions[0]!.tools, undefined);
  const status = await f.run('status', f.clientFile, '--receipt', receiptPath);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).runId, runId); assert.equal(JSON.parse(status.stdout).state, 'completed');
  assert.deepEqual(f.methods, ['inventory', 'prepare', 'execute', 'getExecution']);
});

test('execution CLI rejects noninteractive native approvals and never overwrites an existing request receipt', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { permission: true });
  const receipt = join(f.root, 'request.json'), promptFile = join(f.root, 'prompt.txt');
  await writeFile(promptFile, 'Synthetic prompt from a private file', { mode: 0o600 }); f.expectReceipt(receipt);
  const output = await f.run('run', f.clientFile, '--prompt-file', promptFile, '--model', 'synthetic', '--receipt', receipt);
  assert.equal(output.code, 0, output.stderr); assert.equal(JSON.parse(output.stdout).state, 'completed');
  assert.deepEqual(f.decisions, ['deny']); assert.equal(f.executions[0]!.model, 'synthetic');
  assert.equal(f.executions[0]!.prompt, 'Synthetic prompt from a private file');
  const original = await readFile(receipt, 'utf8'), methodCount = f.methods.length;
  const duplicate = await f.run('run', f.clientFile, '--prompt', 'A replacement request must not overwrite the receipt', '--receipt', receipt);
  assert.notEqual(duplicate.code, 0); assert.equal(await readFile(receipt, 'utf8'), original);
  assert.equal(f.executions.length, 1); assert.equal(f.methods.length, methodCount);
});

test('execution CLI keeps an uncertain execution queryable without retrying or releasing it', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { hold: true });
  const receipt = join(f.root, 'uncertain.json'); f.expectReceipt(receipt);
  const output = await f.run('run', f.clientFile, '--prompt', 'Synthetic uncertain task', '--receipt', receipt, '--timeout-ms', '40');
  assert.equal(output.code, 2, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.state, 'unknown'); assert.equal(f.executions.length, 1);
  assert.ok(result.runId); assert.equal(JSON.parse(await readFile(receipt, 'utf8')).runId, result.runId);
  assert.deepEqual(f.methods, ['inventory', 'prepare', 'execute']);
  const status = await f.run('status', f.clientFile, '--receipt', receipt);
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'unknown');
  assert.deepEqual(f.methods, ['inventory', 'prepare', 'execute', 'getExecution']);
});

test('execution CLI validates prompt choices and receipt ownership before sending device requests', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const receipt = join(f.root, 'invalid.json');
  for (const args of [
    ['run', f.clientFile, '--receipt', receipt],
    ['run', f.clientFile, '--prompt', 'one', '--prompt-file', join(f.root, 'missing.txt'), '--receipt', receipt],
    ['run', f.clientFile, '--prompt', 'one', '--timeout-ms', '0', '--receipt', receipt],
  ]) {
    const output = await f.run(...args); assert.notEqual(output.code, 0);
  }
  assert.deepEqual(f.methods, []);
  const foreignRunId = randomUUID();
  await writeFile(receipt, JSON.stringify({ version: 1, clientId: randomUUID(), nodeId: f.pairing.nodeId, runId: foreignRunId,
    input: { provider: 'codex', runId: foreignRunId, prompt: 'Synthetic foreign request' }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const output = await f.run('status', f.clientFile, '--receipt', receipt);
  assert.notEqual(output.code, 0); assert.deepEqual(f.methods, []);
});

test('execution CLI distinguishes a known model preflight failure from an uncertain dispatch', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { models: ['advertised-model'] });
  const receipt = join(f.root, 'not-submitted.json'); f.expectReceipt(receipt);
  const output = await f.run('run', f.clientFile, '--prompt', 'Synthetic request must remain unsubmitted', '--model', 'not-advertised', '--receipt', receipt);
  assert.equal(output.code, 1, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.state, null); assert.equal(result.submission, 'not_submitted'); assert.equal(result.error, 'model_unavailable');
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).input.model, 'not-advertised');
  assert.deepEqual(f.methods, ['inventory']); assert.equal(f.executions.length, 0);
});

test('execution CLI interruption stops observation without claiming native cancellation', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { hold: true });
  const receipt = join(f.root, 'interrupted.json'); f.expectReceipt(receipt);
  const running = startCli(f.root, ['run', f.clientFile, '--prompt', 'Synthetic interrupted task', '--receipt', receipt]);
  await until(() => f.executions.length === 1);
  assert.equal(running.child.kill('SIGINT'), true);
  const output = await running.done;
  assert.equal(output.code, 130, output.stderr); assert.equal(output.signal, null);
  const result = JSON.parse(output.stdout);
  assert.equal(result.state, 'unknown'); assert.ok(result.runId);
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).runId, result.runId);
  assert.deepEqual(f.methods, ['inventory', 'prepare', 'execute']);
});
