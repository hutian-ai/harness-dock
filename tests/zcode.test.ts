import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { ZCodeExecutor, type ZCodeExecutionConfig } from '../packages/drivers/src/zcode.ts';
import type { CodexEvent } from '../packages/drivers/src/codex-events.ts';

async function setup(t: { after(fn: () => Promise<void>): void }, rejectMode = false) {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/zcode-test-'));
  const config: ZCodeExecutionConfig = { cwd: root, stateDir: join(root, 'state'), zcodeHome: root, zcodeBin: process.execPath };
  const audit = join(root, 'audit');
  const executor = new ZCodeExecutor(config, async () => createAcpRuntime({
    cwd: root, sessionStore: createRuntimeStore({ stateDir: config.stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { zcode: [process.execPath, resolve('tests/fixtures/zcode-acp.mjs')] } }),
    agentProcessEnv: { DOCK_AUDIT: audit, ...(rejectMode ? { DOCK_REJECT_MODE: '1' } : {}) },
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false,
  }));
  t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }); });
  return { executor, root, audit };
}
test('ZCode ACPX preserves its session, gates permissions and cancellation, and does not invent final messages', async t => {
  const { executor, root, audit } = await setup(t);
  const events: CodexEvent[] = [];
  let sessionId: string | undefined;
  const input = (prompt: string) => ({ runId: randomUUID(), prompt, resumeThreadId: sessionId,
    signal: AbortSignal.timeout(10000), onReady: async (id: string) => { sessionId = id; },
    onEvent: async (event: CodexEvent) => { events.push(event); } });
  const inspection = await executor.inspect(AbortSignal.timeout(10000));
  assert.deepEqual(inspection.permissionModes.map(mode => mode.value), ['build','native-mode']);
  assert.equal(inspection.callerSkills, false);
  assert.deepEqual(inspection.permissionInteractions, ['options', 'form', 'url']);
  assert.equal((await executor.execute({...input('marker'), mode:'native-mode'})).state, 'completed');
  assert.ok((await readFile(audit,'utf8')).includes('mode:native-mode'));
  assert.equal(events.flatMap(e => e.type === 'text_delta' && e.stream !== 'thought' ? [e.text] : []).join(''), 'marker');
  assert.ok(events.some(e => e.type === 'tool_call'));
  assert.ok(!events.some(e => e.type === 'message_completed'));
  assert.equal((await executor.execute({ ...input('permission'), permission: async () => 'allow' })).state, 'completed');
  assert.equal(await readFile(join(root, 'allowed.txt'), 'utf8'), 'synthetic');
  assert.equal((await readFile(audit, 'utf8')).split('\n').filter(x => x === 'session/new').length, 2);
  assert.ok((await readFile(audit,'utf8')).includes('mode:build'));
  await rm(join(root, 'allowed.txt'));
  assert.equal((await executor.execute({ ...input('permission'), permission: async () => 'deny' })).state, 'completed');
  await assert.rejects(stat(join(root, 'allowed.txt')), { code: 'ENOENT' });
  const abort = new AbortController();
  const cancelled = await executor.execute({ ...input('permission'), signal: abort.signal,
    permission: async () => { abort.abort(); return 'allow'; } });
  assert.ok(['cancelled', 'unknown'].includes(cancelled.state));
  await assert.rejects(stat(join(root, 'allowed.txt')), { code: 'ENOENT' });
  sessionId = undefined;
  const waiting = new AbortController();
  const result = await executor.execute({ ...input('wait'), signal: waiting.signal,
    onEvent: async event => { if (event.type === 'tool_call') waiting.abort(); } });
  assert.equal(result.state, 'cancelled');
});

test('ZCode rejects nonempty caller skills before starting a Provider', async () => {
  const executor = new ZCodeExecutor({ cwd: '/tmp', stateDir: '/tmp/state', zcodeHome: '/tmp', zcodeBin: process.execPath },
    async () => assert.fail('unsupported caller skills must not start a runtime'));
  assert.deepEqual(await executor.execute({ runId: randomUUID(), prompt: 'must not run', signal: new AbortController().signal,
    skillDirectory: '/tmp/caller-skills', callerSkillsPresent: true, onReady: async () => assert.fail('must not admit'), onEvent: async () => {} }),
    { state: 'failed', error: 'zcode_caller_skills_unsupported' });
});

for (const scenario of ['exact_reject', 'ambiguous_allow', 'form', 'url'] as const) {
  test(`ZCode forwards precise native interactions and delivery: ${scenario}`, async t => {
    await mkdir('.local', { recursive: true });
    const root = await mkdtemp(resolve('.local/zcode-interaction-test-'));
    const audit = join(root, 'audit.json');
    const peer = join(root, 'peer.mjs');
    const offered = [
      { optionId: 'allow-a', name: 'Allow action A', kind: 'allow_once' },
      { optionId: 'allow-b', name: 'Allow action B', kind: 'allow_once' },
      { optionId: 'reject-native', name: 'Reject this action', kind: 'reject_once' },
    ];
    await writeFile(peer, `import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const config={id:'mode',category:'mode',name:'Mode',type:'select',currentValue:'build',options:[{value:'build',name:'Build'}]};
let turn;
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params,result}=JSON.parse(line);
 if(id==='native-interaction'&&!method){writeFileSync(${JSON.stringify(audit)},JSON.stringify(result));send({id:turn,result:{stopReason:'end_turn'}});return;}
 if(method==='initialize') send({id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(method==='session/new') send({id,result:{sessionId:'native-session',configOptions:[config]}});
 if(method==='session/set_mode'){send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'config_option_update',configOptions:[config]}}});send({id,result:{}});}
 if(method==='session/prompt'){
  turn=id;
  const base={sessionId:'native-session',message:'Native question'};
  send({id:'native-interaction',method:${JSON.stringify(scenario === 'form' || scenario === 'url' ? 'elicitation/create' : 'session/request_permission')},params:${scenario === 'form'
    ? "{...base,mode:'form',requestedSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}}"
    : scenario === 'url' ? "{...base,mode:'url',url:'https://example.test/auth',elicitationId:'native-auth'}"
      : `{sessionId:'native-session',toolCall:{toolCallId:'tool',title:'Native permission',kind:'edit'},options:${JSON.stringify(offered)}}`}});
 }
}).on('close',()=>process.exit(0));
`);
    const config: ZCodeExecutionConfig = { cwd: root, stateDir: join(root, 'state'), zcodeHome: root, zcodeBin: process.execPath };
    const executor = new ZCodeExecutor(config, async () => createAcpRuntime({ cwd: root, sessionStore: createRuntimeStore({ stateDir: config.stateDir }),
      agentRegistry: createAgentRegistry({ overrides: { zcode: [process.execPath, peer] } }), permissionMode: 'deny-all', nonInteractivePermissions: 'deny',
      fs: false, terminal: false, elicitationModes: ['form', 'url'] }));
    t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }); });
    const delivery: Promise<boolean>[] = [];
    const result = await executor.execute({ runId: randomUUID(), prompt: 'question', signal: AbortSignal.timeout(10000),
      onReady: async () => {}, onEvent: async () => {}, permission: async (request, _signal, responseSent) => {
        delivery.push(responseSent.then(() => true, () => false));
        if (scenario === 'form') {
          assert.deepEqual(request.form, { mode: 'form', message: 'Native question', requestedSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } });
          return { action: 'accept', content: { answer: 'native answer' } };
        }
        if (scenario === 'url') {
          assert.deepEqual(request.form, { mode: 'url', message: 'Native question', url: 'https://example.test/auth', elicitationId: 'native-auth' });
          return { action: 'decline' };
        }
        assert.equal(request.canAllow, false);
        assert.deepEqual(request.options, offered);
        return scenario === 'exact_reject' ? { optionId: 'reject-native' } : 'allow';
      } });
    assert.equal(result.state, 'completed');
    assert.deepEqual(await Promise.all(delivery), [true]);
    assert.deepEqual(JSON.parse(await readFile(audit, 'utf8')), scenario === 'exact_reject'
      ? { outcome: { outcome: 'selected', optionId: 'reject-native' } } : scenario === 'ambiguous_allow'
        ? { outcome: { outcome: 'cancelled' } } : scenario === 'form'
          ? { action: 'accept', content: { answer: 'native answer' } } : { action: 'decline' });
  });
}
test('ZCode mode rejection prevents dispatch; provider connection loss has an unknown result', async t => {
  const input = { runId: randomUUID(), prompt: 'must not run', signal: AbortSignal.timeout(10000), onReady: async () => {}, onEvent: async () => {} };
  const rejected = await setup(t, true);
  assert.equal((await rejected.executor.execute(input)).state, 'failed');
  assert.ok(!(await readFile(rejected.audit, 'utf8')).includes('session/prompt'));
  const missing = await setup(t);
  assert.equal((await missing.executor.execute({...input,mode:'not-advertised'})).state,'failed');
  assert.ok(!(await readFile(missing.audit,'utf8')).includes('session/prompt'));
  const crashed = await setup(t);
  assert.equal((await crashed.executor.execute({ ...input, prompt: 'crash' })).state, 'unknown');
});

test('pinned real ZCode ACP bridge initializes without its unused TUI; probe is not model readiness', async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/zcode-bridge-test-'));
  // No ZCode binary or credentials: this deliberately verifies only the real bridge handshake.
  const driver = new ZCodeExecutor({ cwd: root, stateDir: join(root, 'state'), zcodeHome: root, zcodeBin: process.execPath });
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  const result = await driver.inspect(AbortSignal.timeout(20_000));
  assert.equal(result.readiness, 'acp_session_created');
  assert.equal(result.modelExecutionVerified, false);
  assert.equal(result.configuredPermissionMode, 'build');
  const preferences = JSON.parse(await readFile(join(root, 'state/zcode-bridge-config/zcode-acp/config.json'), 'utf8'));
  assert.equal(preferences.remote.enabled, false);
  assert.equal(preferences.quota.autoResume, false);
});
