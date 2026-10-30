import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import type { NativePermissionDecision } from '../packages/drivers/src/execution.ts';

test('dsh admission enforces device support, native permission choices and no replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-dsh-device-'));
  const executable = join(root, 'dsh');
  await writeFile(executable, '#!/bin/sh\necho "0.1.2-rc.1"\n', { mode: 0o700 });
  let starts = 0;
  let answer: NativePermissionDecision = 'allow';
  const decisions: NativePermissionDecision[] = [];
  const host = new DeviceHost({ mode: 'device', nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { disabled: true }, dsh: { executable, home: root } },
  }, createProviderAdapters(undefined, () => ({
    inspect: async () => ({ models: [{ id: '["synthetic","model"]', efforts: ['low'] }], currentModelId: '["synthetic","model"]', configOptions: [], sessionResume: true, mcpCapabilities: { http: true } }),
    close: async () => {},
    execute: async input => {
      starts++;
      await input.onReady('native-session');
      decisions.push(await input.permission!({ id: 'permission', title: 'Native tool', canAllow: true, details: { toolCallId: 'tool' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
      }, input.signal, Promise.resolve()));
      return { runId: input.runId, sessionId: 'native-session', state: input.runId === 'unknown' ? 'unknown' : 'completed', messages: [] };
    },
  })));
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  host.bind(async (_method, raw) => (raw as { kind: string }).kind === 'permission' ? answer : null);
  const inventory = await host.inventory() as { providers: { key: string; status: string; error?: string; capabilities?: { exactFinalAnswer: boolean; resultQuery: string } }[] };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    const dsh = inventory.providers.find(provider => provider.key === 'dsh');
    assert.equal(dsh?.status, 'not_found');
    assert.equal(dsh?.error, 'dsh_unsupported_platform');
    await host.prepare({ runId: 'unsupported-device' });
    await assert.rejects(host.execute({ provider: 'dsh', runId: 'unsupported-device', prompt: 'synthetic' }), /provider_unavailable/);
    assert.equal(starts, 0, 'unsupported devices must reject before creating a native execution');
    return;
  }
  assert.deepEqual(inventory.providers.find(provider => provider.key === 'dsh')?.capabilities?.exactFinalAnswer, false);
  assert.equal(inventory.providers.find(provider => provider.key === 'dsh')?.capabilities?.resultQuery, 'unsupported');
  const execute = async (runId: string) => {
    await host.prepare({ runId });
    return host.execute({ provider: 'dsh', runId, prompt: 'synthetic', model: '["synthetic","model"]' });
  };
  await execute('legacy');
  assert.equal(decisions.at(-1), 'deny', 'generic allow cannot select a native option');
  answer = { optionId: 'invented' };
  await execute('invalid');
  assert.equal(decisions.at(-1), 'deny');
  answer = { optionId: 'allow-once' };
  await execute('valid');
  assert.deepEqual(decisions.at(-1), answer);
  await execute('unknown');
  const before = starts;
  const replay = await host.execute({ provider: 'dsh', runId: 'unknown', prompt: 'synthetic', model: '["synthetic","model"]' }) as { result: { state: string } };
  assert.equal(replay.result.state, 'unknown');
  assert.equal(starts, before);
  assert.equal(await host.reconcile('unknown'), null);
  assert.equal(host.getExecution('unknown')?.state, 'unknown');
  assert.equal(starts, before, 'unsupported result queries never dispatch native work');
});
