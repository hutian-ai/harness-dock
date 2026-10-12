import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { ZCodeExecutor, type ZCodeExecutionConfig } from '../packages/drivers/src/zcode.ts';
import { Engine } from '../apps/daemon/src/engine.ts';
import { DockClient } from '../packages/client/src/index.ts';
import { DaemonConnection } from '../apps/daemon/src/connection.ts';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let n = 0; n < 200; n++) { last = await read(); if (accept(last)) return last; await delay(25); }
  throw new Error(`ZCode test timed out: ${JSON.stringify(last)}`);
}
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
  const engine = new Engine(executor, { stateDir: config.stateDir });
  const token = 'synthetic-only-credential'.repeat(3);
  const client = new DockClient({ nodeId: engine.nodeId, token, port: 0 });
  await client.ready;
  let connection = new DaemonConnection(engine, client.endpoint, token);
  connection.connect(); await client.waitForConnection();
  t.after(async () => { connection.stop(); await engine.shutdown(); await client.close(); await rm(root, { recursive: true, force: true }); });
  return { client, root, audit, reconnect: async () => {
    connection.stop(); await delay(50);
    connection = new DaemonConnection(engine, client.endpoint, token);
    connection.connect(); await client.waitForConnection();
  } };
}
test('ZCode over real ACPX and SDK: session, permission ownership, reconnect, cancel and honest final semantics', async t => {
  const { client, reconnect, root, audit } = await setup(t);
  const input = { runId: randomUUID(), prompt: 'marker' };
  const first = await client.start(input);
  const done = await until(() => client.getRun(first.runId), run => run.state === 'completed');
  assert.equal(done.output, 'marker'); assert.equal(done.finalAnswer, null); assert.ok(done.tools.length);
  assert.equal((await client.start(input)).runId, first.runId);
  const second = await client.start({ runId: randomUUID(), sessionId: first.sessionId, prompt: 'permission' });
  const pending = await until(() => client.getRun(second.runId), run => run.permissions.length > 0);
  await reconnect();
  assert.equal((await client.getRun(second.runId)).permissions[0]!.permissionId, pending.permissions[0]!.permissionId);
  await assert.rejects(client.respondPermission({ runId: first.runId, permissionId: pending.permissions[0]!.permissionId, decision: 'allow' }));
  await client.respondPermission({ runId: second.runId, permissionId: pending.permissions[0]!.permissionId, decision: 'allow' });
  await until(() => client.getRun(second.runId), run => run.state === 'completed');
  assert.equal(await readFile(join(root, 'allowed.txt'), 'utf8'), 'synthetic');
  assert.equal((await readFile(audit, 'utf8')).split('\n').filter(x => x === 'session/new').length, 1);
  await rm(join(root, 'allowed.txt'));
  const denied = await client.start({ runId: randomUUID(), sessionId: first.sessionId, prompt: 'permission' });
  const deny = await until(() => client.getRun(denied.runId), run => run.permissions.length > 0);
  await client.respondPermission({ runId: denied.runId, permissionId: deny.permissions[0]!.permissionId, decision: 'deny' });
  await until(() => client.getRun(denied.runId), run => run.state === 'completed');
  await assert.rejects(stat(join(root, 'allowed.txt')), { code: 'ENOENT' });
  const cancelled = await client.start({ runId: randomUUID(), sessionId: first.sessionId, prompt: 'permission' });
  const late = await until(() => client.getRun(cancelled.runId), run => run.permissions.length > 0);
  await client.cancel(cancelled.runId);
  await until(() => client.getRun(cancelled.runId), run => ['cancelled', 'completed'].includes(run.state));
  await assert.rejects(client.respondPermission({ runId: cancelled.runId, permissionId: late.permissions[0]!.permissionId, decision: 'allow' }));
  await assert.rejects(stat(join(root, 'allowed.txt')), { code: 'ENOENT' });
  const waiting = await client.start({ runId: randomUUID(), prompt: 'wait' });
  await until(() => client.getRun(waiting.runId), run => run.tools.length > 0);
  await client.cancel(waiting.runId);
  assert.equal((await until(() => client.getRun(waiting.runId), run => run.state === 'cancelled')).finalAnswer, null);
});
test('ZCode mode rejection prevents prompt dispatch; dispatched connection loss stays unknown', async t => {
  const rejected = await setup(t, true);
  const failed = await rejected.client.start({ runId: randomUUID(), prompt: 'must not run' });
  await until(() => rejected.client.getRun(failed.runId), run => run.state === 'failed');
  assert.ok(!(await readFile(rejected.audit, 'utf8')).includes('session/prompt'));
  const crashed = await setup(t);
  const unknown = await crashed.client.start({ runId: randomUUID(), prompt: 'crash' });
  await until(() => crashed.client.getRun(unknown.runId), run => run.state === 'outcome_unknown');
  await assert.rejects(crashed.client.start({ runId: randomUUID(), prompt: 'must stay busy' }));
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
