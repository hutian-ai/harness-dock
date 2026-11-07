import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { readDeviceOverview, reportedUsage } from '../apps/daemon/src/device-overview.ts';
import { DeviceStore, readStoredActivity } from '../apps/daemon/src/device-store.ts';
import { serveControl } from '../apps/daemon/src/local-control.ts';
import { panelStatus } from '../apps/daemon/src/panel-management.ts';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const tokens = { inputTokens: 42_800, cachedInputTokens: 26_000, outputTokens: 8_600, totalTokens: 51_400 };
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE device_executions (run_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}
function insert(db: DatabaseSync, runId: string, fields: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO device_executions VALUES (?,?)').run(runId, JSON.stringify({ runId, provider: 'codex', state: 'completed', createdAt: NOW - 1_000,
    input: 'private-input-fingerprint', environment: { token: 'private-authentication' }, result: { messages: ['private-output'] }, ...fields }));
}
async function directory() {
  await mkdir('.local', { recursive: true });
  return mkdtemp(resolve('.local/overview-test-'));
}

test('overview preserves concurrent identities, uncertain outcomes and truthful duration evidence', t => {
  const db = database(); t.after(() => db.close());
  insert(db, 'live-a', { state: 'running', createdAt: NOW - 10_000, model: 'model-a', lastObservedAt: NOW - 2_000 });
  insert(db, 'live-b', { state: 'running', createdAt: NOW - 5_000 });
  insert(db, 'old-unknown', { state: 'unknown', createdAt: NOW - 2 * DAY, lastObservedAt: NOW - DAY,
    admissionRecovery: { evidence: 'host_restarted' } });
  insert(db, 'ended', { finishedAt: NOW - 200 });
  insert(db, 'old-ended', { createdAt: NOW - 2 * DAY, finishedAt: NOW - DAY });
  insert(db, 'legacy-ended', { createdAt: undefined, settledAt: NOW });
  insert(db, 'legacy-unknown', { state: 'unknown', createdAt: undefined, settledAt: NOW });
  insert(db, 'retention-time-only', { settledAt: NOW });
  const live = readDeviceOverview(db, 'live', NOW, 2);
  assert.deepEqual(live.counts, { total: 6, running: 2, unknown: 2, ended: 2 });
  assert.equal(live.maxConcurrentExecutions, 2);
  assert.equal(live.executions.find(run => run.runId === 'live-a')?.elapsedMs, 10_000);
  assert.equal(live.executions.find(run => run.runId === 'live-b')?.elapsedMs, 5_000);
  assert.equal(live.executions.find(run => run.runId === 'old-unknown')?.elapsedMs, DAY);
  assert.equal(live.executions.find(run => run.runId === 'old-unknown')?.endedAt, undefined, 'admission recovery is not completion');
  assert.equal(live.executions.find(run => run.runId === 'ended')?.elapsedMs, 800);
  assert.equal(live.executions.find(run => run.runId === 'legacy-unknown')?.startedAt, undefined);
  assert.equal(live.executions.find(run => run.runId === 'retention-time-only')?.endedAt, undefined, 'retention migration time is not terminal evidence');
  assert.equal(live.executions.find(run => run.runId === 'retention-time-only')?.elapsedMs, undefined);
  const persisted = readDeviceOverview(db, 'persisted', NOW);
  assert.deepEqual(persisted.counts, { total: 6, running: 0, unknown: 4, ended: 2 });
  assert.equal(persisted.executions.find(run => run.runId === 'live-a')?.elapsedMs, 8_000);
  assert.equal(persisted.executions.find(run => run.runId === 'live-b')?.elapsedMs, undefined);
  assert.doesNotMatch(JSON.stringify(live), /private-|environment|messages|admissionRecovery/);
});

test('usage aggregates per execution and provider, with cache included once and missing reporting distinct from zero', t => {
  const db = database(); t.after(() => db.close());
  insert(db, 'codex-one', { result: { usage: tokens, total: { ...tokens, totalTokens: 9_000_000 } } });
  insert(db, 'codex-two', { usage: tokens });
  insert(db, 'cumulative-only', { result: { total: tokens } });
  insert(db, 'dsh-no-report', { provider: 'dsh' });
  insert(db, 'old-unknown', { state: 'unknown', createdAt: NOW - DAY - 1, usage: tokens });
  insert(db, 'bad-report', { usage: { ...tokens, inputTokens: -1 } });
  const overview = readDeviceOverview(db, 'live', NOW);
  assert.deepEqual(overview.usage.find(row => row.provider === 'codex'), { provider: 'codex', executions: 4, reportedExecutions: 2,
    inputTokens: 85_600, outputTokens: 17_200, cachedInputTokens: 52_000, totalTokens: 102_800 });
  assert.deepEqual(overview.usage.find(row => row.provider === 'dsh'), { provider: 'dsh', executions: 1, reportedExecutions: 0 });
  insert(db, 'real-zero', { provider: 'dsh', usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } });
  assert.equal(readDeviceOverview(db, 'live', NOW).usage.find(row => row.provider === 'dsh')?.totalTokens, 0);
  assert.equal(reportedUsage({ ...tokens, cachedInputTokens: tokens.inputTokens + 1 }), undefined);
  assert.equal(reportedUsage({ ...tokens, totalTokens: tokens.totalTokens + tokens.cachedInputTokens }), undefined);
  assert.equal(reportedUsage({ ...tokens, inputTokens: 1.5 }), undefined);
});

test('row bounding does not truncate counts or usage and retains nonterminal records first', t => {
  const db = database(); t.after(() => db.close());
  for (let i = 0; i < 61; i++) insert(db, `finished-${i}`, { createdAt: NOW - i, usage: tokens });
  insert(db, 'older-running', { createdAt: NOW - 2 * DAY, state: 'running' });
  const overview = readDeviceOverview(db, 'live', NOW);
  assert.equal(overview.executions.length, 50);
  assert.equal(overview.truncated, true);
  assert.equal(overview.counts.total, 62);
  assert.equal(overview.executions[0]?.runId, 'older-running');
  assert.equal(overview.usage[0]?.reportedExecutions, 61);
  assert.equal(overview.usage[0]?.totalTokens, tokens.totalTokens * 61);
  assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 256 * 1024);
});

test('unsafe aggregate and wall-clock regression are unavailable instead of invented numbers', t => {
  const db = database(); t.after(() => db.close());
  const huge = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cachedInputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER };
  insert(db, 'one', { usage: huge }); insert(db, 'two', { usage: huge });
  insert(db, 'future', { state: 'running', createdAt: NOW + 1_000 });
  insert(db, 'clock-went-back', { createdAt: NOW - 1_000, finishedAt: NOW - 2_000 });
  const overview = readDeviceOverview(db, 'live', NOW);
  assert.equal(overview.usage[0]?.reportedExecutions, 2);
  assert.equal(overview.usage[0]?.totalTokens, undefined);
  assert.equal(overview.executions.find(run => run.runId === 'future')?.elapsedMs, undefined);
  assert.equal(overview.executions.find(run => run.runId === 'clock-went-back')?.elapsedMs, undefined);
});

test('owner persists only actual observation times and normalized usage; read-only fallback cannot claim running', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const nodeId = randomUUID(), stateDir = join(root, 'state');
  const store = new DeviceStore(nodeId, stateDir);
  store.admit({ runId: 'complete', provider: 'codex', model: 'selected-model', input: 'hash', state: 'running' });
  store.save({ runId: 'complete', provider: 'codex', input: 'hash', state: 'completed', result: { state: 'completed', usage: tokens } });
  store.admit({ runId: 'interrupted', provider: 'dsh', input: 'hash', state: 'running' });
  store.observe('interrupted', 'event', { type: 'private-observation' });
  const saved = store.get('complete')!, live = store.overview();
  assert.deepEqual(saved.usage, tokens);
  assert.equal(saved.model, 'selected-model');
  assert.ok(saved.finishedAt! >= saved.createdAt!);
  assert.equal(live.counts.running, 1);
  await assert.rejects(readStoredActivity(nodeId, stateDir, true), /locked/u, 'an active owner must not be bypassed for a historical snapshot');
  const lastObserved = store.get('interrupted')?.lastObservedAt;
  store.close();
  const persisted = await readStoredActivity(nodeId, stateDir, true);
  assert.equal(persisted?.overview?.source, 'persisted');
  assert.equal(persisted?.unresolved, 1);
  assert.equal(persisted?.overview?.counts.running, 0);
  assert.equal(persisted?.overview?.counts.unknown, 1);
  const reopened = new DeviceStore(nodeId, stateDir);
  try {
    assert.equal(reopened.get('interrupted')?.lastObservedAt, lastObserved);
    assert.equal(reopened.overview().executions.find(row => row.runId === 'interrupted')?.state, 'unknown');
  } finally { reopened.close(); }
});

test('panel preserves live execution evidence when the remote connection is lost', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await initializeDevice({ home: join(root, 'device'), cwd: root, endpoint: 'ws://127.0.0.1:1/' });
  const config = { ...await readConfig(paths.configPath), providers: { codex: { disabled: true }, dsh: { disabled: true } } };
  await writeFile(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  const store = new DeviceStore(config.nodeId, config.stateDir);
  for (let i = 0; i < 50; i++) {
    const record = { runId: `completed-${i}-${'x'.repeat(200)}`, model: 'selected-model-'.repeat(20), provider: 'codex', input: 'hash', state: 'running' as const };
    store.admit(record);
    store.save({ ...record, state: 'completed' });
  }
  store.admit({ runId: 'live-execution', provider: 'codex', input: 'hash', state: 'running' });
  assert.ok(Buffer.byteLength(JSON.stringify(store.overview())) > 16_384, 'dashboard response exceeds the legacy control ceiling');
  let modernOwner = true;
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId: 'synthetic-owner', pid: process.pid,
    endpoint: config.endpoint, connected: false, activeRunIds: ['live-execution'], unresolvedRunIds: [],
    ...(modernOwner ? { overview: store.overview() } : {}) }), async () => {});
  try {
    const state = await panelStatus(paths.configPath, root, undefined, false);
    assert.equal(state.connected, false);
    assert.equal(state.running, true);
    assert.equal(state.overview?.source, 'live');
    assert.equal(state.overview?.executions[0]?.state, 'running');
    assert.equal(state.overview?.counts.running, 1);
    modernOwner = false;
    const legacy = await panelStatus(paths.configPath, root, undefined, false);
    assert.equal(legacy.overview, undefined, 'an older owner does not supply a zero-run or fabricated snapshot');
    assert.equal(legacy.activityKnown, true);
    assert.equal(legacy.activitySource, 'live');
    assert.equal(legacy.active, 1, 'existing live maintenance evidence remains usable');
  } finally { await close(); store.close(); }
});
