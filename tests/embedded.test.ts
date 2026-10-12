import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexExecutor, createCodexRuntime } from '../packages/drivers/src/codex.ts';
import { CodexHost, type CodexHostInput } from '../packages/drivers/src/codex-host.ts';
import { type CodexEvidence } from '../packages/drivers/src/codex.ts';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { AnswerBudget, MAX_ANSWER_BYTES, MAX_OBSERVATION_BYTES, boundedObservation, readBoundedText } from '../packages/drivers/src/output-limits.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { ZCodeExecutor } from '../packages/drivers/src/zcode.ts';
import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';

test('embedding excludes host credentials while retaining the configured execution environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-embedded-env-'));
  const fixture = join(root, 'agent.mjs');
  const name = 'HUTIAN_EMBEDDED_TEST_SECRET';
  const previous = process.env[name];
  process.env[name] = 'synthetic-secret';
  const runtime = createCodexRuntime({ cwd: root, codexHome: root, stateDir: join(root, 'state') }, [process.execPath, fixture]);
  try {
    await writeFile(fixture, `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(q.id===undefined)continue;
 const result=q.method==='initialize'?{protocolVersion:1,agentCapabilities:{},authMethods:[]}:{secretPresent:process.env.${name}!==undefined,home:process.env.CODEX_HOME,pathPresent:typeof process.env.PATH==='string'};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`);
    const observed = await runtime.dockControl({ command: { operation: 'inspect' }, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(observed, { secretPresent: false, home: root, pathPresent: true });
  } finally {
    await runtime.shutdown();
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    await rm(root, { recursive: true });
  }
});

test('a recovered unknown run is observable and cannot be dispatched a second time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-embedded-identity-'));
  try {
    await mkdir(join(root, 'runs'));
    const runId = 'caller-owned-run', fingerprint = createHash('sha256').update(runId).digest('hex');
    await writeFile(join(root, 'runs', `${fingerprint}.json`), JSON.stringify({ runId, state: 'unknown', messages: [] }));
    const executor = new CodexExecutor({ cwd: root, codexHome: root, stateDir: root });
    assert.equal((await executor.evidence(runId))?.state, 'unknown');
    assert.equal(await executor.reconcile(runId, new AbortController().signal), null);
    await assert.rejects(executor.execute({ runId, model: 'unused', prompt: 'must not execute', signal: new AbortController().signal,
      onReady: async () => { assert.fail('a previous run must not be dispatched'); }, onEvent: async () => {} }), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true }); }
});

test('embedded owner reuses one backend, fences each turn and releases it on failure or close', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-warm-'));
  const fixture = join(root, 'agent.mjs');
  const log = join(root, 'calls.jsonl');
  await writeFile(fixture, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let turn = 0;
const configOptions = [{id:'model',name:'Model',category:'model',type:'select',currentValue:'synthetic',options:[{value:'synthetic',name:'Synthetic'}]}];
for await (const line of createInterface({input:process.stdin})) {
 const q=JSON.parse(line); appendFileSync(${JSON.stringify(log)},JSON.stringify({method:q.method,pid:process.pid})+'\\n');
 if(q.id===undefined)continue;
 let result={};
 if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
 if(q.method==='_harness-dock/control')result={models:[{id:'synthetic',supportedReasoningEfforts:[]}],config:{sandbox:null,approvalPolicy:null,nativeMemoryDisabled:false}};
 if(q.method==='session/new')result={sessionId:'synthetic-thread',configOptions};
 if(q.method==='session/load'||q.method==='session/set_config_option')result={configOptions};
 if(q.method==='session/prompt') {
  const turnId='turn-'+(++turn);
  const update = value => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-thread',update:{sessionUpdate:'session_info_update',_meta:{'harness-dock':{version:1,...value}}}}});
  update({event:{kind:'turn_started',threadId:'synthetic-thread',turnId}});
  update({messageCompleted:{messageId:'message-'+turn,providerTurnId:turnId,phase:'final_answer',text:q.params.prompt?.[0]?.text==='oversize'?'x'.repeat(${MAX_ANSWER_BYTES + 1}):'synthetic'}});
  result={stopReason:'end_turn'};
 }
 send({jsonrpc:'2.0',id:q.id,result});
}`);
  const executor = new CodexExecutor({ cwd: root, codexHome: root, stateDir: root }, config => createCodexRuntime(config, [process.execPath, fixture]));
  const { readFile } = await import('node:fs/promises');
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {method:string;pid:number});
  let ready = 0;
  const input = { model: 'synthetic', prompt: 'synthetic', signal: AbortSignal.timeout(10000), onReady: async () => { ready++; }, onEvent: async () => {} };
  try {
    const inspection = await executor.inspect(input.signal);
    assert.equal(inspection.config.sandbox, null);
    assert.equal(inspection.config.approvalPolicy, null);
    // Inspect uses the configured ACP peer and releases its separate process.
    await writeFile(log, '');
    const first = await executor.execute({ ...input, runId: 'first' });
    const second = await executor.execute({ ...input, runId: 'second', resumeThreadId: first.threadId, previousRunId: first.runId });
    assert.equal(first.state, 'completed');
    assert.equal(second.state, 'completed');
    assert.notEqual(first.turnId, second.turnId);
    assert.equal(ready, 2);
    const observed = await calls();
    assert.equal(new Set(observed.map(call => call.pid)).size, 1);
    assert.equal(observed.filter(call => call.method === 'initialize').length, 1);
    assert.equal(observed.filter(call => call.method === 'session/new').length, 1);
    assert.equal(observed.filter(call => call.method === 'session/load').length, 0);
    assert.equal(observed.filter(call => call.method === 'session/prompt').length, 2);
    await assert.rejects(executor.execute({ ...input, runId: 'wrong', resumeThreadId: 'another-thread' }), /identity_mismatch/);
    await assert.rejects(executor.execute({ ...input, runId: 'third', resumeThreadId: first.threadId, onReady: async () => { throw new Error('fence-rejected'); } }), /fence-rejected/);
    assert.equal((await calls()).filter(call => call.method === 'session/prompt').length, 2);
    // Rejected admission closed the previous process; only an explicit new run resumes.
    const fourth = await executor.execute({ ...input, runId: 'fourth', resumeThreadId: first.threadId });
    assert.equal(fourth.state, 'completed');
    await executor.close();
    // Idle process release keeps the original native thread loadable on an explicit new run.
    const fifth = await executor.execute({ ...input, runId: 'fifth', resumeThreadId: first.threadId });
    assert.equal(fifth.threadId, first.threadId);
    assert.equal(fifth.state, 'completed');
    await executor.close();
    const after = await calls();
    assert.equal(new Set(after.map(call => call.pid)).size, 3);
    assert.equal(after.filter(call => call.method === 'session/load').length, 2);
    for (const pid of new Set(after.map(call => call.pid))) assert.throws(() => process.kill(pid, 0));
    await assert.rejects(executor.execute({ ...input, runId: 'oversize', prompt: 'oversize', resumeThreadId: first.threadId }), /resource_exhausted:answer_bytes/);
    const oversized = await executor.evidence('oversize');
    assert.equal(oversized?.state, 'unknown');
    assert.deepEqual(oversized?.messages, []);
    assert.equal(oversized?.threadId, first.threadId);
  } finally { await executor.close(); await rm(root, { recursive: true, force: true }); }
});

test('device idle release waits for an active approval and fences shutdown against in-flight provider close', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-idle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let allow!: (decision: 'allow' | 'deny') => void;
  const approval = new Promise<'allow' | 'deny'>(resolve => { allow = resolve; });
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let permissionRequested = false, closeCalls = 0;
  class HeldCodex extends CodexHost {
    override async inspect() {
      return { models: [{ id: 'synthetic', efforts: [], serviceTiers: [] }],
        config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } };
    }
    override async execute(input: CodexHostInput<unknown>): Promise<CodexEvidence> {
      await input.onReady('synthetic-thread');
      await input.permission!({ id: 'approval', title: 'synthetic', details: {}, canAllow: true }, input.signal, Promise.resolve());
      return { runId: input.runId, fingerprint: 'synthetic', state: 'completed', threadId: 'synthetic-thread', turnId: 'turn',
        messages: [{ id: 'reply', phase: 'final_answer', text: 'synthetic' }] };
    }
    override async close() { closeCalls++; await closing; }
  }
  const host = new DeviceHost({ mode: 'device', nodeId: 'synthetic-idle-node', token: 'synthetic'.repeat(5), endpoint: 'ws://127.0.0.1:1/',
    cwd: root, stateDir: join(root, 'state'), resources: { idleTimeoutMs: 30 },
    providers: { lobi: { disabled: true }, zcode: { disabled: true }, 'deepseek-harness': { disabled: true } } }, new HeldCodex());
  t.after(async () => { allow('deny'); finishClose(); await host.close(); });
  host.bind(async (_method, value) => {
    if ((value as { kind: string }).kind === 'permission') { permissionRequested = true; return approval; }
    return null;
  });
  await host.inventory();
  await host.prepare({ runId: 'first', sessionKey: 'session' });
  const run = host.execute({ provider: 'codex', runId: 'first', sessionKey: 'session', model: 'synthetic', prompt: 'synthetic', retainSession: true });
  for (let n = 0; n < 100 && !permissionRequested; n++) await delay(5);
  assert.equal(permissionRequested, true);
  await delay(75);
  assert.equal(closeCalls, 0);
  await assert.rejects(host.release('first'), /busy/);
  allow('deny'); await run;
  for (let n = 0; n < 100 && closeCalls === 0; n++) await delay(5);
  assert.equal(closeCalls, 1);
  await assert.rejects(host.prepare({ runId: 'second' }), /busy/);
  let stopped = false;
  const stop = host.close().then(() => { stopped = true; });
  await delay(20);
  assert.equal(stopped, false);
  finishClose(); await stop;
  assert.equal(stopped, true);
  await assert.rejects(host.execute({ provider: 'codex', runId: 'second', prompt: 'must not start' }), /device_stopping/);
});

test('output budgets preserve explicit omission and reject oversized evidence before allocating the file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-output-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const budget = new AnswerBudget();
  budget.add('a'.repeat(MAX_ANSWER_BYTES));
  assert.throws(() => budget.add('字'), /resource_exhausted:answer_bytes/);
  const large = { type: 'text_delta', text: 'x'.repeat(MAX_OBSERVATION_BYTES) };
  assert.deepEqual(boundedObservation('event', large), {
    type: 'observation_omitted', reason: 'observation_bytes_exceeded', originalKind: 'event', bytes: Buffer.byteLength(JSON.stringify(large)),
  });
  const path = join(root, 'large.txt'); await writeFile(path, 'oversized');
  await assert.rejects(readBoundedText(path, 4), /resource_exhausted:file_bytes/);
  assert.equal(await readBoundedText(path, 20), 'oversized');
});

test('a released ZCode warm session explicitly rejects resume without starting a replacement provider', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-zcode-expiry-'));
  const audit = join(root, 'audit'), stateDir = join(root, 'state');
  const executor = new ZCodeExecutor({ cwd: root, stateDir, zcodeHome: root, zcodeBin: process.execPath }, async () => createAcpRuntime({
    cwd: root, sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { zcode: [process.execPath, resolve('tests/fixtures/zcode-acp.mjs')] } }),
    agentProcessEnv: { DOCK_AUDIT: audit }, permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false,
  }));
  t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }); });
  const input = { runId: 'first', prompt: 'synthetic', signal: AbortSignal.timeout(5000), onReady: async () => {}, onEvent: async () => {} };
  assert.equal((await executor.execute(input)).state, 'completed');
  const sessionId = executor.retainedSessionId;
  assert.ok(sessionId);
  await executor.close();
  const before = await readFile(audit, 'utf8');
  const expired = await executor.execute({ ...input, runId: 'second', resumeThreadId: sessionId });
  assert.deepEqual(expired, { state: 'failed', error: 'zcode_session_unavailable' });
  assert.equal(await readFile(audit, 'utf8'), before);
});

test('device admission and approval fences survive duplicate requests, cancellation races and detached callbacks', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-control-'));
  let current!: CodexHostInput<unknown>, finish!: (result: CodexEvidence) => void, starts = 0;
  const host = new DeviceHost({ mode: 'device', nodeId: 'control-node', token: 'synthetic'.repeat(5), endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { home: root }, lobi: { disabled: true }, zcode: { disabled: true }, 'deepseek-harness': { disabled: true } } }, {
    inspect: async () => ({ models: [{ id: 'synthetic', efforts: [], serviceTiers: [] }], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } }),
    execute: async input => { starts++; current = input; await input.onReady('thread'); return new Promise(resolve => { finish = resolve; }); },
    close: async () => {}, reconcile: async () => null,
  });
  t.after(async () => { finish?.({ runId: current.runId, fingerprint: 'synthetic', state: 'cancelled', messages: [] }); await host.close(); await rm(root, { recursive: true, force: true }); });
  let decide!: (value: string) => void;
  host.bind(async (_method, value) => (value as { kind: string }).kind === 'permission' ? new Promise(resolve => { decide = resolve; }) : null);
  await host.inventory(); await host.prepare({ runId: 'first' });
  const input = { provider: 'codex', runId: 'first', model: 'synthetic', prompt: 'synthetic' };
  const run = host.execute(input);
  for (let i = 0; i < 100 && !finish; i++) await delay(5);
  const duplicate = host.execute(input);
  await assert.rejects(host.execute({ ...input, prompt: 'different' }), /identity_conflict/);
  await assert.rejects(host.execute({ ...input, runId: 'second' }), /busy/);
  assert.equal(starts, 1);
  const request = { id: 'permission', title: 'synthetic', details: {}, canAllow: true };
  const pending = current.permission!(request, current.signal, Promise.resolve());
  await host.cancel('first');
  assert.equal(host.getExecution('first')?.state, 'running'); // Requesting cancel is not terminal evidence.
  decide('allow'); assert.equal(await pending, 'deny');
  finish({ runId: 'first', fingerprint: 'synthetic', state: 'completed', messages: [] });
  assert.deepEqual(await duplicate, await run);
  assert.equal(host.getExecution('first')?.state, 'completed');
  const oldCallback = current.permission!;
  await host.prepare({ runId: 'second' });
  const second = host.execute({ ...input, runId: 'second' });
  for (let i = 0; i < 100 && starts < 2; i++) await delay(5);
  assert.equal(await oldCallback(request, new AbortController().signal, Promise.resolve()), 'deny');
  const unbind = host.bind(async () => { throw new Error('connection lost'); });
  assert.equal(await current.permission!(request, current.signal, Promise.resolve()), 'deny');
  unbind();
  assert.equal(await current.permission!(request, current.signal, Promise.resolve()), 'deny');
  host.bind(async () => 'allow');
  assert.equal(await current.permission!({ ...request, canAllow: false }, current.signal, Promise.resolve()), 'deny');
  assert.equal(await current.permission!(request, current.signal, Promise.resolve()), 'allow');
  finish({ runId: 'second', fingerprint: 'synthetic', state: 'completed', messages: [] }); await second;
});
