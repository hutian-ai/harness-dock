import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { digest, managedStateBytes, forgetSessionDirectories, prepareDirectories } from '../apps/daemon/src/device-files.ts';
import { RotatingLog } from '../apps/daemon/src/rotating-log.ts';
import { DeviceStore } from '../apps/daemon/src/device-store.ts';
import { ObservationWriter } from '../apps/daemon/src/observation-writer.ts';
import type { CodexHostInput, CodexEvidence } from '../packages/drivers/src/index.ts';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const textDelta = (text: string, phase = 'final_answer') => ({ type: 'text_delta', messageId: 'message', stream: 'output', phase, text });

test('an approval holds only its own session; parallel cancellation, output and replay stay scoped', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-concurrent-'));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.1.0"\n', { mode: 0o700 });
  const waiting = deferred(), approve = deferred(), cancelStarted = deferred();
  const inputs = new Map<string, CodexHostInput<unknown>>();
  const decisions: string[] = [];
  let starts = 0;
  const host = new DeviceHost({ mode: 'device', nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'), resources: { maxStateBytes: 2 * 1024 * 1024 },
    providers: { codex: { executable, home: root }, dsh: { disabled: true } },
  }, createProviderAdapters(() => ({
    inspect: async () => ({ models: [{ id: 'synthetic', efforts: [], serviceTiers: [] }], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: false } }),
    reconcile: async () => null, close: async () => {},
    execute: async input => {
      starts++; inputs.set(input.runId, input);
      await input.onReady(`thread:${input.runId}`);
      if (input.runId === 'approval') {
        const answer = await input.permission!({ id: 'same-request-id', title: 'Approve', details: {}, canAllow: true }, input.signal, Promise.resolve());
        decisions.push(String(answer));
      } else if (input.runId === 'cancel') {
        cancelStarted.resolve();
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { runId: input.runId, fingerprint: 'synthetic', state: input.signal.aborted ? 'cancelled' : 'completed',
        threadId: `thread:${input.runId}`, turnId: input.runId,
        messages: [{ id: input.runId, phase: 'final_answer', text: input.runId }] } as CodexEvidence;
    },
  })));
  t.after(async () => { approve.resolve(); host.cancel('cancel'); await host.close(); await rm(root, { recursive: true, force: true }); });
  host.bind(async (_method, raw) => {
    const value = raw as { runId: string; kind: string };
    if (value.kind === 'permission') {
      assert.equal(value.runId, 'approval'); waiting.resolve(); await approve.promise; return 'allow';
    }
    return null;
  });
  await host.inventory();
  await assert.rejects(host.execute({ provider: 'other', runId: 'unsupported', prompt: 'synthetic' }), /unsupported_provider/);
  assert.equal(starts, 0, 'unsupported Providers must be rejected before dispatch');
  const request = (runId: string, sessionKey = runId) => ({ provider: 'codex', runId, sessionKey, prompt: runId, model: 'synthetic' });
  await host.prepare({ runId: 'capacity' });
  const growth = join(root, 'state', 'provider-growth');
  await writeFile(growth, Buffer.alloc(2 * 1024 * 1024));
  await assert.rejects(host.execute(request('capacity')), /resource_exhausted:managed_state_bytes/);
  await assert.rejects(host.prepare({ runId: 'over-capacity' }), /resource_exhausted:managed_state_bytes/);
  assert.equal(starts, 0); assert.equal(host.getExecution('capacity'), null);
  await rm(growth); await host.release('capacity');
  await host.prepare({ runId: 'approval' });
  const first = host.execute(request('approval'));
  await waiting.promise;
  const replay = host.execute(request('approval'));
  await assert.rejects(host.prepare({ runId: 'same-session', sessionKey: 'approval' }), /session_busy/);
  await host.prepare({ runId: 'other-session', sessionKey: 'approval-alias' });
  await assert.rejects(host.execute({ ...request('other-session', 'approval-alias'), resumeSessionId: 'thread:approval' }), /session_busy/);
  await host.prepare({ runId: 'chat' });
  assert.equal((await host.execute(request('chat')) as { result: { state: string } }).result.state, 'completed');
  await host.collect('chat'); await host.release('chat');
  assert.equal(host.getExecution('approval')?.state, 'running');
  await host.prepare({ runId: 'cancel' });
  const canceled = host.execute(request('cancel'));
  await cancelStarted.promise;
  await host.prepare({ runId: 'overflow' });
  await assert.rejects(host.execute(request('overflow')), /device_busy/);
  assert.deepEqual(host.activeRunIds.sort(), ['approval', 'cancel']);
  host.cancel('cancel'); await canceled;
  assert.equal(inputs.get('approval')!.signal.aborted, false);
  approve.resolve();
  assert.deepEqual(await replay, await first);
  assert.deepEqual(decisions, ['allow']); assert.equal(starts, 3);
  assert.equal(await inputs.get('approval')!.permission!({ id: 'late', title: 'Late', details: {}, canAllow: true }, new AbortController().signal, Promise.resolve()), 'deny');
  assert.deepEqual(host.activeRunIds, []);
});

test('observation streaming sends the first fragment immediately and merges a burst before its receipt', { timeout: 5000 }, async t => {
  const receipt = deferred(), sent: Record<string, unknown>[] = [];
  const writer = new ObservationWriter(async (_kind, payload) => {
    sent.push(payload as Record<string, unknown>);
    if (sent.length === 1) await receipt.promise;
  }, new AbortController().signal);
  t.after(() => { writer.close(); receipt.resolve(); });
  const chunks = Array.from({ length: 179 }, (_, i) => i < 126 ? '你好' : '你');
  for (const text of chunks) await writer.write('event', textDelta(text));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, chunks[0]);
  let completed = false;
  const completion = writer.finish().then(() => { completed = true; });
  await nextTurn();
  assert.equal(completed, false);
  receipt.resolve(); await completion;
  assert.equal(sent.length, 2);
  assert.equal(sent.map(part => part.text).join(''), chunks.join(''));
});

test('observation streaming flushes on time and preserves message, phase and tool boundaries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Record<string, unknown>[] = [];
  const writer = new ObservationWriter(async (_kind, payload) => { sent.push(payload as Record<string, unknown>); }, new AbortController().signal);
  t.after(() => writer.close());
  await writer.write('event', textDelta('a', 'commentary'));
  await writer.write('event', textDelta('b', 'commentary'));
  await writer.write('event', textDelta('c', 'commentary'));
  t.mock.timers.tick(99); await nextTurn();
  assert.deepEqual(sent.map(part => part.text), ['a']);
  t.mock.timers.tick(1); await nextTurn();
  assert.deepEqual(sent.map(part => part.text), ['a', 'bc']);
  await writer.write('event', textDelta('d', 'commentary'));
  await writer.write('event', textDelta('e'));
  await writer.write('event', textDelta('f'));
  await writer.write('event', { type: 'tool_call', id: 'tool' });
  await writer.write('event', { ...textDelta('g'), messageId: 'second' });
  await writer.write('event', { type: 'text_delta', text: 'no-id' });
  await writer.finish();
  assert.deepEqual(sent.map(part => part.text ?? part.type), ['a', 'bc', 'd', 'e', 'f', 'tool_call', 'g', 'no-id']);
  assert.deepEqual(sent.filter(part => part.text === 'd' || part.text === 'e').map(part => part.phase), ['commentary', 'final_answer']);
});

test('observation streaming applies bounded backpressure and cancellation stops queued sends', { timeout: 5000 }, async t => {
  const receipt = deferred(), controller = new AbortController();
  let sends = 0;
  const writer = new ObservationWriter(async () => { sends++; await receipt.promise; }, controller.signal);
  t.after(() => { writer.close(); receipt.resolve(); });
  for (let n = 0; n < 16; n++) await writer.write('event', textDelta('x'.repeat(4096)));
  let accepted = false;
  const blocked = writer.write('event', textDelta('tail')).then(() => { accepted = true; });
  await nextTurn();
  assert.equal(accepted, false);
  assert.equal(sends, 1);
  controller.abort();
  await blocked; await writer.finish();
  receipt.resolve(); await nextTurn();
  assert.equal(sends, 1);
});

test('observation streaming never treats a failed local observation write as confirmed completion', async t => {
  const failure = new Error('disk full');
  const writer = new ObservationWriter(async () => { throw failure; }, new AbortController().signal);
  t.after(() => writer.close());
  await writer.write('event', textDelta('a'));
  await assert.rejects(writer.finish(), error => error === failure);
  await assert.rejects(writer.write('event', textDelta('b')), error => error === failure);
});

test('device preparation preserves identity and stable skills, and output publication rejects links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-device-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { mode: 'device' as const, nodeId: randomUUID(), token: 'x'.repeat(32), endpoint: 'ws://127.0.0.1:48518/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { disabled: true }, dsh: { disabled: true } } };
  const host = new DeviceHost(config);
  t.after(() => host.close());
  const files = [{ path: 'skill/SKILL.md', contentBase64: Buffer.from('synthetic').toString('base64') }];
  const first = await host.prepare({ runId: 'run:one', sessionKey: 'session', files });
  assert.deepEqual(await host.prepare({ runId: 'run:one', sessionKey: 'session', files }), first);
  assert.equal(first.workdir, root);
  assert.equal(await readFile(join(first.skillDirectory, 'skill/SKILL.md'), 'utf8'), 'synthetic');
  await assert.rejects(host.prepare({ runId: 'run:one', files: [] }), /identity_conflict/);
  await assert.rejects(host.prepare({ runId: 'unsafe', files: [{ path: '../escape', contentBase64: '' }] }), /unsafe_file_path/);
  await host.release('run:one');
  const second = await host.prepare({ runId: 'run:two', sessionKey: 'session', files });
  assert.equal(second.skillDirectory, first.skillDirectory);
  assert.notEqual(second.outputDirectory, first.outputDirectory);
  await writeFile(join(second.outputDirectory, 'safe.txt'), 'public');
  assert.equal((await host.collect('run:two'))[0]?.contentBase64, Buffer.from('public').toString('base64'));
  const outside = join(root, 'secret'); await writeFile(outside, 'private');
  await symlink(outside, join(second.outputDirectory, 'link'));
  await assert.rejects(host.collect('run:two'), /unsafe_output_path/);
  await rm(join(second.outputDirectory, 'link'));
  await link(outside, join(second.outputDirectory, 'hardlink'));
  await assert.rejects(host.collect('run:two'), /unsafe_output_path/);
  await rm(join(second.outputDirectory, 'hardlink'));
  const outsidePrepared = join(root, 'outside-prepared');
  const runName = basename(dirname(second.outputDirectory));
  const outsideRun = join(outsidePrepared, runName);
  const secret = join(outsideRun, 'output', 'secret.txt');
  await mkdir(dirname(secret), { recursive: true });
  await writeFile(secret, 'must not be published or deleted');
  for (const [ancestor, destination] of [
    [join(config.stateDir, 'prepared'), outsidePrepared],
    [dirname(second.outputDirectory), outsideRun],
  ]) {
    const backup = `${ancestor}.saved`;
    await rename(ancestor!, backup);
    await symlink(destination!, ancestor!);
    try {
      await assert.rejects(host.collect('run:two'), /unsafe_managed_directory/);
      await assert.rejects(host.release('run:two'), /unsafe_managed_directory/);
      assert.equal(await readFile(secret, 'utf8'), 'must not be published or deleted');
    } finally {
      await rm(ancestor!);
      await rename(backup, ancestor!);
    }
  }
  assert.equal((await host.collect('run:two'))[0]?.contentBase64, Buffer.from('public').toString('base64'));
  await writeFile(join(second.skillDirectory, 'skill/SKILL.md'), 'tampered');
  await assert.rejects(host.prepare({ runId: 'run:two', sessionKey: 'session', files }), /skill_cache_mismatch/);
  await assert.rejects(host.prepare({ runId: 'run:three', sessionKey: 'session', files }), /skill_cache_mismatch/);
  await host.release('run:two');
  assert.equal(await readFile(secret, 'utf8'), 'must not be published or deleted');
});

test('preparation retries and release recover unregistered directories without altering execution evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-prepare-recovery-'));
  const config = { mode: 'device' as const, nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'), resources: { maxStateBytes: 2 * 1024 * 1024 },
    providers: { codex: { disabled: true }, dsh: { disabled: true } } };
  const files = [{ path: 'skill/SKILL.md', contentBase64: Buffer.from('synthetic skill').toString('base64') }];
  // Reproduce a restart after files were published but before their SQLite registration.
  const first = new DeviceHost(config);
  await first.close();
  const retry = await prepareDirectories(config.stateDir, 'retry', 'session', files, root);
  const release = await prepareDirectories(config.stateDir, 'release', 'session', files, root);
  const admitted = await prepareDirectories(config.stateDir, 'admitted', 'session', files, root);
  await writeFile(join(retry.outputDirectory, 'stale.txt'), Buffer.alloc(config.resources.maxStateBytes));
  await writeFile(join(admitted.outputDirectory, 'evidence.txt'), 'must remain');
  const store = new DeviceStore(config.nodeId, config.stateDir);
  store.admit({ runId: 'admitted', provider: 'codex', input: 'synthetic', state: 'unknown' });
  store.close();
  const host = new DeviceHost(config);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

  assert.deepEqual(await host.prepare({ runId: 'retry', sessionKey: 'session', files }), retry);
  await assert.rejects(readFile(join(retry.outputDirectory, 'stale.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(retry.skillDirectory, 'skill/SKILL.md'), 'utf8'), 'synthetic skill');
  await writeFile(join(retry.outputDirectory, 'registered.txt'), 'keep registered output');
  assert.deepEqual(await host.prepare({ runId: 'retry', sessionKey: 'session', files }), retry);
  assert.equal(await readFile(join(retry.outputDirectory, 'registered.txt'), 'utf8'), 'keep registered output');
  await host.release('release');
  await assert.rejects(lstat(dirname(release.outputDirectory)), { code: 'ENOENT' });
  await assert.rejects(host.prepare({ runId: 'admitted', sessionKey: 'session', files }), /preparation_identity_conflict/);
  await host.release('admitted');
  assert.equal(await readFile(join(admitted.outputDirectory, 'evidence.txt'), 'utf8'), 'must remain');
  assert.equal(host.getExecution('admitted')?.state, 'unknown');

  const unsafe = await prepareDirectories(config.stateDir, 'unsafe', 'session', files, root);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'must not be deleted');
  await rename(dirname(unsafe.outputDirectory), `${dirname(unsafe.outputDirectory)}.saved`);
  await symlink(outside, dirname(unsafe.outputDirectory));
  await assert.rejects(host.prepare({ runId: 'unsafe', sessionKey: 'session', files }), /unsafe_managed_directory/);
  await assert.rejects(host.release('unsafe'), /unsafe_managed_directory/);
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'must not be deleted');
});

test('refreshed capabilities validate reused adapters before starting another execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-capability-refresh-'));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.1.0"\n', { mode: 0o700 });
  let effort = 'low', mode = 'original-mode', probes = 0, owners = 0;
  const executions: { effort?: string; mode?: string }[] = [];
  const host = new DeviceHost({ mode: 'device', nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { executable, home: root }, dsh: { disabled: true } },
  }, createProviderAdapters(() => {
    owners++;
    return {
      inspect: async () => {
        probes++;
        return { models: [{ id: 'synthetic', efforts: [effort], serviceTiers: [] }],
          permissionModes: [{ value: mode, name: mode }],
          config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: false } };
      },
      reconcile: async () => null, close: async () => {},
      execute: async input => {
        executions.push({ effort: input.effort, mode: input.mode });
        await input.onReady(`thread:${input.runId}`);
        return { runId: input.runId, fingerprint: 'synthetic', state: 'completed', threadId: `thread:${input.runId}`,
          turnId: input.runId, messages: [{ id: input.runId, phase: 'final_answer', text: 'synthetic' }] } as CodexEvidence;
      },
    };
  }));
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const request = (runId: string, config: { effort?: string; mode?: string }) => ({
    provider: 'codex', runId, sessionKey: 'session', prompt: 'synthetic', model: 'synthetic', config,
  });
  host.bind(async () => null);
  await host.inventory();
  await host.prepare({ runId: 'first', sessionKey: 'session' });
  await host.execute(request('first', { effort, mode }));
  assert.equal(host.getExecution('first')?.state, 'completed');
  await host.release('first');

  effort = 'high'; mode = 'updated-mode';
  await host.inventory(true);
  await host.prepare({ runId: 'second', sessionKey: 'session' });
  await assert.rejects(host.execute(request('second', { effort: 'low', mode })), /configuration_unavailable/);
  await assert.rejects(host.execute(request('second', { effort, mode: 'original-mode' })), /permission_mode_unavailable/);
  assert.equal(executions.length, 1, 'invalid configurations must not dispatch a prompt');
  assert.equal(host.getExecution('second'), null);
  const second = request('second', { effort, mode });
  await host.execute(second);
  assert.equal(host.getExecution('second')?.state, 'completed');
  await host.execute(second);
  assert.deepEqual(executions, [{ effort: 'low', mode: 'original-mode' }, { effort: 'high', mode: 'updated-mode' }]);
  assert.equal(probes, 2, 'admission reuses the latest probe without starting another probe');
  assert.equal(owners, 2, 'refresh does not replace the session adapter');
});

test('device admission is durable and restart leaves interrupted executions unknown without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-device-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeId = randomUUID();
  const first = new DeviceStore(nodeId, root);
  first.admit({ runId: 'run', provider: 'codex', input: 'fingerprint', state: 'running' });
  first.observe('run', 'event', { type: 'text_delta', text: 'synthetic' });
  assert.throws(() => new DeviceStore(nodeId, root), /locked/);
  assert.throws(() => first.admit({ runId: 'run', provider: 'codex', input: 'other', state: 'running' }), /UNIQUE/);
  first.close();
  const second = new DeviceStore(nodeId, root);
  assert.equal(second.get('run')?.state, 'unknown');
  assert.deepEqual(second.unresolved(), ['run']);
  assert.equal(second.get('run')?.input, 'fingerprint');
  assert.deepEqual(second.events('run', 0)[0]?.payload, { type: 'text_delta', text: 'synthetic' });
  assert.deepEqual(second.events('other', 0), []);
  second.close();
  assert.throws(() => new DeviceStore(randomUUID(), root), /state_node_mismatch/);
});

test('maintenance shutdown refuses a pending admission or unknown result and reserves close before yielding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { mode: 'device' as const, nodeId: randomUUID(), token: 'x'.repeat(32),
    endpoint: 'ws://127.0.0.1:1/', cwd: root, stateDir: join(root, 'state'),
    providers: { codex: { disabled: true }, dsh: { disabled: true } } };
  const host = new DeviceHost(config);
  const preparing = host.prepare({ runId: 'prepared' });
  assert.throws(() => host.closeIfIdle(), /device_busy/);
  await preparing;
  const closing = host.closeIfIdle();
  await assert.rejects(host.prepare({ runId: 'too-late' }), /device_stopping/);
  await closing;
  const store = new DeviceStore(config.nodeId, config.stateDir);
  store.admit({ runId: 'unknown', provider: 'codex', input: 'identity', state: 'unknown' }); store.close();
  const recovered = new DeviceHost(config);
  try {
    assert.throws(() => recovered.closeIfIdle(), /unresolved_execution/);
    assert.deepEqual(recovered.maintenanceStatus().unresolvedRunIds, ['unknown']);
  } finally { await recovered.close(); }
});


test('history expiry keeps admission identities and unknown evidence; limits produce an explicit gap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-resource-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DeviceStore(randomUUID(), root, { historyRetentionMs: 10, maxRunEvents: 2, maxEventBytes: 512, maxPageBytes: 512, maxIdentities: 3 });
  t.after(() => store.close());
  const directories = { workdir: root, skillDirectory: root, outputDirectory: root };
  for (const runId of ['done', 'unknown', 'unreleased']) {
    store.prepare(runId, { input: runId, sessionKey: runId, directories });
    store.admit({ runId, provider: 'codex', input: runId, state: 'running' });
  }
  assert.throws(() => store.assertCapacity(), /node_storage_full/);
  store.assertCapacity('done');
  for (let index = 0; index < 5; index++) store.observe('done', 'event', { text: 'x'.repeat(300) });
  const page = store.events('done', 0);
  assert.equal(page.length, 1);
  const remainder = store.events('done', page[0]!.sequence);
  assert.equal(remainder.at(-1)?.kind, 'history_truncated');
  assert.equal(store.get('done')?.historyTruncated, true);
  store.save({ ...store.get('done')!, state: 'completed', result: { text: 'finished' } });
  store.markReleased('done');
  store.save({ ...store.get('unknown')!, state: 'unknown' });
  store.markReleased('unknown');
  store.save({ ...store.get('unreleased')!, state: 'failed' });
  assert.equal(store.expireDetails(Date.now() + 100), 1);
  assert.equal(store.get('done')?.input, 'done');
  assert.equal(store.get('done')?.detailsExpired, true);
  assert.equal(store.get('done')?.result, undefined);
  assert.throws(() => store.events('done', 0), /execution_details_expired/);
  assert.equal(store.get('unknown')?.detailsExpired, undefined);
  assert.equal(store.get('unreleased')?.detailsExpired, undefined);
  assert.throws(() => store.forgetSession('unknown'), /session_in_use/);
  assert.throws(() => store.forgetSession('unreleased'), /session_in_use/);
  assert.deepEqual(store.forgetSession('done').runIds, ['done']);
  assert.throws(() => store.assertSessionOpen('done'), /session_forgotten/);
  assert.throws(() => store.admit({ runId: 'done', input: 'new', provider: 'codex', state: 'running' }), /UNIQUE/);
});

test('managed cleanup avoids user directories and background logs rotate while running', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dock-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'); await mkdir(stateDir);
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'user file');
  await symlink(outside, join(stateDir, 'sessions'));
  const linkBytes = (await lstat(join(stateDir, 'sessions'))).size;
  assert.equal(await managedStateBytes(stateDir, 1024), linkBytes);
  await assert.rejects(forgetSessionDirectories(stateDir, 'session'), /unsafe_managed_directory/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'user file');
  const nested = join(stateDir, 'nested'); await mkdir(nested);
  const sizes = Array.from({ length: 67 }, (_, index) => index + 1);
  await Promise.all(sizes.map((size, index) => writeFile(join(index % 2 ? nested : stateDir, `file-${index}`), Buffer.alloc(size))));
  const expected = linkBytes + sizes.reduce((sum, size) => sum + size, 0);
  assert.equal(await managedStateBytes(stateDir, expected + 1), expected);
  assert.equal(await managedStateBytes(stateDir, expected), expected);
  assert.ok(await managedStateBytes(stateDir, expected - 1) > expected - 1);
  await writeFile(join(nested, 'new-provider-output'), 'new bytes');
  assert.equal(await managedStateBytes(stateDir, expected + 100), expected + 9);
  await writeFile(join(outside, 'keep'), Buffer.alloc(expected + 1000));
  assert.equal(await managedStateBytes(stateDir, expected + 100), expected + 9);
  const deep = join(stateDir, ...Array.from({ length: 65 }, () => 'deep'));
  await mkdir(deep, { recursive: true });
  assert.ok(await managedStateBytes(stateDir, expected + 100) > expected + 100);
  await rm(join(stateDir, 'deep'), { recursive: true });
  const log = new RotatingLog(stateDir, 128, 3);
  for (let index = 0; index < 10; index++) log.write(String(index).repeat(100));
  log.close();
  assert.equal((await readFile(join(stateDir, 'daemon.log'), 'utf8')), '9'.repeat(100));
  assert.equal((await readFile(join(stateDir, 'daemon.log.2'), 'utf8')), '7'.repeat(100));
  await assert.rejects(readFile(join(stateDir, 'daemon.log.3')), /ENOENT/);
  await rm(join(stateDir, 'sessions'));
  const sessionKey = 'forget-this-session', key = digest(sessionKey), otherKey = digest('keep-other-session');
  const scopes = [['sessions'], ['providers', 'codex'], ['providers', 'dsh']];
  for (const scope of scopes) {
    for (const selected of [key, otherKey]) {
      const path = join(stateDir, ...scope, selected); await mkdir(path, { recursive: true });
      await writeFile(join(path, 'keep'), selected);
    }
  }
  await forgetSessionDirectories(stateDir, sessionKey);
  for (const scope of scopes) {
    await assert.rejects(lstat(join(stateDir, ...scope, key)), { code: 'ENOENT' });
    assert.equal(await readFile(join(stateDir, ...scope, otherKey, 'keep'), 'utf8'), otherKey);
  }
  assert.equal((await readFile(join(outside, 'keep'))).length, expected + 1000, 'native user files remain outside cleanup targets');
});
