import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { DeviceStore } from '../apps/daemon/src/device-store.ts';
import type { DeviceConfig } from '../apps/daemon/src/config.ts';

test('device crash preserves admission, excludes a second owner and never redispatches an unknown run', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-crash-'));
  const config: DeviceConfig = { mode: 'device', nodeId: randomUUID(), token: 'synthetic'.repeat(5),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { home: root }, lobi: { disabled: true }, zcode: { disabled: true }, 'deepseek-harness': { disabled: true } } };
  const input = { provider: 'codex', runId: randomUUID(), model: 'synthetic', prompt: 'synthetic' };
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {DeviceHost} from './apps/daemon/src/device-host.ts';
    const host = new DeviceHost(${JSON.stringify(config)}, {
      inspect: async()=>({models:[{id:'synthetic',efforts:[],serviceTiers:[]}],config:{sandbox:'workspace-write',approvalPolicy:'on-request',nativeMemoryDisabled:true}}),
      execute: async()=>{ console.log('admitted'); return new Promise(()=>{}); }, close:async()=>{}, reconcile:async()=>null,
    });
    host.bind(async()=>null);
    await host.inventory(); await host.prepare({runId:${JSON.stringify(input.runId)}});
    void host.execute(${JSON.stringify(input)}); setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); });
  let errors = ''; child.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-4000); });
  const [output] = await Promise.race([once(child.stdout!, 'data', { signal: AbortSignal.timeout(10000) }), once(child, 'exit').then(() => { throw new Error(`Crash fixture exited before admission: ${errors}`); })]);
  assert.match(String(output), /admitted/);
  assert.throws(() => new DeviceStore(config.nodeId, config.stateDir), /locked/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const host = new DeviceHost(config, { inspect: async()=>{ throw new Error('unused'); },
    execute: async()=>{ assert.fail('unknown execution must not dispatch'); }, reconcile: async()=>null, close: async()=>{} });
  try {
    assert.equal(host.getExecution(input.runId)?.state, 'unknown');
    assert.deepEqual(await host.execute(input), { provider: 'codex', result: { state: 'unknown', error: 'unconfirmed_previous_execution' } });
    await assert.rejects(host.execute({ ...input, prompt: 'changed' }), /identity_conflict/);
    await assert.rejects(host.execute({ ...input, runId: randomUUID() }), /unresolved_execution/);
  } finally { await host.close(); }
  assert.throws(() => new DeviceStore(randomUUID(), config.stateDir), /state_node_mismatch/);
});
