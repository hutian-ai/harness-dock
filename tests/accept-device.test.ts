import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareAfterIdle } from '../scripts/accept-device.ts';

test('cold acceptance retries only a confirmed preparation busy rejection, never an uncertain result', async () => {
  const input = { runId: 'same-preparation', sessionKey: 'synthetic', files: [] as [] };
  let calls = 0;
  await prepareAfterIdle({ async request(method, params) {
    assert.equal(method, 'prepare'); assert.equal(params, input);
    if (++calls === 1) throw new Error('busy');
    return {};
  } }, input);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(prepareAfterIdle({ async request() {
    calls++; throw new Error('disconnected: outcome may be unknown');
  } }, input), /unknown/);
  assert.equal(calls, 1);
});
