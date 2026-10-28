import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
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

test('failed acceptance initialization removes partial credential copies and preserves the native home', { timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dock-accept-failure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'settings.yaml'), 'synthetic settings');
  await mkdir(join(home, '.credentials.yaml')); // Fail after copying the first file.
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { acceptDevice } from './scripts/accept-device.ts'; await acceptDevice('deepseek-harness');"],
  { env: { ...process.env, DSH_HOME: home }, timeout: 15_000 }).then(
    () => assert.fail('the invalid credential source must fail initialization'),
    error => error as Error & { code: number | string; stdout: string },
  );
  assert.equal(result.code, 1);
  const output = result.stdout.split('\n').find(line => line.startsWith('{"evidenceDir"'));
  assert(output, result.stdout);
  const { evidenceDir } = JSON.parse(output) as { evidenceDir: string };
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const evidence = JSON.parse(await readFile(join(evidenceDir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.match(evidence.error, /EISDIR|ENOTSUP/);
  assert.equal(evidence.ready, 0);
  await assert.rejects(stat(join(evidenceDir, 'deepseek-home', 'settings.yaml')), { code: 'ENOENT' });
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'synthetic settings');
  assert((await stat(join(home, '.credentials.yaml'))).isDirectory());
});
