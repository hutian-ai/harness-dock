#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DockClient } from './index.ts';
import type { Observation } from '@harness-dock/protocol';
import { applyEvent, type RunSnapshot } from '@harness-dock/protocol';

process.umask(0o077);
const config = JSON.parse(await readFile(process.argv[2] ?? '.local/controller.json', 'utf8')) as {
  nodeId: string;
  host?: string;
  tls?: { keyFile: string; certFile: string; };
  token: string;
  endpoint: string;
};
const client = new DockClient({
  token: config.token, nodeId: config.nodeId, host: config.host,
  port: Number(new URL(config.endpoint).port) || 443,
  tls: config.tls ? {
    key: await readFile(config.tls.keyFile, 'utf8'),
    cert: await readFile(config.tls.certFile, 'utf8'),
  } : undefined,
});
await client.ready;
console.log(
  `Controller: ${client.endpoint}\nCommands: probe | run <prompt> | resume <prompt> | status [runId] | history | watch <runId> | allow <id> | deny <id> | cancel | disconnect | quit`,
);
let runId: string | undefined;
let sessionId: string | undefined;
let unsubscribe: (() => void) | undefined;
let observed: RunSnapshot | undefined;
function showResult(snapshot: RunSnapshot): void {
  console.log('\n执行状态:', snapshot.state);
  if (snapshot.finalAnswer)
    console.log('最终答案:', snapshot.finalAnswer.map((message) => message.text).join('\n\n'));
  else if (!['running', 'cancel_requested'].includes(snapshot.state))
    console.log('最终答案不可用（未获得完整、明确且成功结束的最终回复）');
}
function display(observation: Observation): void {
  if (observation.type === 'snapshot') {
    observed = observation.snapshot;
    console.log('\n本轮输出:', observed.output);
    if (observed.permissions.length) console.log('待审批:', observed.permissions);
    showResult(observed);
  } else if (observation.type === 'connection') console.log('\nConnected:', observation.connected);
  else {
    if (observed) applyEvent(observed, observation.event);
    if (observation.event.change.type === 'output') {
      const output = observation.event.change.output;
      if (output.type === 'text') process.stdout.write(output.text);
      else if (output.type === 'tool') console.log('\nTool:', output.text);
    } else if (observation.event.change.type === 'state' && observed) showResult(observed);
    else console.log('\n', observation.event.change);
  }
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
for await (const line of rl) {
  const [command, ...rest] = line.trim().split(' ');
  try {
    if (command === 'quit') break;
    if (command === 'probe') console.dir(await client.probe(), { depth: 6 });
    else if (command === 'history') console.table(await client.listRuns());
    else if (command === 'watch' && rest[0]) {
      const snapshot = await client.getRun(rest[0]);
      unsubscribe?.();
      runId = snapshot.runId;
      sessionId = snapshot.sessionId;
      unsubscribe = await client.subscribe(runId, display);
    }
    else if (command === 'run' || command === 'resume') {
      if (command === 'resume' && !sessionId) throw new Error('No selected session; use run or watch first');
      const input = {
        runId: randomUUID(),
        prompt: rest.join(' '),
        ...(command === 'resume' ? { sessionId } : {}),
      };
      // Print the identity before dispatch so an uncertain response can be queried.
      console.log('Run:', input.runId);
      runId = input.runId;
      const snapshot = await client.start(input);
      runId = snapshot.runId;
      sessionId = snapshot.sessionId;
      unsubscribe?.();
      unsubscribe = await client.subscribe(runId, display);
    } else if (command === 'status' && (rest[0] || runId)) console.dir(await client.getRun(rest[0] ?? runId!), { depth: 5 });
    else if ((command === 'allow' || command === 'deny') && runId && rest[0])
      await client.respondPermission({ runId, permissionId: rest[0], decision: command });
    else if (command === 'cancel' && runId) console.log(await client.cancel(runId));
    else if (command === 'disconnect') client.disconnect();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}
unsubscribe?.();
await client.close();
rl.close();
process.stdin.pause();
