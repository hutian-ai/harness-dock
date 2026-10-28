import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { DeviceStore } from '../apps/daemon/src/device-store.ts';
import type { DeviceConfig } from '../apps/daemon/src/config.ts';
import type { ProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';

test('device crash preserves admission, excludes a second owner and never redispatches an unknown run', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-crash-'));
  const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 1.0.0');\n`, { mode: 0o700 });
  const config: DeviceConfig = { mode: 'device', nodeId: randomUUID(), token: 'synthetic'.repeat(5),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { executable, home: root } } };
  const input = { provider: 'codex', runId: randomUUID(), model: 'synthetic', prompt: 'synthetic' };
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {DeviceHost} from './apps/daemon/src/device-host.ts';
    import {createProviderAdapters} from './packages/drivers/src/provider-adapter.ts';
    const host = new DeviceHost(${JSON.stringify(config)}, createProviderAdapters({
      inspect: async()=>({models:[{id:'synthetic',efforts:[],serviceTiers:[]}],config:{sandbox:'workspace-write',approvalPolicy:'on-request',nativeMemoryDisabled:true}}),
      execute: async()=>{ console.log('admitted'); return new Promise(()=>{}); }, close:async()=>{}, reconcile:async()=>null,
    }));
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
  const host = new DeviceHost(config, createProviderAdapters({ inspect: async()=>{ throw new Error('unused'); },
    execute: async()=>{ assert.fail('unknown execution must not dispatch'); }, reconcile: async()=>null, close: async()=>{} }));
  try {
    assert.equal(host.getExecution(input.runId)?.state, 'unknown');
    assert.deepEqual(await host.execute(input), { provider: 'codex', result: { state: 'unknown', error: 'unconfirmed_previous_execution' } });
    await assert.rejects(host.execute({ ...input, prompt: 'changed' }), /identity_conflict/);
    await assert.rejects(host.execute({ ...input, runId: randomUUID() }), /unresolved_execution/);
  } finally { await host.close(); }
  assert.throws(() => new DeviceStore(randomUUID(), config.stateDir), /state_node_mismatch/);
});

test('device recovery delegates an opaque context for Codex without discovery or replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-provider-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: DeviceConfig = { mode: 'device', nodeId: randomUUID(), token: 'synthetic'.repeat(5),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state') };
  const context = { nativeReference: 'original-turn', providerRevision: 'synthetic' };
  const store = new DeviceStore(config.nodeId, config.stateDir);
  store.admit({ runId: 'original-run', provider: 'codex', input: 'original-identity', state: 'running', environment: context });
  store.close();
  let queries = 0, confirmed = false;
  const adapters: ProviderAdapters = {
    create: () => assert.fail('recovery must not discover, inspect or create an execution adapter'),
    reconcile: async (provider, saved, runId, signal) => {
      queries++; assert.equal(provider, 'codex'); assert.deepEqual(saved, context); assert.equal(runId, 'original-run');
      signal.throwIfAborted();
      return confirmed ? { state: 'completed' } : null;
    },
    close: async () => {},
  };
  const host = new DeviceHost(config, adapters);
  try {
    assert.equal(host.getExecution('original-run')?.state, 'unknown');
    assert.equal(await host.reconcile('original-run'), null);
    assert.equal(host.getExecution('original-run')?.state, 'unknown');
    confirmed = true;
    assert.deepEqual(await host.reconcile('original-run'), { provider: 'codex', result: { state: 'completed' } });
    assert.equal(host.getExecution('original-run')?.state, 'completed');
    assert.deepEqual(await host.reconcile('original-run'), { provider: 'codex', result: { state: 'completed' } });
    assert.equal(queries, 2, 'terminal reads must not query the native provider again');
  } finally { await host.close(); }
  const saved = new DeviceStore(config.nodeId, config.stateDir);
  try {
    assert.equal(saved.get('original-run')?.state, 'completed');
    assert.deepEqual(saved.get('original-run')?.environment, context);
    assert.equal(saved.get('original-run')?.input, 'original-identity');
  } finally { saved.close(); }
});
