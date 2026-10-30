import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';

test('native recovery uses persisted Codex context and never probes or dispatches', async () => {
  const context = { cwd: '/synthetic/work', codexHome: '/synthetic/native', codexBin: '/synthetic/codex', stateDir: '/synthetic/state', sandbox: 'workspace-write' as const };
  const result = { runId: 'original-run', fingerprint: 'synthetic', state: 'completed' as const, messages: [] };
  let queries = 0;
  const adapters = createProviderAdapters({
    inspect: async () => assert.fail('recovery must not inspect'),
    execute: async () => assert.fail('recovery must not dispatch'),
    reconcile: async (environment, runId, signal) => {
      queries++; assert.equal(environment, context); assert.equal(runId, result.runId); signal.throwIfAborted(); return result;
    },
    close: async () => {},
  });
  const signal = new AbortController().signal;
  assert.equal(await adapters.reconcile('unregistered-provider', context, result.runId, signal), null);
  assert.equal(await adapters.reconcile('codex', undefined, result.runId, signal), null);
  assert.equal(await adapters.reconcile('dsh', { stateDir: '/synthetic/state' }, result.runId, signal), null);
  assert.equal(queries, 0);
  assert.equal(await adapters.reconcile('codex', context, result.runId, signal), result);
  assert.equal(queries, 1);
  await adapters.close();
});
