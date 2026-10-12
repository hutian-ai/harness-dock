import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ContainerConfig } from '../packages/drivers/src/index.ts';
import { DockClient } from '../packages/client/src/index.ts';
import {
  terminal,
  type RunSnapshot,
  type CompletedMessage,
  type Observation,
} from '../packages/protocol/src/index.ts';

const directory = resolve('.local/experiments', new Date().toISOString().replaceAll(':', '-'));
for (const name of ['work', 'outside', 'codex-home', 'state'])
  await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
await copyFile(resolve('.local/codex-home/auth.json'), join(directory, 'codex-home/auth.json'));
await copyFile(resolve('scripts/codex-config.toml'), join(directory, 'codex-home/config.toml'));
const containerIndex = process.argv.indexOf('--container');
const container = containerIndex >= 0
  ? JSON.parse(await readFile(process.argv[containerIndex + 1]!, 'utf8')) as ContainerConfig
  : undefined;
const token = randomBytes(32).toString('hex');
const nodeId = randomUUID();
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const client = new DockClient({
  token, nodeId, port: 0, tls: {
    key: await readFile(join(directory, 'key.pem'), 'utf8'),
    cert: await readFile(join(directory, 'cert.pem'), 'utf8'),
  }
});
await client.ready;
const configPath = join(directory, 'config.json');
await writeFile(
  configPath,
  JSON.stringify({
    token,
    nodeId,
    container,
    endpoint: client.endpoint,
    caFile: join(directory, 'cert.pem'),
    cwd: join(directory, 'work'),
    codexHome: join(directory, 'codex-home'),
    stateDir: join(directory, 'state'),
    mcpServers: [
      {
        name: 'dock_demo',
        command: container ? 'node' : process.execPath,
        args: [container ? '/opt/harness-dock/demo-mcp.mjs' : resolve('scripts/demo-mcp.mjs')],
        env: [],
      },
    ],
  }),
  { mode: 0o600 },
);
const logs = createWriteStream(join(directory, 'daemon.log'), { mode: 0o600 });
const checks: { name: string; evidence: unknown; }[] = [];
const snapshots: RunSnapshot[] = [];
let sessionId: string | undefined;
let child: ChildProcess;
const processes: ChildProcess[] = [];
function launch(): ChildProcess {
  const process = spawn(
    globalThis.process.execPath,
    [resolve('apps/daemon/dist/cli.js'), 'run', configPath],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  process.stdout!.pipe(logs, { end: false });
  process.stderr!.pipe(logs, { end: false });
  processes.push(process);
  return process;
}
async function record(name: string, evidence: unknown): Promise<void> {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify({ directory, checks, snapshots }, null, 2),
    { mode: 0o600 },
  );
}
async function wait(
  runId: string,
  predicate: (snapshot: RunSnapshot) => boolean,
  timeoutMs = 150_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await client.getRun(runId);
    if (predicate(snapshot)) return snapshot;
    if (terminal(snapshot.state))
      throw new Error(
        `Unexpected terminal ${snapshot.state}: ${snapshot.error ?? snapshot.output.slice(-1000)}`,
      );
    await delay(200);
  }
  throw new Error(`Timed out: ${runId}`);
}
async function start(prompt: string): Promise<RunSnapshot> {
  const snapshot = await client.start({ runId: randomUUID(), sessionId, prompt });
  sessionId = snapshot.sessionId;
  return snapshot;
}
async function completed(runId: string): Promise<RunSnapshot> {
  const snapshot = await wait(runId, (s) => terminal(s.state));
  snapshots.push(snapshot);
  assert.equal(snapshot.state, 'completed', snapshot.error);
  assert.ok(
    snapshot.finalAnswer?.length,
    'Success requires an explicitly classified, complete final answer in this experiment',
  );
  await verifyNativeFinal(snapshot.finalAnswer);
  return snapshot;
}
async function verifyNativeFinal(messages: CompletedMessage[]): Promise<void> {
  // Independent acceptance oracle only. The runtime never reads native history.
  const root = join(directory, 'codex-home/sessions');
  for (let attempt = 0; attempt < 30; attempt++) {
    const native: CompletedMessage[] = [];
    for (const file of (await readdir(root, { recursive: true })).filter((file) =>
      file.endsWith('.jsonl'),
    )) {
      for (const line of (await readFile(join(root, file), 'utf8')).trim().split('\n')) {
        const entry = JSON.parse(line);
        const message = entry.payload;
        const turnId = message?.internal_chat_message_metadata_passthrough?.turn_id;
        if (
          entry.type === 'response_item' &&
          message.type === 'message' &&
          message.role === 'assistant' &&
          message.phase === 'final_answer' &&
          messages.some((item) => item.providerTurnId === turnId)
        ) {
          native.push({
            messageId: message.id,
            providerTurnId: turnId,
            phase: message.phase,
            text: message.content
              .filter((part: { type: string; }) => part.type === 'output_text')
              .map((part: { text: string; }) => part.text)
              .join(''),
          });
        }
      }
    }
    if (native.length) {
      assert.deepEqual(messages, native);
      return;
    }
    await delay(100);
  }
  throw new Error('No native final message found for comparison');
}
function outsidePath(name: string): string {
  return join(directory, container ? 'codex-home' : 'outside', name);
}
function writePrompt(path: string, marker: string): string {
  if (container) path = path.replace(join(directory, 'codex-home'), '/dock-home');
  return `This is an authorized synthetic permission test. Use the shell execution tool with sandbox_permissions=require_escalated to write exactly ${JSON.stringify(marker)} to ${JSON.stringify(path)}. This file is outside the workspace on purpose. Request user approval for that one command. Do not use apply_patch, do not create other files, and do not work around a denial. If denied, report denied and stop. Only that synthetic file may be modified.`;
}
try {
  child = launch();
  await client.waitForConnection();
  await record('node probe', await client.probe());
  const marker = `dock-${randomUUID()}`;
  const firstInput = {
    runId: randomUUID(),
    prompt: `Synthetic local test. Remember the marker ${marker} for this conversation. Before using tools, send a short progress message containing PROGRESS:${marker}. Call the dock_demo MCP tool demo_echo with this marker. Then use the shell tool to append this marker plus a newline exactly once to ./marker.txt in the workspace. After tools finish, your final answer must be only FINAL:${marker}. Do not access other files or the network.`,
  };
  const first = await client.start(firstInput);
  sessionId = first.sessionId;
  const observations: Observation[] = [];
  const unsubscribe = await client.subscribe(first.runId, (observation) =>
    observations.push(observation),
  );
  assert.equal((await client.start(firstInput)).runId, first.runId);
  const done = await completed(first.runId);
  assert.match(JSON.stringify(done.tools), /DOCK_MCP:/);
  assert.ok(done.output.length > 0);
  assert.ok(
    done.messages.some(
      (message) => message.phase === 'commentary' && message.text.includes('PROGRESS:'),
    ),
  );
  assert.equal(done.finalAnswer?.[0]?.text, `FINAL:${marker}`);
  assert.ok(!done.finalAnswer?.some((message) => message.text.includes('PROGRESS:')));
  client.disconnect();
  while (client.connected) await delay(10);
  await client.waitForConnection();
  assert.deepEqual((await client.getRun(first.runId)).finalAnswer, done.finalAnswer);
  assert.ok(
    observations.some(
      (observation) =>
        observation.type === 'snapshot' &&
        observation.snapshot.finalAnswer?.[0]?.text === `FINAL:${marker}`,
    ),
  );
  unsubscribe();
  assert.equal((await readFile(join(directory, 'work/marker.txt'), 'utf8')).trim(), marker);
  if (container) {
    const executable = container.executable ?? container.engine;
    const name = `harness-dock-${nodeId}`;
    const outside = join(directory, 'outside/unmounted.txt');
    await writeFile(outside, 'SYNTHETIC_HOST_ONLY');
    const boundary = execFileSync(executable, ['exec', name, 'sh', '-c', 'test ! -e "$1" && test ! -e /var/run/docker.sock && test ! -e /run/podman/podman.sock && ! touch /root-write-test && ! touch "$1" && printf ISOLATED', 'check', outside], { encoding: 'utf8' });
    assert.match(boundary, /ISOLATED/);
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_HOST_ONLY');
    const metadata = JSON.parse(execFileSync(executable, ['inspect', name], { encoding: 'utf8' }))[0];
    assert.equal(metadata.HostConfig.ReadonlyRootfs, true);
    const mounts = metadata.Mounts.filter((m: { Type: string ;}) => m.Type === 'bind');
    assert.equal(mounts.length, 2);
    await record('container immutable image, restricted mounts and readonly root', {
      image: metadata.Image, mounts: mounts.map((m: { Source: string; Destination: string ;}) => ({ source: m.Source, target: m.Destination })),
      boundary: boundary.trim(), engine: container.engine,
    });
  }
  await record('Codex text, tools, MCP and duplicate identity', {
    runId: first.runId,
    eventCount: observations.length,
    toolCount: done.tools.length,
  });
  await record('exact native final answer, distinct commentary and reconnect snapshot', {
    runId: done.runId,
    finalAnswer: done.finalAnswer,
    completedMessageCount: done.messages.length,
  });
  const second = await start(
    'What exact marker did I ask you to remember in the immediately preceding turn? Answer only the marker, without using tools.',
  );
  const secondDone = await completed(second.runId);
  assert.ok(secondDone.output.includes(marker));
  assert.ok(
    secondDone.finalAnswer?.every(
      (message) =>
        !done.finalAnswer?.some(
          (previous) =>
            previous.messageId === message.messageId ||
            previous.providerTurnId === message.providerTurnId,
        ),
    ),
  );
  await record('two turns use original session', {
    sessionId,
    firstRunId: first.runId,
    secondRunId: second.runId,
  });
  await record('model and config discovery', await client.probe());

  const allowPath = outsidePath('allow.txt');
  const allow = await start(writePrompt(allowPath, 'ALLOW_ONCE'));
  const pending = await wait(allow.runId, (s) => s.permissions.length > 0);
  const permissionId = pending.permissions[0]!.permissionId;
  const reconnectEvents: unknown[] = [];
  const stopWatch = await client.subscribe(allow.runId, (observation) =>
    reconnectEvents.push(observation),
  );
  client.disconnect();
  while (client.connected) await delay(10);
  await client.waitForConnection();
  const recovered = await client.getRun(allow.runId);
  assert.equal(recovered.permissions[0]?.permissionId, permissionId);
  await client.respondPermission({ runId: allow.runId, permissionId, decision: 'allow' });
  await completed(allow.runId);
  stopWatch();
  assert.equal((await readFile(allowPath, 'utf8')).trim(), 'ALLOW_ONCE');
  await assert.rejects(
    client.respondPermission({ runId: allow.runId, permissionId, decision: 'allow' }),
    /permission_expired/,
  );
  await record('allow once, reconnect pending permission, reject repeated decision', {
    runId: allow.runId,
    permissionId,
    observationCount: reconnectEvents.length,
  });

  const denyPath = outsidePath('deny.txt');
  const deny = await start(writePrompt(denyPath, 'MUST_NOT_EXIST'));
  const deniedPermission = (await wait(deny.runId, (s) => s.permissions.length > 0))
    .permissions[0]!;
  await client.respondPermission({
    runId: deny.runId,
    permissionId: deniedPermission.permissionId,
    decision: 'deny',
  });
  const denied = await wait(deny.runId, (s) => terminal(s.state));
  snapshots.push(denied);
  assert.ok(denied.state === 'completed' || denied.state === 'cancelled');
  if (denied.state === 'cancelled') assert.equal(denied.finalAnswer, null);
  await assert.rejects(readFile(denyPath), { code: 'ENOENT' });
  await record('deny once prevents the synthetic write', {
    runId: deny.runId,
    resultState: denied.state,
  });

  const long = await start(
    'Use the shell tool to run exactly `sleep 30` with yield_time_ms=1000. This is an intentional cancellation test. Do not create files.',
  );
  await wait(long.runId, (s) => s.tools.some((tool) => JSON.stringify(tool).includes('sleep 30')));
  await delay(300);
  const cancelAck = await client.cancel(long.runId);
  const cancelled = await wait(long.runId, (s) => terminal(s.state));
  snapshots.push(cancelled);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.finalAnswer, null);
  await record('in-flight cancellation confirmed by upstream', {
    requestState: cancelAck.state,
    resultState: cancelled.state,
    runId: long.runId,
  });

  const latePath = outsidePath('late.txt');
  const late = await start(writePrompt(latePath, 'MUST_NOT_EXIST'));
  const latePermission = (await wait(late.runId, (s) => s.permissions.length > 0)).permissions[0]!;
  await client.cancel(late.runId);
  await assert.rejects(
    client.respondPermission({
      runId: late.runId,
      permissionId: latePermission.permissionId,
      decision: 'allow',
    }),
    /permission_expired/,
  );
  const lateDone = await wait(late.runId, (s) => terminal(s.state));
  snapshots.push(lateDone);
  if (lateDone.state !== 'completed') assert.equal(lateDone.finalAnswer, null);
  await assert.rejects(readFile(latePath), { code: 'ENOENT' });
  await record('late approval invalidated on cancel', {
    runId: late.runId,
    resultState: lateDone.state,
  });

  const newSession = await client.start({ runId: randomUUID(), prompt: 'Reply exactly NEW_SESSION. Do not use tools.' });
  assert.notEqual(newSession.sessionId, sessionId);
  await completed(newSession.runId);
  sessionId = newSession.sessionId;
  await record('explicit new session closes original harness', { sessionId });

  const unknown = await start(
    writePrompt(outsidePath('unknown.txt'), 'MUST_NOT_EXIST'),
  );
  await wait(unknown.runId, (s) => s.permissions.length > 0);
  child.kill('SIGKILL');
  while (client.connected) await delay(10);
  const unknownResult = await client.getRun(unknown.runId);
  assert.equal(unknownResult.state, 'outcome_unknown');
  assert.equal(unknownResult.finalAnswer, null);
  // Cleanup only the experiment's process group after simulating daemon death.
  try {
    globalThis.process.kill(-child.pid!, 'SIGKILL');
  } catch {
    /* group already exited */
  }
  child = launch();
  await client.waitForConnection();
  assert.equal((await client.getRun(unknown.runId)).state, 'outcome_unknown');
  assert.deepEqual((await client.getRun(first.runId)).finalAnswer, done.finalAnswer);
  assert.ok((await client.listRuns()).some((run) => run.runId === first.runId));
  const replacement = await client.probe();
  assert.equal(replacement.activeRunId, undefined);
  await assert.rejects(readFile(outsidePath('unknown.txt')), { code: 'ENOENT' });
  await record('daemon death and replacement preserve unknown without replay', {
    runId: unknown.runId,
    replacementDaemonId: replacement.daemonId,
  });

  const stopPath = outsidePath('stop.txt');
  const stopping = await client.start({ runId: randomUUID(), prompt: writePrompt(stopPath, 'MUST_NOT_EXIST') });
  const stopPermission = (await wait(stopping.runId, s => s.permissions.length > 0)).permissions[0]!;
  const processTree = () => execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const beforeStop = processTree(), owned = new Set([child.pid!]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of beforeStop) if (owned.has(ppid!) && !owned.has(pid!)) {
      owned.add(pid!); grew = true;
    }
  }
  const stopResult = JSON.parse((await promisify(execFile)(process.execPath,
    [resolve('apps/daemon/dist/cli.js'), 'stop', configPath], { timeout: 35_000 })).stdout);
  assert.equal(stopResult.stopped, true);
  for (let i = 0; i < 30 && processTree().some(([pid]) => owned.has(pid!)); i++) await delay(100);
  assert.ok(!processTree().some(([pid]) => owned.has(pid!)), 'Normal stop must reap the owned daemon and harness processes');
  child = launch();
  await client.waitForConnection();
  const stoppedRun = await client.getRun(stopping.runId);
  assert.ok(terminal(stoppedRun.state));
  assert.deepEqual(stoppedRun.permissions, []);
  await assert.rejects(client.respondPermission({ runId: stopping.runId,
    permissionId: stopPermission.permissionId, decision: 'allow' }), /outcome_unknown/);
  await assert.rejects(readFile(stopPath), { code: 'ENOENT' });
  await record('local CLI stop expires pending permission and reaps owned processes', {
    runId: stopping.runId, state: stoppedRun.state, ownedProcessCount: owned.size, stopped: stopResult.stopped,
  });
  console.log(`Evidence: ${join(directory, 'evidence.json')}`);
} catch (error) {
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify({ directory, checks, snapshots }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(directory, 'failure.txt'), String(error), { mode: 0o600 });
  console.error(`Acceptance stopped: ${String(error)}\nEvidence: ${directory}`);
  process.exitCode = 1;
} finally {
  for (const process of processes) {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM');
  }
  await delay(1000);
  for (const process of processes) {
    try {
      globalThis.process.kill(-process.pid!, 'SIGKILL');
    } catch {
      /* group exited */
    }
  }
  await client.close();
  logs.end();
}
