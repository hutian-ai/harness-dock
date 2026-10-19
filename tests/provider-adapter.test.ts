import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexHost } from '../packages/drivers/src/codex-host.ts';
import { createProviderAdapter, type ProviderExecution } from '../packages/drivers/src/provider-adapter.ts';
import type { AcpInspection } from '../packages/drivers/src/acp-types.ts';

for (const key of ['lobi', 'deepseek-harness'] as const) {
  test(`${key} carries verified probe state into fresh session adapters without widening capabilities`, async () => {
    const signal = new AbortController().signal;
    const beforeSpawn = new Error('ready_before_native_spawn');
    const snapshot: AcpInspection = {
      version: 'synthetic', protocolVersion: 1, models: ['test-model'], modes: ['build'],
      loadSession: true, resumeSession: false, mcpTools: true,
      reasoningEffortsByModel: {}, permissionPresets: [],
    };
    const create = (inspection?: AcpInspection) => createProviderAdapter({
      key, displayName: key, status: 'installed', version: 'synthetic', source: 'configured',
      executable: '/missing-provider', home: process.cwd(), candidates: [],
    }, { cwd: process.cwd(), stateDir: process.cwd(), idleTimeoutMs: 1000,
      environment: {}, codex: new CodexHost(), inspection });
    const input: ProviderExecution = {
      runId: 'synthetic', sessionKey: 'synthetic', model: 'test-model', config: {}, prompt: 'never dispatched',
      resumeSessionId: 'native-session', retainSession: true, workdir: process.cwd(), skillDirectory: '',
      callerSkillsPresent: false, signal, cancellationRequested: () => false,
      tools: { name: 'synthetic', definitions: [{ name: 'marker', description: 'synthetic', inputSchema: { type: 'object' } }] },
      invocation: { signal, onToolCall: async () => assert.fail('no tool may execute') },
      ready: async () => { throw beforeSpawn; }, observe: async () => {},
      permission: async () => 'deny', steering: () => {},
    };
    // The real readiness callback is the dispatch fence, before a process or MCP
    // bridge starts. Reaching it proves all cached capability guards passed.
    const adapter = create(snapshot);
    adapter.validate(input);
    await assert.rejects(adapter.execute(input), error => error === beforeSpawn);
    await assert.rejects(create({ ...snapshot, mcpTools: false }).execute(input), /MCP tool transport has not been verified/);
    const noResume = create({ ...snapshot, loadSession: false });
    assert.throws(() => noResume.validate(input), /session_resume_unsupported/);
    await assert.rejects(noResume.execute(input), /session resume is unavailable/);
    await assert.rejects(create().execute(input), /MCP tool transport has not been verified/);
    if (key === 'lobi')
      await assert.rejects(adapter.execute({ ...input, config: { mode: 'plan' } }), /mode is unavailable/);
  });
}
