import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Engine } from '../apps/daemon/src/engine.ts';
import { RunStore } from '../apps/daemon/src/store.ts';


test('durable admission, crash recovery, exclusive ownership and no duplicate dispatch', async (t) => {
  await mkdir('.local', { recursive: true });
  const stateDir = await mkdtemp(resolve('.local/persistence-'));
  const nodeId = randomUUID(), runId = randomUUID();
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {Engine} from './apps/daemon/src/engine.ts';
    const engine = new Engine({inspect: async()=>({}), execute: async(input)=>{
      void input.permission({id:'synthetic',title:'must expire',canAllow:true,details:{}},input.signal,Promise.resolve());
      return new Promise(()=>{});
    },close:async()=>{}}, ${JSON.stringify({ nodeId, stateDir })});
    engine.start(${JSON.stringify({ runId, prompt: 'synthetic' })});
    console.log('admitted'); setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child.stdout!, 'data');
  assert.throws(() => new RunStore(nodeId, stateDir), /locked/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let starts = 0;
  const driver: ConstructorParameters<typeof Engine>[0] = {
    inspect: async () => ({ models: [], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } }), execute: async input => {
      starts++;
      await input.onReady('synthetic-' + starts);
      return { runId: input.runId, fingerprint: 'synthetic', messages: [], state: 'completed' };
    }, close: async () => { }
  };
  const engine = new Engine(driver, { nodeId, stateDir });
  const unknown = engine.getRun(runId);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.deepEqual(unknown.permissions, []);
  assert.equal(engine.start({ runId, prompt: 'synthetic' }).state, 'outcome_unknown');
  assert.equal(starts, 0);
  assert.throws(() => engine.start({ runId, prompt: 'changed' }), /identity_conflict/);
  assert.throws(() => engine.start({ runId: randomUUID(), prompt: 'resume', sessionId: unknown.sessionId }), /exact current sessionId/);
  const fresh = engine.start({ runId: randomUUID(), prompt: 'new' });
  await new Promise((resolve) => setImmediate(resolve));
  const another = engine.start({ runId: randomUUID(), prompt: 'another new' });
  assert.notEqual(fresh.sessionId, another.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => engine.start({ runId: randomUUID(), prompt: 'old session', sessionId: fresh.sessionId }), /exact current sessionId/);
  assert.equal(engine.listRuns().length, 3);
  assert.equal(engine.listRuns(1, 1)[0]?.runId, fresh.runId);
  await engine.shutdown();
  const restored = new Engine(driver, { nodeId, stateDir });
  assert.equal(restored.getRun(fresh.runId).state, 'completed');
  assert.equal(restored.getRun(another.runId).state, 'completed');
  assert.equal(starts, 2);
  await restored.shutdown();
  assert.throws(() => new RunStore(randomUUID(), stateDir), /state_node_mismatch/);
});
