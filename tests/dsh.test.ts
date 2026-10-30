import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createDshRuntime, DshHost, prepareDshEnvironment, type DshHostInput } from '../packages/drivers/src/dsh.ts';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const model = JSON.stringify(['native provider', 'model id']);
const otherModel = JSON.stringify(['other provider', 'fast model']);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dock-dsh-')); temporary.push(directory);
  const home = join(directory, 'native'), stateDir = join(directory, 'dock-state'), skills = join(directory, 'caller-skills');
  await mkdir(home); await mkdir(skills);
  await writeFile(join(home, 'cordis.patch.yml'), 'native patch must remain');
  await writeFile(join(home, '.credentials.yaml'), 'synthetic native credentials');
  const executable = join(directory, 'dsh.mjs');
  await writeFile(executable, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const sessionId='native-session';
let prompt, current=${JSON.stringify(model)};
const options=()=>[{id:'model',name:'Model',type:'select',currentValue:current,options:[{group:'native provider',name:'Native',options:[{name:'Model',value:${JSON.stringify(model)}},{name:'Other Model',value:${JSON.stringify(otherModel)}}]}]},{id:'reasoning_effort',name:'Effort',type:'select',currentValue:current===${JSON.stringify(model)}?'high':'low',options:[{name:'Effort',value:current===${JSON.stringify(model)}?'high':'low'}]}];
const update=value=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:value}});
const answer=(text)=>update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text}});
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);
 if(!request.method){
  if(request.id==='native-permission'&&prompt){answer(JSON.stringify(request.result));send({jsonrpc:'2.0',id:prompt.id,result:{stopReason:'end_turn'}});prompt=undefined;}
  continue;
 }
 appendFileSync('requests.jsonl',JSON.stringify({method:request.method,params:request.params})+'\\n');
 let result={};
 if(request.method==='initialize')result={protocolVersion:1,agentInfo:{name:'deepseek-harness-acp',version:'fixture'},agentCapabilities:{sessionCapabilities:{resume:{},close:{},list:{}},mcpCapabilities:{http:true}},authMethods:[]};
 else if(request.method==='session/new')result={sessionId,configOptions:options()};
 else if(request.method==='session/resume')result={configOptions:options()};
 else if(request.method==='session/set_config_option'){if(request.params.configId==='model')current=request.params.value;result={configOptions:options()};}
 else if(request.method==='session/prompt'){
  const text=request.params.prompt[0].text;
  if(text==='invalid-stop'){answer('partial');send({jsonrpc:'2.0',id:request.id,result:{stopReason:'invented-stop'}});continue;}
  if(text==='permission'){
   prompt=request;
   update({sessionUpdate:'tool_call',toolCallId:'native-tool',title:'Native tool',kind:'execute',status:'in_progress',rawInput:{command:'synthetic command'}});
   send({jsonrpc:'2.0',id:'native-permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'native-tool'},options:[{optionId:'native-allow',name:'Allow once',kind:'allow_once'},{optionId:'native-reject',name:'Reject',kind:'reject_once'}]}});
   continue;
  }
  if(text==='eof'){
   const event={jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'partial',content:{type:'text',text:'partial'}}}};
   process.stdout.write(JSON.stringify(event)+'\\n',()=>process.exit(0));continue;
  }
  if(text==='cancel-without-terminal'){prompt=request;update({sessionUpdate:'agent_message_chunk',messageId:'partial',content:{type:'text',text:'started'}});continue;}
  if(text==='over-budget'){for(let i=0;i<9;i++)answer('x'.repeat(1024*1024));send({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}});continue;}
  answer('  committed\\n');answer('answer  ');result={stopReason:text==='native-cancel'?'cancelled':'end_turn'};
 }else if(request.method==='session/cancel'){process.exit(0);}
 if(request.id!==undefined)send({jsonrpc:'2.0',id:request.id,result});
}
`);
  await chmod(executable, 0o700);
  const environment = { cwd: directory, dshHome: home, dshBin: executable, stateDir, skillDirectory: skills };
  const host = new DshHost((config, _command, observers) => createDshRuntime(config, [process.execPath, executable], observers));
  const controller = new AbortController();
  const input = (overrides: Partial<DshHostInput> = {}): DshHostInput => ({
    environment, runId: 'run-1', prompt: 'text', retainSession: false, signal: controller.signal,
    tools: { name: 'controller', definitions: [], invocation: { signal: controller.signal, onToolCall: async () => assert.fail('no caller tool was mounted') } },
    onReady: async () => {}, onEvent: async () => {}, ...overrides,
  });
  return { directory, home, stateDir, environment, host, controller, input,
    requests: async () => (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
  };
}

test('DSH inspection reads opaque native models, effort and ACP capabilities without prompting', async () => {
  const f = await fixture();
  try {
    const value = await f.host.inspect(f.environment, f.controller.signal);
    assert.deepEqual(value.models, [{ id: model, efforts: ['high'] }, { id: otherModel, efforts: ['low'] }]);
    assert.equal(value.currentModelId, model);
    assert.equal(value.sessionResume, true);
    assert.deepEqual(value.mcpCapabilities, { http: true });
    assert.equal((await f.requests()).some(request => request.method === 'session/prompt'), false);
    assert.deepEqual((await f.requests()).filter(request => request.method === 'session/set_config_option').map(request => request.params.value), [otherModel, model]);
  } finally { await f.host.close(); }
});

test('DSH adds a named caller skill root while preserving native configuration and credentials', async () => {
  const f = await fixture();
  const before = await readdir(f.home);
  const prepared = await prepareDshEnvironment(f.environment);
  assert.deepEqual(await readdir(f.home), before);
  assert.equal(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8'), 'native patch must remain');
  assert.equal(await readFile(join(f.home, '.credentials.yaml'), 'utf8'), 'synthetic native credentials');
  assert.ok(prepared.patchPath?.startsWith(f.stateDir));
  const patch = JSON.parse(await readFile(prepared.patchPath!, 'utf8'));
  assert.deepEqual(patch, [{ insert: [{ id: 'harness-dock-caller-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: { providerName: 'harness-dock-caller', includeDefaultRoots: false, customSkillDirs: [f.environment.skillDirectory] } }] }]);
  await assert.rejects(prepareDshEnvironment({ ...f.environment, stateDir: join(f.home, 'nested') }), /dsh_state_must_be_separate/);
});

test('DSH launches the selected JavaScript installation with the daemon Node on a reduced PATH', async () => {
  const f = await fixture();
  const host = new DshHost();
  try {
    const value = await host.inspect({ ...f.environment, environment: { PATH: '/synthetic/no-commands' } }, f.controller.signal);
    assert.equal(value.currentModelId, model);
  } finally { await host.close(); }
});

test('DSH execution uses native options, retains same-session continuation and rejects replay', async () => {
  const f = await fixture();
  try {
    const first = await f.host.execute(f.input({ model, effort: 'high', retainSession: true }));
    assert.equal(first.state, 'completed');
    assert.equal(first.sessionId, 'native-session');
    assert.deepEqual(first.messages, [{ id: 'answer', text: '  committed\nanswer  ' }]);
    assert.equal(first.stopReason, 'end_turn');
    assert.equal('threadId' in first, false);
    const second = await f.host.execute(f.input({ runId: 'run-2', resumeThreadId: first.sessionId }));
    assert.equal(second.state, 'completed');
    await assert.rejects(f.host.execute(f.input()), { code: 'EEXIST' });
    const requests = await f.requests();
    assert.equal(requests.filter(request => request.method === 'session/prompt').length, 2);
    assert.equal(requests.filter(request => request.method === 'session/new').length, 1);
    assert.deepEqual(requests.filter(request => request.method === 'session/set_config_option').map(request => [request.params.configId, request.params.value]), [['model', model], ['reasoning_effort', 'high']]);
    assert.equal(requests.some(request => request.method === 'session/set_mode' || request.method === 'session/set_model' || request.method === 'dock/control'), false);
  } finally { await f.host.close(); }
});

test('DSH preserves native permission option identity and rejects legacy or stale decisions', async () => {
  for (const decision of [{ optionId: 'native-allow' }, 'allow', { optionId: 'invented' }] as const) {
    const f = await fixture();
    try {
      let requested = false, sent: Promise<void> | undefined;
      const evidence = await f.host.execute(f.input({ prompt: 'permission', permission: async (request, signal, responseSent) => {
        requested = true; sent = responseSent;
        assert.equal(signal.aborted, false);
        assert.equal(request.canAllow, true);
        assert.deepEqual(request.options?.map(option => option.optionId), ['native-allow', 'native-reject']);
        assert.equal((request.details as { rawInput: { command: string } }).rawInput.command, 'synthetic command');
        return decision;
      } }));
      assert.equal(requested, true); await sent;
      const result = JSON.parse(evidence.messages[0]!.text) as { outcome: { outcome: string; optionId?: string } };
      assert.deepEqual(result.outcome, typeof decision === 'object' && decision.optionId === 'native-allow'
        ? { outcome: 'selected', optionId: 'native-allow' } : { outcome: 'cancelled' });
    } finally { await f.host.close(); }
  }
});

test('DSH keeps EOF and locally aborted work unknown without a native terminal response', async () => {
  for (const prompt of ['eof', 'cancel-without-terminal']) {
    const f = await fixture();
    try {
      const evidence = await f.host.execute(f.input({ prompt, onEvent: async event => {
        if (prompt === 'cancel-without-terminal' && event.type === 'text_delta') f.controller.abort();
      } }));
      assert.equal(evidence.state, 'unknown');
      assert.equal(evidence.stopReason, undefined);
      assert.equal(evidence.messages.length, 1);
      assert.equal((await f.requests()).filter(request => request.method === 'session/prompt').length, 1);
      await assert.rejects(f.host.execute(f.input({ signal: new AbortController().signal })), { code: 'EEXIST' });
    } finally { await f.host.close(); }
  }
});

test('DSH requires a native cancellation response and never promotes failed output delivery to completion', async () => {
  const cancelled = await fixture();
  try {
    const result = await cancelled.host.execute(cancelled.input({ prompt: 'native-cancel' }));
    assert.equal(result.state, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
  } finally { await cancelled.host.close(); }
  const invalidStop = await fixture();
  try {
    const result = await invalidStop.host.execute(invalidStop.input({ prompt: 'invalid-stop' }));
    assert.equal(result.state, 'unknown', 'unvalidated wire responses cannot confirm native completion');
  } finally { await invalidStop.host.close(); }
  const failedDelivery = await fixture();
  try {
    const result = await failedDelivery.host.execute(failedDelivery.input({ onEvent: async () => { throw new Error('synthetic_delivery_failure'); } }));
    assert.equal(result.state, 'unknown');
    assert.equal(result.error, 'synthetic_delivery_failure');
  } finally { await failedDelivery.host.close(); }
});

test('DSH enforces the answer budget without claiming a complete partial result', async () => {
  const f = await fixture();
  try {
    const result = await f.host.execute(f.input({ prompt: 'over-budget' }));
    assert.equal(result.state, 'unknown');
    assert.equal(result.error, 'resource_exhausted:answer_bytes');
    assert.ok(result.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.text), 0) <= 8 * 1024 * 1024);
    assert.equal((await f.requests()).filter(request => request.method === 'session/prompt').length, 1);
  } finally { await f.host.close(); }
});
