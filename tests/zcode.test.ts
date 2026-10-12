import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAcpRuntime, createRuntimeStore } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { ZCodeExecutor, type ZCodeExecutionConfig } from '../packages/drivers/src/zcode.ts';
import type { AcpRuntimeEvent } from 'acpx/runtime';

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
  const events: AcpRuntimeEvent[] = [];
  let sessionId: string | undefined;
  const input = (prompt: string) => ({ runId: randomUUID(), prompt, resumeThreadId: sessionId,
    signal: AbortSignal.timeout(10000), onReady: async (id: string) => { sessionId = id; },
    onEvent: async (event: AcpRuntimeEvent) => { events.push(event); } });
  assert.equal((await executor.execute(input('marker'))).state, 'completed');
  assert.equal(events.flatMap(e => e.type === 'text_delta' && e.stream !== 'thought' ? [e.text] : []).join(''), 'marker');
  assert.ok(events.some(e => e.type === 'tool_call'));
  assert.ok(!events.some(e => e.type === 'message_completed'));
  assert.equal((await executor.execute({ ...input('permission'), permission: async () => 'allow' })).state, 'completed');
  assert.equal(await readFile(join(root, 'allowed.txt'), 'utf8'), 'synthetic');
  assert.equal((await readFile(audit, 'utf8')).split('\n').filter(x => x === 'session/new').length, 1);
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
test('ZCode mode rejection prevents dispatch; provider connection loss has an unknown result', async t => {
  const input = { runId: randomUUID(), prompt: 'must not run', signal: AbortSignal.timeout(10000), onReady: async () => {}, onEvent: async () => {} };
  const rejected = await setup(t, true);
  assert.equal((await rejected.executor.execute(input)).state, 'failed');
  assert.ok(!(await readFile(rejected.audit, 'utf8')).includes('session/prompt'));
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
