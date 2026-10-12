import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockClient } from '../packages/client/src/index.ts';
import { terminal, type RunSnapshot } from '../packages/protocol/src/index.ts';

const [binary, sourceHome] = process.argv.slice(2).filter(value => value !== '--');
if (!binary || !sourceHome) throw new Error('Usage: pnpm accept:zcode <absolute ZCode CLI> <authenticated ZCODE_HOME>');
const directory = resolve('.local/zcode-acceptance', new Date().toISOString().replaceAll(':', '-'));
const work = join(directory, 'work'), home = join(directory, 'zcode-home');
await mkdir(work, { recursive: true, mode: 0o700 });
await mkdir(join(home, 'v2'), { recursive: true, mode: 0o700 });
// Copy only authentication/model settings, never desktop history, plugins or MCP config.
for (const file of ['credentials.json', 'provider_config.json', 'config.json']) {
  try { const target = join(home, 'v2', file); await copyFile(join(resolve(sourceHome), 'v2', file), target); await chmod(target, 0o600); }
  catch (error) { if (file === 'credentials.json' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const nodeId = randomUUID(), token = randomBytes(32).toString('hex');
const client = new DockClient({ nodeId, token, port: 0 });
await client.ready;
const config = join(directory, 'config.json');
await writeFile(config, JSON.stringify({ nodeId, token, endpoint: client.endpoint, provider: 'zcode',
  cwd: work, stateDir: join(directory, 'state'), zcodeHome: home, zcodeBin: resolve(binary) }), { mode: 0o600 });
const log = createWriteStream(join(directory, 'daemon.log'), { mode: 0o600 });
const child = spawn(process.execPath, [resolve('apps/daemon/dist/cli.js'), 'run', config], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const checks: string[] = [], snapshots: RunSnapshot[] = [];
let sessionId: string | undefined, failure: string | undefined;
async function run(prompt: string) {
  const input = { runId: randomUUID(), sessionId, prompt };
  const snapshot = await client.start(input); sessionId = snapshot.sessionId;
  assert.equal((await client.start(input)).runId, snapshot.runId);
  return snapshot.runId;
}
async function wait(runId: string, permission: 'allow' | 'deny' | 'cancel' = 'deny') {
  let approvals = 0;
  for (let n = 0; n < 600; n++) {
    const snapshot = await client.getRun(runId);
    if (terminal(snapshot.state)) { snapshots.push(snapshot); return { snapshot, approvals }; }
    for (const pending of snapshot.permissions) {
      approvals++;
      if (permission === 'cancel') {
        await client.cancel(runId);
        await assert.rejects(client.respondPermission({ runId, permissionId: pending.permissionId, decision: 'allow' }));
      } else await client.respondPermission({ runId, permissionId: pending.permissionId, decision: permission });
    }
    await delay(200);
  }
  await client.cancel(runId); throw new Error(`Timed out: ${runId}`);
}
try {
  await client.waitForConnection();
  assert.ok((await client.probe()).unsupported.includes('exact_final_answer'));
  checks.push('real bridge probe');
  const marker = randomUUID();
  const first = await wait(await run(`Remember this synthetic marker: ${marker}. Reply only with the marker. Do not use tools.`));
  assert.equal(first.snapshot.state, 'completed', first.snapshot.error);
  assert.ok(first.snapshot.output.includes(marker)); assert.equal(first.snapshot.finalAnswer, null);
  checks.push('real model text and honest final semantics');
  client.disconnect(); await delay(100); await client.waitForConnection();
  const second = await wait(await run('What synthetic marker did I ask you to remember? Reply only with it. Do not use tools.'));
  assert.equal(second.snapshot.state, 'completed', second.snapshot.error); assert.ok(second.snapshot.output.includes(marker));
  checks.push('same session resume after SDK reconnect; duplicate run identity');
  const allowed = await wait(await run('Use the shell tool to run: printf synthetic > allowed.txt. Do not substitute another tool. If permission is denied, stop and reply denied.'), 'allow');
  assert.equal(allowed.snapshot.state, 'completed', allowed.snapshot.error); assert.ok(allowed.snapshot.tools.length);
  assert.equal(await readFile(join(work, 'allowed.txt'), 'utf8'), 'synthetic');
  assert.ok(allowed.approvals > 0, 'No approval surfaced for the allow case'); checks.push('tool event and allow once');
  const denied = await wait(await run('Use the shell tool to run: printf synthetic > denied.txt. If permission is denied, do not retry or use other tools; reply denied.'), 'deny');
  assert.ok(denied.approvals > 0); await assert.rejects(stat(join(work, 'denied.txt')), { code: 'ENOENT' });
  assert.equal(denied.snapshot.state, 'completed', denied.snapshot.error); checks.push('deny once prevents file write');
  const late = await wait(await run('Use the shell tool to run: printf synthetic > late.txt. If cancelled or denied, stop.'), 'cancel');
  assert.ok(late.approvals > 0); await assert.rejects(stat(join(work, 'late.txt')), { code: 'ENOENT' });
  assert.ok(['completed', 'cancelled'].includes(late.snapshot.state)); checks.push('pending cancel invalidates late approval');
  sessionId = undefined;
  const runId = await run('Use the shell tool to run: sleep 60. Wait for it to finish. Do not use other tools.');
  let cancellationSent = false;
  for (let n = 0; n < 600; n++) {
    const snapshot = await client.getRun(runId);
    if (terminal(snapshot.state)) { snapshots.push(snapshot); assert.equal(snapshot.state, 'cancelled', snapshot.error); break; }
    for (const pending of snapshot.permissions) await client.respondPermission({ runId, permissionId: pending.permissionId, decision: 'allow' });
    if (!cancellationSent && snapshot.tools.some(tool => JSON.stringify(tool).includes('sleep 60')) && !snapshot.permissions.length) {
      await delay(1500); await client.cancel(runId); cancellationSent = true;
    }
    await delay(200);
  }
  assert.ok(cancellationSent); assert.equal(snapshots.at(-1)?.runId, runId); checks.push('in-flight upstream cancellation');
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  await client.close(); log.end();
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({ directory, binary, adapter: '0.68.2', checks, snapshots, failure }, null, 2), { mode: 0o600 });
  // Do not retain copied login material after acceptance.
  await rm(join(home, 'v2/credentials.json'), { force: true });
  await rm(join(home, 'v2/provider_config.json'), { force: true });
  await rm(join(home, 'v2/config.json'), { force: true });
  console.log(JSON.stringify({ directory, checks, failure }, null, 2));
}
