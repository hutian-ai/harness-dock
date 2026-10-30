import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ExecutionCommandError, runTask, type ExecutionPeer } from '../packages/client/src/execution-command.ts';
import type {
  DeviceExecuteInput, DeviceExecutionCallback, DeviceExecutionResponse, DeviceInventory,
} from '../packages/protocol/src/index.ts';

type CallbackHandler = Parameters<ExecutionPeer['onExecutionCallback']>[0];
type CallbackContext = Parameters<CallbackHandler>[1];
type Request = { method: string; params: object; timeoutMs?: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const nodeId = randomUUID(), initialDaemonId = randomUUID();
  let daemonId: string = initialDaemonId;
  let connected = true, handler: CallbackHandler | undefined;
  const calls: Request[] = [];
  const input = { provider: 'codex', runId: randomUUID(), prompt: 'Return a synthetic result.' };
  const result: DeviceExecutionResponse = { provider: 'codex', result: { state: 'completed', opaqueNativeResult: { value: 'synthetic' } } };
  const inventory: DeviceInventory = {
    nodeId, daemonId, workdir: '/synthetic/work',
    platform: { platform: 'darwin', arch: 'arm64', release: 'synthetic', hostname: 'synthetic' },
    activeRunIds: [], unresolvedRunIds: [], resources: {},
    providers: [{ key: 'codex', displayName: 'Codex', status: 'ready', version: null,
      models: ['native-model'], sessionResumeMode: 'native', capabilities: {
        protocol: 'acp', sessionResume: 'native', resultQuery: 'native', exactFinalAnswer: false,
        callerSkills: true, permissionInteractions: ['options'], desktopTools: 'not_reported', browser: 'unverified',
      } }],
  };
  let prepare: () => Promise<unknown> = async () => ({ workdir: '/synthetic/work', skillDirectory: '/synthetic/skills', outputDirectory: '/synthetic/output' });
  let execute: (value: DeviceExecuteInput) => Promise<unknown> = async () => result;
  const peer: ExecutionPeer = {
    nodeId,
    get daemonId() { return daemonId; },
    get connected() { return connected; },
    request: (async (method: string, params: object = {}, timeoutMs?: number) => {
      assert.ok(handler, 'callbacks must be installed before interacting with the device');
      calls.push({ method, params, timeoutMs });
      if (method === 'inventory') return inventory;
      if (method === 'prepare') return prepare();
      if (method === 'execute') return execute(params as DeviceExecuteInput);
      throw new Error('unexpected_method:' + method);
    }) as ExecutionPeer['request'],
    onExecutionCallback(next) {
      assert.equal(handler, undefined);
      handler = next;
      return () => { handler = undefined; };
    },
  };
  return {
    peer, input, result, inventory, calls,
    setPrepare(next: typeof prepare) { prepare = next; },
    setExecute(next: typeof execute) { execute = next; },
    setDaemonId(next: string) { daemonId = next; },
    disconnect() { connected = false; },
    hasCallback() { return handler !== undefined; },
    async emit(call: DeviceExecutionCallback, context: Partial<CallbackContext> = {}) {
      assert.ok(handler, 'callback should be active');
      return handler(call, { nodeId, daemonId: initialDaemonId, signal: new AbortController().signal, ...context });
    },
  };
}

function permission(runId: string, requestId: string = randomUUID()): DeviceExecutionCallback {
  return { runId, kind: 'permission', payload: { id: requestId, title: 'Synthetic native request', details: {}, canAllow: true,
    options: [{ optionId: 'native-once', name: 'Allow once', kind: 'allow_once' }] } };
}

test('task execution preserves the native default model and opaque completion without an exact-final requirement', async () => {
  const value = fixture();
  assert.deepEqual(await runTask(value.peer, value.input), value.result);
  assert.deepEqual(value.calls.map(call => call.method), ['inventory', 'prepare', 'execute']);
  const execution = value.calls.find(call => call.method === 'execute')!;
  assert.equal(Object.hasOwn(execution.params, 'model'), false);
  assert.deepEqual(execution.params, value.input);
  assert.ok(execution.timeoutMs! >= 30 * 60_000, 'a real task must allow time for native interaction');
  assert.equal(value.hasCallback(), false);
});

test('a lost task response never repeats execution or releases resources', async () => {
  const value = fixture();
  value.setExecute(async () => { throw new Error('response_lost_after_admission'); });
  await assert.rejects(runTask(value.peer, value.input), error => {
    assert.ok(error instanceof ExecutionCommandError);
    assert.equal(error.executionAttempted, true);
    assert.match(error.message, /response_lost_after_admission/);
    return true;
  });
  assert.deepEqual(value.calls.map(call => call.method), ['inventory', 'prepare', 'execute']);
  assert.equal(value.hasCallback(), false);
});

test('task preparation requires matching inventory identity and an available provider and explicit model', async () => {
  for (const failure of ['node', 'daemon', 'provider', 'model'] as const) {
    const value = fixture();
    if (failure === 'node') value.inventory.nodeId = randomUUID();
    if (failure === 'daemon') value.inventory.daemonId = randomUUID();
    if (failure === 'provider') value.inventory.providers[0]!.status = 'unavailable';
    const input = failure === 'model' ? { ...value.input, model: 'not-advertised' } : value.input;
    await assert.rejects(runTask(value.peer, input), error => {
      assert.ok(error instanceof ExecutionCommandError, failure);
      assert.equal(error.executionAttempted, false, failure);
      return true;
    });
    assert.deepEqual(value.calls.map(call => call.method), ['inventory'], failure);
    assert.equal(value.hasCallback(), false, failure);
  }
});

test('an unconfirmed preparation response is not an attempted native execution and is never retried', async () => {
  const value = fixture();
  value.setPrepare(async () => { throw new Error('response_lost'); });
  await assert.rejects(runTask(value.peer, value.input), error => {
    assert.ok(error instanceof ExecutionCommandError);
    assert.equal(error.executionAttempted, false);
    assert.equal(error.message, 'response_lost');
    return true;
  });
  assert.deepEqual(value.calls.map(call => call.method), ['inventory', 'prepare']);
  assert.equal(value.hasCallback(), false);
});

test('an invalid execution response remains uncertain after the execute boundary', async () => {
  const value = fixture();
  value.setExecute(async () => ({ provider: 'different-provider', result: { state: 'completed' } }));
  await assert.rejects(runTask(value.peer, value.input), error => {
    assert.ok(error instanceof ExecutionCommandError);
    assert.equal(error.executionAttempted, true);
    assert.equal(error.message, 'invalid_execution_response');
    return true;
  });
  assert.deepEqual(value.calls.map(call => call.method), ['inventory', 'prepare', 'execute']);
  assert.equal(value.hasCallback(), false);
});

test('callbacks for another node, daemon or run cannot request a permission decision', async () => {
  const value = fixture();
  let decisions = 0;
  value.setExecute(async () => {
    await assert.rejects(value.emit(permission(value.input.runId), { nodeId: randomUUID() }));
    await assert.rejects(value.emit(permission(value.input.runId), { daemonId: randomUUID() }));
    await assert.rejects(value.emit(permission(randomUUID())));
    return value.result;
  });
  assert.deepEqual(await runTask(value.peer, value.input, { permission: async () => { decisions++; return { optionId: 'native-once' }; } }), value.result);
  assert.equal(decisions, 0);
});

test('task permissions default to denial without installing application tools', async () => {
  const value = fixture();
  value.setExecute(async () => {
    assert.equal(await value.emit(permission(value.input.runId)), 'deny');
    await assert.rejects(value.emit({ runId: value.input.runId, kind: 'toolCall', payload: { callId: 'unexpected', name: 'unregistered', arguments: {} } }));
    return value.result;
  });
  assert.deepEqual(await runTask(value.peer, value.input), value.result);
  assert.equal(Object.hasOwn(value.calls.find(call => call.method === 'execute')!.params, 'tools'), false);
});

test('simultaneous native permissions are presented one at a time', { timeout: 10_000 }, async () => {
  const value = fixture(), entered = deferred<void>(), firstAnswer = deferred<unknown>();
  const order: string[] = [];
  let active = 0, maximum = 0;
  value.setExecute(async () => {
    const first = value.emit(permission(value.input.runId, 'first'));
    await entered.promise;
    const second = value.emit(permission(value.input.runId, 'second'));
    await Promise.resolve();
    assert.deepEqual(order, ['first']);
    firstAnswer.resolve({ optionId: 'native-once' });
    assert.deepEqual(await first, { optionId: 'native-once' });
    assert.equal(await second, 'deny');
    return value.result;
  });
  await runTask(value.peer, value.input, { permission: async payload => {
    active++; maximum = Math.max(maximum, active); order.push(String(payload.id));
    try {
      if (payload.id === 'first') { entered.resolve(); return await firstAnswer.promise; }
      return 'deny';
    } finally { active--; }
  } });
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(maximum, 1);
});

test('a queued native permission expires before it can prompt', { timeout: 10_000 }, async () => {
  const value = fixture(), entered = deferred<void>(), firstAnswer = deferred<unknown>(), secondSignal = new AbortController();
  const prompted: string[] = [];
  value.setExecute(async () => {
    const first = value.emit(permission(value.input.runId, 'first'));
    await entered.promise;
    const secondRejected = assert.rejects(value.emit(permission(value.input.runId, 'second'), { signal: secondSignal.signal }));
    secondSignal.abort(new Error('native_request_expired'));
    firstAnswer.resolve('deny');
    assert.equal(await first, 'deny');
    await secondRejected;
    return value.result;
  });
  await runTask(value.peer, value.input, { permission: async payload => {
    prompted.push(String(payload.id)); entered.resolve(); return firstAnswer.promise;
  } });
  assert.deepEqual(prompted, ['first']);
});

test('a native permission decision is rejected after its request expires', { timeout: 10_000 }, async () => {
  const value = fixture(), entered = deferred<void>(), answer = deferred<unknown>(), nativeSignal = new AbortController();
  value.setExecute(async () => {
    const rejected = assert.rejects(value.emit(permission(value.input.runId), { signal: nativeSignal.signal }));
    await entered.promise;
    nativeSignal.abort(new Error('native_request_expired'));
    answer.resolve({ optionId: 'native-once' });
    await rejected;
    return value.result;
  });
  await runTask(value.peer, value.input, { permission: async () => { entered.resolve(); return answer.promise; } });
  assert.equal(value.hasCallback(), false);
});

test('a replaced daemon cannot accept an old permission decision or report completion', { timeout: 10_000 }, async () => {
  const value = fixture(), entered = deferred<void>(), answer = deferred<unknown>();
  value.setExecute(async () => {
    const rejected = assert.rejects(value.emit(permission(value.input.runId)));
    await entered.promise;
    value.setDaemonId(randomUUID());
    answer.resolve({ optionId: 'native-once' });
    await rejected;
    return value.result;
  });
  await assert.rejects(runTask(value.peer, value.input, { permission: async () => { entered.resolve(); return answer.promise; } }));
  assert.equal(value.calls.filter(call => call.method === 'execute').length, 1);
  assert.equal(value.hasCallback(), false);
});

test('an already interrupted task cannot prepare or execute', async () => {
  const value = fixture(), interrupted = new AbortController();
  interrupted.abort(new Error('caller_interrupted'));
  await assert.rejects(runTask(value.peer, value.input, { signal: interrupted.signal }));
  assert.deepEqual(value.calls, []);
  assert.equal(value.hasCallback(), false);
});

test('command interruption aborts a pending native interaction instead of delivering a decision', { timeout: 10_000 }, async () => {
  const value = fixture(), entered = deferred<void>(), interrupted = new AbortController();
  let observedSignal: AbortSignal | undefined;
  value.setExecute(async () => {
    const rejected = assert.rejects(value.emit(permission(value.input.runId)));
    await entered.promise;
    interrupted.abort(new Error('caller_interrupted'));
    await rejected;
    return value.result;
  });
  await assert.rejects(runTask(value.peer, value.input, { signal: interrupted.signal, permission: async (_payload, signal) => {
    observedSignal = signal; entered.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
  } }));
  assert.equal(observedSignal?.aborted, true);
  assert.equal(value.hasCallback(), false);
});
