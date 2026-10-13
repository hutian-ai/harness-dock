import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { methods } from '@agentclientprotocol/sdk';
import { probeAcpSession } from '../packages/drivers/src/acp-probe.ts';

type Audit = { kind: string; pid?: number; cwd?: string; method?: string; endpoint?: string };

async function fixture(t: TestContext, scenario = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'dock-acp-probe-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = join(directory, 'audit.jsonl'), script = join(directory, 'peer.mjs');
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const scenario = process.argv[2], audit = process.env.DOCK_PROBE_AUDIT;
const record = value => appendFileSync(audit, JSON.stringify(value) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
record({ kind: 'started', pid: process.pid, cwd: process.cwd() });
let mcp;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  record({ kind: 'request', method: request.method });
  if (request.method === 'initialize') {
    if (scenario === 'abort') return;
    if (scenario === 'exit-with-pipe') {
      const descendant = spawn(process.execPath, ['-e',
        "const {appendFileSync}=require('node:fs');setTimeout(()=>{appendFileSync(process.argv[1],JSON.stringify({kind:'descendant-stopped',pid:process.pid})+'\\\\n')},2000)", audit],
        { stdio: ['ignore', process.stdout, process.stderr] });
      record({ kind: 'descendant', pid: descendant.pid });
      descendant.unref();
      process.exit(0);
    }
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: scenario === 'wrong-version' ? 999 : 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [],
    } });
  } else if (request.method === 'session/new') {
    const descriptor = request.params.mcpServers[0];
    const env = Object.fromEntries(descriptor.env.map(entry => [entry.name, entry.value]));
    record({ kind: 'mcp-endpoint', endpoint: env.HARNESS_DOCK_MCP_ENDPOINT });
    mcp = spawn(descriptor.command, descriptor.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    record({ kind: 'mcp-started', pid: mcp.pid });
    mcp.stderr.resume();
    mcp.once('exit', () => record({ kind: 'mcp-stopped', pid: mcp.pid }));
    createInterface({ input: mcp.stdout }).on('line', line => {
      const response = JSON.parse(line);
      if (response.id === 1) {
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\\n');
      }
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-probe', version: '1' },
    } }) + '\\n');
    send({ jsonrpc: '2.0', id: request.id, result: {
      sessionId: 'synthetic-probe-session',
      modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] },
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'synthetic-model', options: [{ value: 'synthetic-model', name: 'Synthetic' }] }],
    } });
  }
});
process.stdin.once('end', () => {
  record({ kind: 'stdin-ended' });
  mcp?.stdin.end();
});
`);
  const entries = async (): Promise<Audit[]> => (await readFile(audit, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Audit);
  return {
    entries,
    options: (signal: AbortSignal) => ({
      executable: process.execPath, args: () => [script, scenario],
      env: { DOCK_PROBE_AUDIT: audit }, signal, label: 'Synthetic',
    }),
  };
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Synthetic probe observation timed out');
    await delay(10);
  }
}

async function assertClean(peer: Awaited<ReturnType<typeof fixture>>) {
  const entries = await peer.entries();
  const started = entries.find(entry => entry.kind === 'started');
  assert.ok(started?.cwd);
  await assert.rejects(stat(started.cwd), { code: 'ENOENT' });
  const methodsSeen = entries.filter(entry => entry.kind === 'request').map(entry => entry.method);
  assert.equal(methodsSeen.filter(method => method === methods.agent.initialize).length, 1);
  assert.ok(methodsSeen.every(method => !['session/prompt', 'session/cancel', 'session/request_permission'].includes(method ?? '')));
  for (const entry of entries.filter(entry => ['started', 'mcp-started'].includes(entry.kind))) {
    assert.ok(entry.pid);
    assert.throws(() => process.kill(entry.pid!, 0), { code: 'ESRCH' });
  }
  const endpoint = entries.find(entry => entry.kind === 'mcp-endpoint')?.endpoint;
  if (endpoint && process.platform !== 'win32')
    await assert.rejects(stat(dirname(endpoint)), { code: 'ENOENT' });
}

test('probe preserves Provider metadata and MCP discovery while closing its connection and processes', { timeout: 10_000 }, async t => {
  const peer = await fixture(t);
  const result = await probeAcpSession(peer.options(new AbortController().signal), ({ session }) => ({
    modes: session.modes?.availableModes.map(mode => mode.id), configOptions: session.configOptions,
  }));
  assert.deepEqual(result.modes, ['build', 'plan']);
  assert.equal(result.configOptions?.[0]?.currentValue, 'synthetic-model');
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.loadSession, true);
  assert.equal(result.resumeSession, true);
  assert.equal(result.mcpTools, true);
  await assertClean(peer);
  assert.equal((await peer.entries()).filter(entry => entry.method === 'session/new').length, 1);
});

test('inspect failure rejects pending ACP work and cleans the Provider, bridge and temporary directory', { timeout: 10_000 }, async t => {
  const peer = await fixture(t), failure = new Error('synthetic-inspect-failed');
  let pending: Promise<unknown> | undefined;
  await assert.rejects(probeAcpSession(peer.options(new AbortController().signal), ({ agent }) => {
    pending = agent.request('synthetic/pending', {});
    void pending.catch(() => undefined);
    throw failure;
  }), error => error === failure);
  assert.ok(pending);
  await assert.rejects(pending, /connection closed/i);
  await assertClean(peer);
  assert.equal((await peer.entries()).filter(entry => entry.method === 'session/new').length, 1);
});

test('aborting unanswered initialize retires the probe without creating or resubmitting a session', { timeout: 10_000 }, async t => {
  const peer = await fixture(t, 'abort'), controller = new AbortController();
  let inspected = false;
  const probe = probeAcpSession(peer.options(controller.signal), () => { inspected = true; return {}; });
  const rejected = assert.rejects(probe, { name: 'AbortError' });
  await until(async () => (await peer.entries()).some(entry => entry.method === 'initialize'));
  controller.abort();
  await rejected;
  assert.equal(inspected, false);
  assert.equal((await peer.entries()).some(entry => entry.method === 'session/new'), false);
  await assertClean(peer);
});

test('Provider exit fails promptly even while a descendant holds its stdout pipe', { timeout: 10_000 }, async t => {
  const peer = await fixture(t, 'exit-with-pipe');
  await assert.rejects(probeAcpSession(peer.options(new AbortController().signal), () => ({})), /exited during initialize \(0\)/);
  assert.equal((await peer.entries()).some(entry => entry.kind === 'descendant-stopped'), false);
  await assertClean(peer);
  await until(async () => (await peer.entries()).some(entry => entry.kind === 'descendant-stopped'));
  const descendant = (await peer.entries()).find(entry => entry.kind === 'descendant');
  assert.ok(descendant?.pid);
  await until(async () => {
    try { process.kill(descendant.pid!, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  });
});

test('unsupported ACP version is rejected before session creation', { timeout: 10_000 }, async t => {
  const peer = await fixture(t, 'wrong-version');
  await assert.rejects(probeAcpSession(peer.options(new AbortController().signal), () => ({})), /Unsupported ACP protocol version 999/);
  assert.equal((await peer.entries()).some(entry => entry.method === 'session/new'), false);
  await assertClean(peer);
});
