import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { Dock } from '../packages/client/src/dock.ts';
import { ExecutionCommandError, type ExecutionPeer } from '../packages/client/src/execution-command.ts';
import type { ServerClient } from '../packages/client/src/server-client.ts';

async function fixture() {
  await mkdir('.local/tests', { recursive: true });
  const root = await mkdtemp(resolve('.local/tests/dock-'));
  const receipt = join(root, 'task.json'), clientId = randomUUID(), nodeId = randomUUID(), daemonId = randomUUID();
  const calls: string[] = [];
  let handler: Parameters<ExecutionPeer['onExecutionCallback']>[0] | undefined;
  let failExecute = false;
  let count = 1;
  const peer: ExecutionPeer = {
    nodeId, daemonId, connected: true,
    request: (async (method: string, params: { runId?: string }) => {
      calls.push(method);
      if (method === 'getExecution') return null;
      // The receipt must be durable before ANY device interaction.
      const saved = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(saved.nodeId, nodeId);
      assert.ok(handler);
      if (method === 'inventory') return { nodeId, daemonId, providers: [{ key: 'codex', status: 'ready' }] };
      assert.equal(params.runId, saved.runId);
      if (method === 'prepare') return {};
      if (method === 'execute') {
        const decision = await handler!({ runId: params.runId!, kind: 'permission', payload: {
          id: randomUUID(), title: 'synthetic permission', details: {}, canAllow: true,
        } }, { nodeId, daemonId, signal: new AbortController().signal });
        assert.equal(decision, 'deny');
        if (failExecute) throw new Error('connection_lost');
        return { provider: 'codex', result: { state: 'completed' } };
      }
      throw new Error('unexpected_method');
    }) as ExecutionPeer['request'],
    onExecutionCallback(next) {
      assert.equal(handler, undefined);
      handler = next;
      return () => { handler = undefined; };
    },
  };
  const client = {
    listNodes: () => Array.from({ length: count }, (_, n) => ({ nodeId: n ? randomUUID() : nodeId, connected: true })),
    node: (id: string) => id === nodeId ? peer : undefined,
    close: async () => {},
  } as unknown as ServerClient;
  return { dock: new Dock(client, clientId), client, clientId, receipt, calls,
    setCount(n: number) { count = n; }, fail() { failExecute = true; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('simple SDK saves a private receipt before dispatch, denies approvals and never auto-releases', async () => {
  const f = await fixture();
  try {
    const result = await f.dock.run({ prompt: 'synthetic', receipt: f.receipt });
    assert.equal(result.result.state, 'completed');
    assert.deepEqual(f.calls, ['inventory', 'prepare', 'execute']);
    assert.equal((await stat(f.receipt)).mode & 0o777, 0o600);
    await assert.rejects(f.dock.run({ prompt: 'synthetic', receipt: f.receipt }), /EEXIST/);
    assert.equal(f.calls.length, 3);
  } finally { await f.cleanup(); }
});

test('simple SDK requires explicit selection with multiple granted devices', async () => {
  const f = await fixture();
  try {
    f.setCount(2);
    await assert.rejects(f.dock.run({ prompt: 'synthetic', receipt: f.receipt }), /select_node/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(readFile(f.receipt), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('lost execution response preserves receipt and status only observes original task', async () => {
  const f = await fixture();
  try {
    f.fail();
    await assert.rejects(f.dock.run({ prompt: 'synthetic', receipt: f.receipt }), error =>
      error instanceof ExecutionCommandError && error.executionAttempted);
    assert.equal(await f.dock.status(f.receipt), null);
    assert.deepEqual(f.calls, ['inventory', 'prepare', 'execute', 'getExecution']);
    await assert.rejects(f.dock.run({ prompt: 'synthetic', receipt: f.receipt }), /EEXIST/);
    assert.equal(f.calls.filter(x => x === 'execute').length, 1);
  } finally { await f.cleanup(); }
});

test('status refuses receipts belonging to a different application', async () => {
  const f = await fixture();
  try {
    await f.dock.run({ prompt: 'synthetic', receipt: f.receipt });
    const other = new Dock(f.client, randomUUID());
    await assert.rejects(other.status(f.receipt), /receipt_client_mismatch/);
    assert.equal(f.calls.includes('getExecution'), false);
  } finally { await f.cleanup(); }
});
