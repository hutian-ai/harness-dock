import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { providerDetails } from '../apps/daemon/src/provider-details.ts';
import { control, serveControl } from '../apps/daemon/src/local-control.ts';
import { runPanelOperation } from '../apps/daemon/src/panel-management.ts';

test('native model defaults are explicit, model-specific and bounded without leaking native options', () => {
  const details = providerDetails({ status: 'ready', checkedAt: 123, inspection: {
    models: [{ id: 'model-a', efforts: ['low', 'high'] }, { id: 'model-b', efforts: [] }],
    configOptions: [
      { id: 'model', type: 'select', currentValue: 'model-b' },
      { id: 'reasoning_effort', type: 'select', currentValue: 'low' },
      { id: 'mode', type: 'select', category: 'mode', currentValue: 'native-mode', options: [{ value: 'native-mode', name: 'Native mode' }] },
      { id: 'private-token', currentValue: 'do-not-expose' },
    ], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', token: 'do-not-expose' },
  } })!;
  assert.equal(details.defaults.model, 'model-b');
  assert.equal(details.defaults.effort, 'low');
  assert.equal(details.defaults.mode, 'native-mode');
  assert.deepEqual(details.models[1], { id: 'model-b', efforts: [] }, 'efforts from model-a must not be assigned to model-b');
  assert.doesNotMatch(JSON.stringify(details), /private-token|do-not-expose|configOptions/);
  const absent = providerDetails({ status: 'ready', checkedAt: 123, inspection: { models: [{ id: 'only-model' }], currentModelId: 'not-in-list' } })!;
  assert.deepEqual(absent.defaults, { model: null, effort: null, mode: null, sandbox: null, approvalPolicy: null });
  assert.equal(providerDetails({ status: 'installed' }), undefined, 'installation alone supplies no model evidence');
  const bounded = providerDetails({ status: 'ready', checkedAt: 123, inspection: { models: Array.from({ length: 150 }, (_, i) => ({ id: `model-${i}`, efforts: ['low', 'low', '\u0000invalid'] })) } })!;
  assert.equal(bounded.models.length, 128); assert.equal(bounded.modelsTruncated, true);
  assert.deepEqual(bounded.models[0]?.efforts, ['low']);
});

test('DSH route labels stay separate from opaque identity and absent permission modes stay unknown', () => {
  const primary = JSON.stringify(['provider-a', 'model']), alternate = JSON.stringify(['provider-b', 'model']);
  const details = providerDetails({ status: 'ready', checkedAt: 123, inspection: {
    models: [{ id: primary, efforts: ['low', 'high', 'max'] }, { id: alternate, efforts: [] }],
    currentModelId: primary,
    configOptions: [
      { id: 'model', type: 'select', currentValue: primary, options: [
        { group: 'provider-a', name: 'Provider A', options: [{ value: primary, name: 'Model' }] },
        { group: 'provider-b', name: 'Provider B', options: [{ value: alternate, name: 'Model', description: 'do-not-expose' }] },
      ] },
      { id: 'reasoning_effort', type: 'select', currentValue: 'low' },
    ],
    // ACPX's client fallback policy is not a native Harness permission mode.
    permissionMode: 'deny-all',
  } })!;
  assert.deepEqual(details.models, [
    { id: primary, name: 'Model', provider: 'Provider A', efforts: ['low', 'high', 'max'] },
    { id: alternate, name: 'Model', provider: 'Provider B', efforts: [] },
  ]);
  assert.equal(details.defaults.model, primary, 'labels never replace execution identity');
  assert.equal(details.defaults.effort, 'low');
  assert.equal(details.defaults.mode, null);
  assert.deepEqual(details.permissionModes, []);
  assert.doesNotMatch(JSON.stringify(details), /deny-all|do-not-expose/);

  const invalid = providerDetails({ status: 'ready', checkedAt: 123, inspection: {
    models: [{ id: primary }],
    configOptions: [{ id: 'model', type: 'select', options: [
      { group: 'provider-a', name: 'x'.repeat(501), options: [{ value: primary, name: '\u0000invalid' }] },
    ] }],
  } })!;
  assert.deepEqual(invalid.models, [{ id: primary, provider: 'provider-a', efforts: [] }]);
});

test('capability reads use the authenticated owner; old owners fail explicitly without starting a replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-native-details-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root });
  const config = await readConfig(paths.configPath);
  if (config.mode !== 'device') throw new Error('device expected');
  const daemonId = randomUUID(); let probes = 0, busy = false, supported = true;
  const snapshot = providerDetails({ status: 'ready', checkedAt: 123, inspection: { models: [{ id: 'native-model', efforts: ['high'] }] } })!;
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId, pid: process.pid, connected: false, endpoint: config.endpoint,
    providerDetailsSupported: supported, providerDetails: probes ? { codex: snapshot } : undefined }), async () => {}, undefined, undefined, undefined, undefined,
  async () => { if (busy) throw new Error('device_busy'); await new Promise(resolve => setTimeout(resolve, 5_200)); probes++; });
  t.after(close);
  await assert.rejects(control({ ...config, token: 'wrong-token'.repeat(4) }, 'provider-details'), /403/);
  assert.equal(probes, 0);
  const result = await runPanelOperation({ operation: 'provider-details', config: paths.configPath }, '', root) as { providerDetails?: { codex?: unknown } };
  assert.deepEqual(result.providerDetails?.codex, snapshot); assert.equal(probes, 1);
  busy = true;
  await assert.rejects(control(config, 'provider-details'), /409:device_busy/);
  assert.equal(probes, 1);
  busy = false; supported = false;
  await assert.rejects(runPanelOperation({ operation: 'provider-details', config: paths.configPath }, '', root), /provider_details_unsupported/);
  assert.equal(probes, 1);
});
