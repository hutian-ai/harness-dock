import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { DeviceConnection } from '../apps/daemon/src/device-main.ts';
import { DockServer } from '../apps/server/src/index.ts';
import { ServerClient, type ServerPeer } from '../packages/client/src/index.ts';
import { createDshRuntime, DshHost } from '../packages/drivers/src/dsh.ts';
import { createProviderAdapters } from '../packages/drivers/src/provider-adapter.ts';
import type { DeviceExecutionCallback, DeviceExecuteInput, DeviceExecutionResponse, DeviceFile, DevicePreparedDirectories } from '../packages/protocol/src/index.ts';

const token = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (result: DeviceExecutionResponse) => ((result.result.messages ?? []) as { text: string }[]).map(message => message.text).join('\n');
const exists = async (path: string) => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function until(check: () => boolean | Promise<boolean>, label: string, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`dsh_acceptance_timeout:${label}`); await delay(50); }
}
interface Case {
  name: string;
  runId: string;
  sessionKey: string;
  trace: DeviceExecutionCallback[];
  prepared?: DevicePreparedDirectories;
  result?: DeviceExecutionResponse;
  input?: DeviceExecuteInput;
  target?: string;
  marker?: string;
  decision?: 'allow' | 'reject' | 'stale';
  permissionPending?: boolean;
  releaseDecision?: () => void;
  calls: number;
  reply?: string;
  passed?: boolean;
}
function toolRecords(test: Case): Record<string, unknown>[] {
  const records = new Map<string, Record<string, unknown>>();
  for (const callback of test.trace) if (callback.kind === 'event' && callback.payload.type === 'tool_call' && typeof callback.payload.toolCallId === 'string') {
    const event = callback.payload;
    const previous = records.get(String(event.toolCallId));
    records.set(String(event.toolCallId), { ...previous, ...event,
      ...(event.tag === 'tool_call_update' && previous?.title ? { title: previous.title } : {}),
    });
  }
  return [...records.values()];
}

/** Local maintainer fixture. Applications still exercise only the connection SDK.
 * The fixture narrows this native process to read-only so escalation can be tested
 * without editing native settings, granting persistent permission, or altering the installed daemon. */
export async function acceptDsh(): Promise<void> {
  process.umask(0o077);
  await mkdir(resolve('.local'), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve('.local/dsh-acceptance-'));
  const work = join(root, 'work'), stateDir = join(root, 'state');
  await mkdir(work); await mkdir(join(work, '.git'));
  const cases: Case[] = [];
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), provider: 'dsh', status: 'running',
    scope: 'SDK → Server → DeviceConnection/DeviceHost → ACPX → installed dsh',
    fixture: { nativeProcessPermissionMode: 'read-only', nativeSettingsEdited: false, installedDaemonChanged: false }, cases };
  const writeEvidence = () => writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const hashes: Record<string, string> = {};
  for (const path of ['packages/drivers/src/dsh.ts', 'packages/drivers/src/provider-adapter.ts', 'packages/drivers/src/tool-delivery.ts', 'apps/daemon/src/device-host.ts', 'apps/daemon/src/device-files.ts', 'scripts/accept-dsh.ts'])
    hashes[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
  evidence.sourceSha256 = hashes;
  const node = { nodeId: randomUUID(), token: randomBytes(32).toString('hex') };
  const app = { clientId: randomUUID(), token: randomBytes(32).toString('hex'), nodeIds: [node.nodeId] };
  const server = new DockServer({ nodes: [node], clients: [app], devicePort: 0, clientPort: 0 });
  await server.ready;
  const host = new DeviceHost({ mode: 'device', ...node, endpoint: server.deviceEndpoint, cwd: work, stateDir,
    providers: { codex: { disabled: true } },
  }, createProviderAdapters(undefined, () => new DshHost((environment, command, observers) => createDshRuntime({
    ...environment, environment: { ...environment.environment, DSH_PERMISSION_MODE: 'read-only' },
  }, command, observers))));
  const connection = new DeviceConnection(host, host.config);
  let client: ServerClient | undefined;
  let peer: ServerPeer | undefined;
  let model: string | undefined;
  const createCase = async (name: string, files: DeviceFile[] = []) => {
    const test: Case = { name, runId: randomUUID(), sessionKey: randomUUID(), trace: [], calls: 0 };
    cases.push(test); await writeEvidence();
    console.log(JSON.stringify({ phase: name, status: 'started' }));
    test.prepared = await peer!.request('prepare', { runId: test.runId, sessionKey: test.sessionKey, files });
    return test;
  };
  const execute = async (test: Case, prompt: string, tools?: DeviceExecuteInput['tools']) => {
    test.input = { provider: 'dsh', runId: test.runId, sessionKey: test.sessionKey, model, prompt, tools, retainSession: false };
    await writeEvidence(); // Record identity before the only dispatch; never retry an uncertain execute.
    test.result = await peer!.request('execute', test.input, 240_000);
    await writeEvidence();
    return test.result;
  };
  const finish = async (test: Case) => {
    test.passed = true; await writeEvidence();
    console.log(JSON.stringify({ phase: test.name, status: 'passed', nativeState: test.result?.result.state }));
    if (test.result?.result.state !== 'unknown') {
      await peer!.request('release', { runId: test.runId });
      await peer!.request('forgetSession', { sessionKey: test.sessionKey });
    }
  };
  try {
    connection.connect();
    client = new ServerClient({ endpoint: server.clientEndpoint, ...app });
    await client.ready;
    peer = client.node(node.nodeId)!;
    await until(() => peer!.connected, 'device_connection');
    const inventory = await peer.request('inventory', {}, 120_000);
    evidence.inventory = inventory;
    const provider = inventory.providers.find(value => value.key === 'dsh');
    assert.equal(provider?.status, 'ready', provider?.error);
    model = String(object(provider?.inspection).currentModelId ?? provider?.models[0]);
    assert(provider?.models.includes(model));
    evidence.model = model;
    peer.onExecutionCallback(async callback => {
      const test = cases.find(value => value.runId === callback.runId);
      assert(test, 'callback must belong to an admitted acceptance run');
      test.trace.push(callback); await writeEvidence();
      if (callback.kind === 'toolCall') {
        test.calls++;
        assert(['mcp-success', 'mcp-error'].includes(test.name));
        assert.equal(callback.payload.name, 'acceptance_token');
        assert.deepEqual(callback.payload.arguments, { nonce: test.marker });
        return { content: { response: test.reply }, isError: test.name === 'mcp-error', deliveryContext: { case: test.name } };
      }
      if (callback.kind !== 'permission') return null;
      assert(test.decision, `unexpected native permission during ${test.name}`);
      assert.equal(await exists(test.target!), false, 'no write before native decision');
      const raw = object(object(callback.payload.details).rawInput);
      assert.equal(raw.file_path, test.target);
      assert.equal(raw.content, test.marker);
      assert.equal(raw.sandbox_permissions, 'workspace-write');
      const once = callback.payload.options?.filter(option => option.kind === (test.decision === 'reject' ? 'reject_once' : 'allow_once'));
      assert.equal(once?.length, 1);
      if (test.decision === 'stale') {
        test.permissionPending = true;
        await new Promise<void>(resolve => { test.releaseDecision = resolve; });
      }
      return { optionId: once![0]!.optionId };
    });

    for (const name of ['mcp-success', 'mcp-error']) {
      const test = await createCase(name);
      test.marker = token('REQUEST'); test.reply = token(name === 'mcp-success' ? 'RESPONSE' : 'ERROR');
      const result = await execute(test,
        `Call mcp__dsh_acceptance__acceptance_token exactly once with nonce="${test.marker}". Then return only the response field from that tool result${name === 'mcp-error' ? ', even though the tool reports an error; do not retry' : ''}. Do not call any other tools.`,
        { name: 'dsh_acceptance', definitions: [{ name: 'acceptance_token', description: 'Return a synthetic acceptance token; no external side effects',
          inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] });
      assert.equal(result.result.state, 'completed'); assert.equal(test.calls, 1);
      assert.equal(text(result).trim(), test.reply);
      const tool = toolRecords(test).find(event => event.title === 'mcp__dsh_acceptance__acceptance_token');
      assert(tool, 'native MCP tool lifecycle must be observable through the SDK');
      assert.equal(tool.status, name === 'mcp-success' ? 'completed' : 'failed');
      assert(JSON.stringify(tool.content).includes(test.reply));
      assert(test.trace.some(callback => callback.kind === 'toolDelivery' && callback.payload.status === (name === 'mcp-success' ? 'delivered' : 'unknown')
        && object(callback.payload.context).case === name));
      await finish(test);
    }

    const label = token('SKILL_CATALOG');
    const callerName = `dock-caller-${randomBytes(5).toString('hex')}`, nativeName = `dock-native-${randomBytes(5).toString('hex')}`;
    const callerToken = token('CALLER_BODY'), nativeToken = token('NATIVE_BODY');
    const skill = (name: string, marker: string) => `---\nname: ${name}\ndescription: Synthetic acceptance skill for ${label}; activate only for this test.\n---\nBody token: ${marker}\nReturn the exact body token when asked. Do not use other tools.\n`;
    const nativeRoot = join(work, '.dsh', 'skills', nativeName);
    await mkdir(nativeRoot, { recursive: true }); await writeFile(join(nativeRoot, 'SKILL.md'), skill(nativeName, nativeToken));
    const skills = await createCase('skills-additive-catalog', [{ path: `${callerName}/SKILL.md`, contentBase64: Buffer.from(skill(callerName, callerToken)).toString('base64') }]);
    const skillsResult = await execute(skills, `Find both synthetic acceptance skills whose descriptions contain ${label} in your skill catalog. Load each using the native skill tool. Return only a JSON object mapping each skill name to its body token. Do not use filesystem, search, commands, or any other tools.`);
    assert.equal(skillsResult.result.state, 'completed');
    const skillTools = toolRecords(skills).filter(event => event.title === 'skill');
    for (const [name, marker, base] of [[callerName, callerToken, join(skills.prepared!.skillDirectory, callerName)], [nativeName, nativeToken, nativeRoot]] as const) {
      const loaded = skillTools.find(event => object(event.rawInput).name === name && event.status === 'completed');
      assert(loaded, `skill ${name} must be discovered and activated`);
      assert(JSON.stringify(loaded.content).includes(marker), 'skill body token must be observed in the native tool result');
      assert(JSON.stringify(loaded.content).includes(base), 'native tool result must identify the expected skill root');
      assert(text(skillsResult).includes(marker));
    }
    assert.equal(skillTools.length, 2);
    assert.equal(toolRecords(skills).length, 2, 'skill tokens must be obtained only through the native skill loader');
    await finish(skills);

    for (const decision of ['allow', 'reject', 'stale'] as const) {
      const test = await createCase(`approval-${decision}`);
      test.decision = decision; test.target = join(work, `${test.name}.txt`); test.marker = token('FILE');
      const secondTarget = join(work, 'approval-scope-must-remain-denied.txt');
      const prompt = `This is a bounded native approval acceptance test. Use only the native write tool to create "${test.target}" with exactly "${test.marker}". First attempt without sandbox_permissions. If and only if that exact write is denied by the native read-only sandbox, retry the exact same file_path and content once with sandbox_permissions="workspace-write" and a one-sentence justification. Wait for the native approval response. If rejected or cancelled, stop without using another tool or path. Do not modify anything else.${decision === 'allow' ? ` After a successful approved write, attempt one ordinary write to "${secondTarget}" with content "SCOPE_PROBE", without sandbox_permissions. It must remain read-only; do not escalate or retry that second file.` : ''}`;
      const pending = execute(test, prompt);
      void pending.catch(() => {});
      if (decision === 'stale') {
        await until(() => {
          if (test.result && !test.permissionPending) throw new Error('dsh_native_permission_not_triggered');
          return test.permissionPending === true;
        }, 'native_permission_pending', 180_000);
        const cancellation: { requested: boolean } = await peer.request('cancel', { runId: test.runId });
        assert.equal(cancellation.requested, true);
        test.releaseDecision!();
      }
      const result = await pending;
      assert(test.trace.some(callback => callback.kind === 'permission'), 'a real native permission request is required');
      const details = JSON.stringify(toolRecords(test));
      assert(/FS_SANDBOX_DENIED|file access denied under read-only mode/u.test(details), 'must observe native read-only denial before escalation');
      if (decision === 'allow') {
        assert.equal(result.result.state, 'completed');
        assert.equal(await readFile(test.target, 'utf8'), test.marker);
        assert.equal(await exists(secondTarget), false, 'one-shot approval must not upgrade the session');
        assert(toolRecords(test).some(event => object(event.rawInput).file_path === secondTarget && event.status === 'failed'
          && /file access denied under read-only mode/u.test(JSON.stringify(event.content))), 'a second ordinary write must actually remain denied');
        assert(test.trace.some(callback => callback.kind === 'permissionDelivered' && callback.payload.success));
        assert.equal(test.trace.filter(callback => callback.kind === 'permission').length, 1);
      } else {
        assert.equal(await exists(test.target), false);
        if (decision === 'reject') {
          assert.equal(result.result.state, 'completed');
          assert(details.includes('user rejected escalating'));
          assert(test.trace.some(callback => callback.kind === 'permissionDelivered' && callback.payload.success));
        } else {
          assert(['unknown', 'cancelled'].includes(result.result.state));
          assert(!test.trace.some(callback => callback.kind === 'permissionDelivered' && callback.payload.success));
          assert(test.trace.some(callback => callback.kind === 'permissionDelivered' && callback.payload.success === false));
          const before = test.trace.length;
          assert.deepEqual(await peer.request('execute', test.input!), result);
          assert.equal(test.trace.length, before, 'querying the admitted run must not replay a prompt or decision');
        }
      }
      await finish(test);
    }
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const test of cases) test.releaseDecision?.();
    await client?.close(); connection.stop();
    try { await host.close(); } finally { await server.close(); }
    evidence.finishedAt = new Date().toISOString();
    await writeEvidence();
    console.log(JSON.stringify({ status: evidence.status, evidence: relative(process.cwd(), join(root, 'evidence.json')) }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await acceptDsh();
