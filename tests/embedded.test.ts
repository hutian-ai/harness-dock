import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexExecutor, createCodexRuntime } from '../packages/drivers/src/codex.ts';
import { CodexHost, type CodexHostInput } from '../packages/drivers/src/codex-host.ts';
import { type CodexEvidence } from '../packages/drivers/src/codex.ts';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { AnswerBudget, MAX_ANSWER_BYTES, MAX_OBSERVATION_BYTES, boundedObservation, readBoundedText } from '../packages/drivers/src/output-limits.ts';
import { setTimeout as delay } from 'node:timers/promises';

test('embedding excludes host credentials while retaining the configured execution environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-embedded-env-'));
  const fixture = join(root, 'agent.mjs');
  const name = 'HUTIAN_EMBEDDED_TEST_SECRET';
  const previous = process.env[name];
  const inheritedNames = ['ACPX_AUTH_DOCK_AMBIENT', 'ACPX_AUTH_DOCK_LATE', 'LC_DOCK_SECRET', 'XDG_DOCK_SECRET'];
  const inheritedPrevious = new Map(inheritedNames.map(key => [key, process.env[key]]));
  for (const key of inheritedNames.filter(key => key !== 'ACPX_AUTH_DOCK_LATE')) process.env[key] = 'synthetic-parent-secret';
  const previousNode = process.env.CODEX_MCP_NODE_PATH, previousPipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env[name] = 'synthetic-secret';
  process.env.CODEX_MCP_NODE_PATH = '/synthetic/native-node';
  process.env.CODEX_APP_TOOLS_PIPE_PATH = '/synthetic/another-chat';
  const runtime = createCodexRuntime({ cwd: root, codexHome: root, stateDir: join(root, 'state'), codexBin: '/synthetic/codex', nativeNode: '/synthetic/native-node', skillDirectory: '/synthetic/skills',
    environment: { HTTPS_PROXY: 'http://proxy.example.test:8080', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem', CODEX_HOME: '/wrong-home', ACPX_AUTH_DOCK_EXPLICIT: 'synthetic-explicit-grant' } }, [process.execPath, fixture]);
  process.env.ACPX_AUTH_DOCK_LATE = 'synthetic-late-parent-secret';
  try {
    await writeFile(fixture, `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(q.id===undefined)continue;
 const result=q.method==='initialize'?{protocolVersion:1,agentCapabilities:{},authMethods:[]}:{secretPresent:process.env.${name}!==undefined,inheritedNames:Object.keys(process.env).filter(key=>${JSON.stringify(inheritedNames)}.includes(key)),explicitGrant:process.env.ACPX_AUTH_DOCK_EXPLICIT,home:process.env.CODEX_HOME,pathPresent:typeof process.env.PATH==='string',binary:process.env.CODEX_PATH,skillRoot:process.env.HARNESS_DOCK_SKILL_ROOT,nativeNode:process.env.CODEX_MCP_NODE_PATH,pipePresent:process.env.CODEX_APP_TOOLS_PIPE_PATH!==undefined,proxy:process.env.HTTPS_PROXY,certificate:process.env.NODE_EXTRA_CA_CERTS};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`);
    const observed = await runtime.dockControl({ command: { operation: 'inspect' }, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(observed, { secretPresent: false, inheritedNames: [], explicitGrant: 'synthetic-explicit-grant', home: root, pathPresent: true, binary:'/synthetic/codex', skillRoot:'/synthetic/skills',nativeNode:'/synthetic/native-node',pipePresent:false,
      proxy:'http://proxy.example.test:8080',certificate:'/synthetic/ca.pem' });
  } finally {
    await runtime.shutdown();
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    for (const [key, value] of inheritedPrevious) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (previousNode === undefined) delete process.env.CODEX_MCP_NODE_PATH; else process.env.CODEX_MCP_NODE_PATH = previousNode;
    if (previousPipe === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH; else process.env.CODEX_APP_TOOLS_PIPE_PATH = previousPipe;
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
const configOptions = [{id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'workspace-write',options:[{value:'workspace-write',name:'Workspace access'},{value:'synthetic-mode',name:'Native test mode',description:'Upstream description'},{value:'unconfirmed-mode',name:'Unconfirmed choice'}]}, {id:'model',name:'Model',category:'model',type:'select',currentValue:'synthetic',options:[{value:'synthetic',name:'Synthetic'},{value:'second-model',name:'Second'}]}, {id:'reasoning_effort',name:'Effort',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}, {id:'fast-mode',name:'Fast',type:'select',currentValue:'off',options:[{value:'on',name:'On'},{value:'off',name:'Off'}]}];
for await (const line of createInterface({input:process.stdin})) {
 const q=JSON.parse(line); appendFileSync(${JSON.stringify(log)},JSON.stringify({method:q.method,pid:process.pid,params:q.params})+'\\n');
 if(q.id===undefined)continue;
 let result={};
 if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
 if(q.method==='_harness-dock/control')result={models:[{id:'synthetic',supportedReasoningEfforts:[]}],config:{sandbox:null,approvalPolicy:null,nativeMemoryDisabled:false}};
 if(q.method==='session/new')result={sessionId:'synthetic-thread',configOptions,modes:{currentModeId:'workspace-write',availableModes:[{id:'workspace-write',name:'Workspace access'},{id:'synthetic-mode',name:'Native test mode'}]}};
 if(q.method==='session/load'||q.method==='session/set_config_option') { if(q.method==='session/set_config_option' && q.params.configId==='mode' && q.params.value!=='unconfirmed-mode')configOptions.find(option=>option.id==='mode').currentValue=q.params.value; result={configOptions}; }
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
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {method:string;pid:number;params?:{configId?:string;value?:string}});
  let ready = 0;
  const input = { model: 'synthetic', prompt: 'synthetic', get signal() { return AbortSignal.timeout(10000); }, onReady: async () => { ready++; }, onEvent: async () => {} };
  try {
    const inspection = await executor.inspect(input.signal);
    assert.equal(inspection.config.sandbox, null);
    assert.equal(inspection.config.approvalPolicy, null);
    assert.deepEqual(inspection.permissionModes, [{value:'workspace-write',name:'Workspace access'}, {value:'synthetic-mode',name:'Native test mode',description:'Upstream description'},{value:'unconfirmed-mode',name:'Unconfirmed choice'}]);
    // Inspect uses the configured ACP peer and releases its separate process.
    await writeFile(log, '');
    const first = await executor.execute({ ...input, runId: 'first' });
    const second = await executor.execute({ ...input, runId: 'second', mode: 'synthetic-mode', model: 'second-model', effort: 'high', serviceTier: 'priority', resumeThreadId: first.threadId, previousRunId: first.runId });
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
    for (const [configId, value] of [['model','second-model'], ['reasoning_effort','high'], ['fast-mode','on']])
      assert.ok(observed.some(call => call.method === 'session/set_config_option' && call.params?.configId === configId && call.params?.value === value));
    assert.ok(observed.some(call => call.method === 'session/set_config_option' && call.params?.configId === 'mode' && call.params.value === 'synthetic-mode'));
    await assert.rejects(executor.execute({ ...input, runId: 'wrong', resumeThreadId: 'another-thread' }), /identity_mismatch/);
    await assert.rejects(executor.execute({ ...input, runId: 'third', resumeThreadId: first.threadId, onReady: async () => { throw new Error('fence-rejected'); } }), /fence-rejected/);
    assert.equal((await calls()).filter(call => call.method === 'session/prompt').length, 2);
    assert.equal((await calls()).filter(call => call.method === 'session/set_config_option' && call.params?.configId === 'mode').at(-1)?.params?.value,'workspace-write');
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
    await assert.rejects(executor.execute({ ...input, runId: 'withdrawn', mode: 'no-longer-advertised', resumeThreadId: first.threadId }), /permission_mode_unavailable/);
    await assert.rejects(executor.execute({ ...input, runId: 'unconfirmed', mode: 'unconfirmed-mode', resumeThreadId: first.threadId }), /permission_mode_unconfirmed/);
    assert.equal((await calls()).filter(call => call.method === 'session/prompt').length, after.filter(call => call.method === 'session/prompt').length);
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
  const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 1.0.0');\n`, { mode: 0o700 });
  let allow!: (decision: 'allow' | 'deny') => void;
  const approval = new Promise<'allow' | 'deny'>(resolve => { allow = resolve; });
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let permissionRequested = false, closeCalls = 0;
  class HeldCodex extends CodexHost {
    override async inspect() {
      return { models: [{ id: 'synthetic', efforts: [], serviceTiers: [] }], permissionModes:[{value:'native-mode',name:'Native'}],
        config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } };
    }
    override async execute(input: CodexHostInput<unknown>): Promise<CodexEvidence> {
      assert.equal(input.mode,'native-mode');
      await input.onReady('synthetic-thread');
      await input.permission!({ id: 'approval', title: 'synthetic', details: {}, canAllow: true }, input.signal, Promise.resolve());
      return { runId: input.runId, fingerprint: 'synthetic', state: 'completed', threadId: 'synthetic-thread', turnId: 'turn',
        messages: [{ id: 'reply', phase: 'final_answer', text: 'synthetic' }] };
    }
    override async close() { closeCalls++; await closing; }
  }
  const host = new DeviceHost({ mode: 'device', nodeId: 'synthetic-idle-node', token: 'synthetic'.repeat(5), endpoint: 'ws://127.0.0.1:1/',
    cwd: root, stateDir: join(root, 'state'), resources: { idleTimeoutMs: 30 },
    providers: { codex: { executable, home: root }, lobi: { disabled: true }, 'deepseek-harness': { disabled: true } } }, new HeldCodex());
  t.after(async () => { allow('deny'); finishClose(); await host.close(); });
  host.bind(async (_method, value) => {
    if ((value as { kind: string }).kind === 'permission') { permissionRequested = true; return approval; }
    return null;
  });
  await host.inventory();
  await host.prepare({ runId: 'first', sessionKey: 'session' });
  await assert.rejects(host.execute({ provider: 'codex', runId: 'first', sessionKey: 'session', model:'synthetic',prompt:'must not dispatch',config:{mode:'unknown'} }),/permission_mode_unavailable/);
  const run = host.execute({ provider: 'codex', runId: 'first', sessionKey: 'session', model: 'synthetic', prompt: 'synthetic', retainSession: true, config:{mode:'native-mode'} });
  for (let n = 0; n < 100 && !permissionRequested; n++) await delay(5);
  assert.equal(permissionRequested, true);
  await delay(75);
  assert.equal(closeCalls, 0);
  await assert.rejects(host.release('first'), /busy/);
  allow('deny'); await run;
  for (let n = 0; n < 100 && closeCalls === 0; n++) await delay(5);
  assert.equal(closeCalls, 2);
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

test('device admission and approval fences survive duplicate requests, cancellation races and detached callbacks', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dock-control-')));
  const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 1.0.0');\n`, { mode: 0o700 });
  let current!: CodexHostInput<unknown>, finish!: (result: CodexEvidence) => void, starts = 0;
  const nativeInspection = { models: [{ id: 'synthetic', efforts: [], serviceTiers: [] }],
    config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } };
  const host = new DeviceHost({ mode: 'device', nodeId: 'control-node', token: 'synthetic'.repeat(5), endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'), resources: { maxConcurrentExecutions: 1 },
    providers: { codex: { executable, home: root, environment: { HTTPS_PROXY: 'http://proxy.example.test:8080' } }, lobi: { disabled: true }, 'deepseek-harness': { disabled: true } } }, {
    inspect: async environment => {
      assert.equal(environment.environment?.HTTPS_PROXY, 'http://proxy.example.test:8080');
      assert.equal(environment.codexHome, root);
      return nativeInspection;
    },
    execute: async input => { starts++; current = input;
      assert.equal(input.environment.environment?.HTTPS_PROXY, 'http://proxy.example.test:8080');
      await input.onReady('thread'); return new Promise(resolve => { finish = resolve; }); },
    close: async () => {}, reconcile: async () => null,
  });
  t.after(async () => { finish?.({ runId: current.runId, fingerprint: 'synthetic', state: 'cancelled', messages: [] }); await host.close(); await rm(root, { recursive: true, force: true }); });
  let decide!: (value: string) => void;
  host.bind(async (_method, value) => (value as { kind: string }).kind === 'permission' ? new Promise(resolve => { decide = resolve; }) : null);
  const inventory = await host.inventory() as { providers: { key: string; status: string; error?: string; models: string[]; inspection: unknown;
    capabilities: { sessionResume: string; resultQuery: string; callerSkills: boolean }; sessionResumeMode: string;
    readiness: { level: string; modelExecutionVerified: boolean } }[] };
  const reported = inventory.providers.find(provider => provider.key === 'codex')!;
  assert.equal(reported.status, 'ready', reported.error);
  assert.deepEqual(reported.inspection, nativeInspection); // Native fields remain available to existing consumers.
  assert.deepEqual(reported.models, ['synthetic']);
  assert.equal(reported.sessionResumeMode, 'native');
  assert.equal(reported.capabilities.resultQuery, 'native');
  assert.equal(reported.capabilities.callerSkills, true);
  assert.equal(reported.readiness.level, 'protocol');
  assert.equal(reported.readiness.modelExecutionVerified, false);
  assert.equal(JSON.stringify(inventory).includes('proxy.example.test'), false);
  assert.equal(starts, 0); // Ready reports protocol inspection, not a dispatched model turn.
  await host.prepare({ runId: 'first' });
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
  let confirmText!: () => void;
  const textReceipt = new Promise<void>(resolve => { confirmText = resolve; });
  host.bind(async (_method, value) => (value as {kind:string}).kind === 'event' ? textReceipt : 'allow');
  await current.onEvent({ type:'text_delta',messageId:'reply',stream:'output',text:'first' });
  await current.onEvent({ type:'text_delta',messageId:'reply',stream:'output',text:'last' });
  // Permission transport remains independent of a slow observation receipt.
  assert.equal(await current.permission!(request, current.signal, Promise.resolve()), 'allow');
  finish({ runId: 'second', fingerprint: 'synthetic', state: 'completed', messages: [] });
  await delay(10);
  assert.equal(host.getExecution('second')?.state,'running');
  confirmText(); await second;
  assert.equal(host.getExecution('second')?.state,'completed');
});

test('native option IDs and form answers survive ACP with a confirmed transport write', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-native-interaction-'));
  const fixture = join(root, 'agent.mjs'), audit = join(root, 'replies.jsonl');
  await writeFile(fixture, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let prompt;
const configOptions=[{id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'workspace-write',options:[{value:'workspace-write',name:'Workspace'}]},{id:'model',name:'Model',category:'model',type:'select',currentValue:'synthetic',options:[{value:'synthetic',name:'Synthetic'}]},{id:'fast-mode',name:'Fast',type:'select',currentValue:'off',options:[{value:'off',name:'Off'},{value:'on',name:'On'}]}];
const options=[{optionId:'one-file',name:'Read file',kind:'allow_once'},{optionId:'whole-directory',name:'Read directory',kind:'allow_once'}];
for await(const line of createInterface({input:process.stdin})){
 const q=JSON.parse(line);if(q.id===undefined)continue;
 if(!q.method){
  appendFileSync(${JSON.stringify(audit)},JSON.stringify(q)+'\\n');
  if(q.id==='approval'){send({id:'question',method:'elicitation/create',params:{sessionId:'native-thread',mode:'form',message:'Color?',requestedSchema:{type:'object',properties:{color:{type:'string',enum:['red','blue']}},required:['color']}}});}
  if(q.id==='question')send({id:prompt,result:{stopReason:'end_turn'}});
  continue;
 }
 let result={};
 if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
 if(q.method==='session/new')result={sessionId:'native-thread',configOptions};
 if(q.method==='session/set_config_option')result={configOptions};
 if(q.method==='session/prompt'){
  prompt=q.id;send({method:'session/update',params:{sessionId:'native-thread',update:{sessionUpdate:'session_info_update',_meta:{'harness-dock':{version:1,event:{kind:'turn_started',threadId:'native-thread',turnId:'native-turn'}}}}}});
  send({id:'approval',method:'session/request_permission',params:{sessionId:'native-thread',toolCall:{toolCallId:'read',title:'Read',kind:'read',status:'pending'},options}});continue;
 }
 send({id:q.id,result});
}`);
  const executor = new CodexExecutor({ cwd:root,codexHome:root,stateDir:root }, config=>createCodexRuntime(config,[process.execPath,fixture]));
  const writes:Promise<void>[]=[];let calls=0;
  try {
    const result=await executor.execute({runId:'native',model:'synthetic',prompt:'synthetic',signal:AbortSignal.timeout(10000),onReady:async()=>{},onEvent:async()=>{},permission:async(request,_signal,responseSent)=>{
      calls++;writes.push(responseSent);
      if(request.options){assert.deepEqual(request.options.map(o=>o.optionId),['one-file','whole-directory']);return {optionId:'whole-directory'};}
      assert.equal(request.form?.mode,'form');return {action:'accept',content:{color:'blue'}};
    }});
    await Promise.all(writes);
    assert.equal(result.state,'completed');assert.equal(calls,2);
    const replies=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(replies.map(reply=>reply.result),[{outcome:{outcome:'selected',optionId:'whole-directory'}},{action:'accept',content:{color:'blue'}}]);
  }finally{await executor.close();await rm(root,{recursive:true,force:true});}
});

test('an unavailable optional desktop MCP is reported without blocking the native ACP turn', {timeout:15000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'dock-desktop-unavailable-')),fixture=join(root,'agent.mjs'),calls=join(root,'calls.jsonl');
  await writeFile(fixture,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const configOptions=[{id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'workspace-write',options:[{value:'workspace-write',name:'Workspace'}]},{id:'model',name:'Model',category:'model',type:'select',currentValue:'synthetic',options:[{value:'synthetic',name:'Synthetic'}]},{id:'fast-mode',name:'Fast',type:'select',currentValue:'off',options:[{value:'off',name:'Off'}]}];
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:q.method})+'\\n');if(q.id===undefined)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};if(q.method==='session/new')result={sessionId:'own-native-thread',configOptions};if(q.method==='session/set_config_option')result={configOptions};if(q.method==='_harness-dock/control')result={models:[{id:'synthetic'}],config:{sandbox:null,approvalPolicy:null},nativeHost:{status:'unavailable'}};
if(q.method==='session/load'){send({jsonrpc:'2.0',id:q.id,error:{code:-32603,message:'Empty probe thread has no rollout'}});continue;}
if(q.method==='session/prompt'){
 const update=value=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-native-thread',update:{sessionUpdate:'session_info_update',_meta:{'harness-dock':{version:1,...value}}}}});
 update({event:{kind:'turn_started',threadId:'own-native-thread',turnId:'own-native-turn'}});
 update({messageCompleted:{messageId:'own-message',providerTurnId:'own-native-turn',phase:'final_answer',text:'synthetic'}});
 result={stopReason:'end_turn'};
}
send({jsonrpc:'2.0',id:q.id,result});}`);
  const executor=new CodexExecutor({cwd:root,codexHome:root,stateDir:root,desktopHost:{pipePath:join(root,'host.sock'),nodePath:process.execPath}},config=>createCodexRuntime(config,[process.execPath,fixture]));
  try{
    const inspection=await executor.inspect(AbortSignal.timeout(10000));
    assert.equal(inspection.desktopHostState,'unavailable');
    assert.deepEqual(inspection.models,[{id:'synthetic',efforts:[],serviceTiers:[]}]);
    assert.deepEqual(await executor.inspect(AbortSignal.timeout(10000)),inspection);
    let started=0;
    const result=await executor.execute({runId:'optional-host-unavailable',model:'synthetic',prompt:'synthetic',signal:AbortSignal.timeout(10000),onReady:async threadId=>{assert.equal(threadId,'own-native-thread');started++;},onEvent:async()=>{}});
    assert.equal(started,1);
    assert.equal(result.state,'completed');
    assert.equal(result.turnId,'own-native-turn');
    const observed=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(observed.filter(call=>call.method==='session/prompt').length,1);
    // Only inventory inspects optional MCP status; execution uses the native tool catalog directly.
    assert.equal(observed.filter(call=>call.method==='_harness-dock/control').length,2);
    assert.equal(observed.filter(call=>call.method==='session/new').length,3);
    assert.equal(observed.filter(call=>call.method==='session/load').length,0);
  }finally{await executor.close();await rm(root,{recursive:true,force:true});}
});
