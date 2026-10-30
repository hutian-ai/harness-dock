import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { createAcpRuntime, createRuntimeStore, type AcpRuntimeOptions } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { AGENT_PROCESS_ENV_ALLOW } from './agent-environment.ts';
import type { NativePermissionDecision, NativePermissionRequest } from './execution.ts';
import { createMcpBridge, type McpBridge, type McpInvocation, type McpToolDefinition } from './mcp-bridge.ts';
import { AnswerBudget, MAX_EVIDENCE_BYTES, MAX_OBSERVATION_BYTES } from './output-limits.ts';

export interface DshHostEnvironment {
  cwd: string;
  dshHome: string;
  dshBin: string;
  stateDir: string;
  environment?: NodeJS.ProcessEnv;
  skillDirectory?: string;
}
export interface DshInspection {
  models: { id: string; efforts: string[] }[];
  currentModelId?: string;
  configOptions: unknown[];
  sessionResume: boolean;
  mcpCapabilities: { http: boolean };
}
export interface DshEvidence {
  runId: string;
  sessionId?: string;
  state: 'unknown' | 'completed' | 'failed' | 'cancelled';
  messages: { id: string; text: string }[];
  stopReason?: string;
  error?: string;
}
export interface DshHostInput<TDelivery = unknown> {
  environment: DshHostEnvironment;
  runId: string;
  prompt: string;
  model?: string;
  effort?: string;
  resumeThreadId?: string;
  previousRunId?: string;
  retainSession: boolean;
  signal: AbortSignal;
  tools: { name: string; definitions: McpToolDefinition[]; invocation: McpInvocation<TDelivery> };
  onReady(sessionId: string): Promise<void>;
  onEvent(event: Record<string, unknown>): Promise<void>;
  permission?(request: NativePermissionRequest, signal: AbortSignal, responseSent: Promise<void>): Promise<NativePermissionDecision>;
}
type RuntimeEnvironment = DshHostEnvironment & { patchPath?: string; mcpServers?: AcpRuntimeOptions['mcpServers'] };
type TurnState = { rpcId?: number | string; promptSent: boolean; terminal?: Pick<DshEvidence, 'state' | 'stopReason' | 'error'>; tools: Map<string, Record<string, unknown>> };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** The selected native installation owns configuration, credentials and policy. */
export function createDshRuntime(environment: RuntimeEnvironment, command?: string[], observers: Pick<AcpRuntimeOptions, 'onAcpMessage'> = {}) {
  const nativeCommand = ['.js', '.mjs', '.cjs'].includes(extname(environment.dshBin)) ? [process.execPath, environment.dshBin] : [environment.dshBin];
  return createAcpRuntime({
    cwd: environment.cwd,
    sessionStore: createRuntimeStore({ stateDir: environment.stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { dsh: command ?? [...nativeCommand, '--profile', 'acp', ...(environment.patchPath ? ['--patch', environment.patchPath] : [])] } }),
    agentProcessEnvAllow: AGENT_PROCESS_ENV_ALLOW,
    agentProcessEnv: { ...environment.environment, DSH_HOME: environment.dshHome },
    mcpServers: environment.mcpServers,
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false, timeoutMs: 30_000,
    ...observers,
  });
}

/** Add a separate named skill provider; never replace the user's existing roots. */
export async function prepareDshEnvironment(environment: DshHostEnvironment): Promise<RuntimeEnvironment> {
  for (const path of [environment.cwd, environment.dshHome, environment.dshBin, environment.stateDir])
    if (!isAbsolute(path)) throw new Error('dsh_paths_must_be_absolute');
  const rel = relative(environment.dshHome, environment.stateDir);
  if (!rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error('dsh_state_must_be_separate');
  if (!(await stat(environment.dshHome)).isDirectory()) throw new Error('dsh_home_unavailable');
  if (!(await stat(environment.cwd)).isDirectory()) throw new Error('dsh_workspace_unavailable');
  await access(environment.dshBin, 1);
  if (!environment.skillDirectory) return environment;
  if (!isAbsolute(environment.skillDirectory) || !(await stat(environment.skillDirectory)).isDirectory()) throw new Error('dsh_skill_root_unavailable');
  await mkdir(environment.stateDir, { recursive: true, mode: 0o700 });
  const patchPath = join(environment.stateDir, `caller-skills-${hash(environment.skillDirectory)}.json`);
  // JSON is YAML-compatible. insert keeps native configuration and its providers intact.
  const overlay = [{ insert: [{ id: 'harness-dock-caller-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: {
    providerName: 'harness-dock-caller', includeDefaultRoots: false, customSkillDirs: [environment.skillDirectory],
  } }] }];
  await writeFile(patchPath, JSON.stringify(overlay), { mode: 0o600 });
  return { ...environment, patchPath };
}

function choices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const row = object(item);
    return typeof row.value === 'string' ? [row.value] : choices(row.options);
  });
}
function inspection(configOptions: unknown, initialization: Record<string, unknown>): DshInspection {
  if (initialization.protocolVersion !== 1 || object(initialization.agentInfo).name !== 'deepseek-harness-acp') throw new Error('dsh_acp_initialization_invalid');
  if (!Array.isArray(configOptions) || Buffer.byteLength(JSON.stringify(configOptions), 'utf8') > MAX_OBSERVATION_BYTES) throw new Error('dsh_inspection_invalid');
  const options = configOptions.map(object);
  const model = options.find(option => option.id === 'model');
  if (!model || model.type !== 'select' || typeof model.currentValue !== 'string') throw new Error('dsh_inspection_invalid');
  const efforts = choices(options.find(option => option.id === 'reasoning_effort')?.options);
  const capabilities = object(initialization.agentCapabilities);
  const resume = object(capabilities.sessionCapabilities).resume;
  const models = choices(model.options);
  if (!models.includes(model.currentValue) || models.length > 256
    || models.some(id => !id.trim() || id.length > 500 || /[\u0000-\u001f]/u.test(id))) throw new Error('dsh_inspection_invalid');
  return { configOptions, currentModelId: model.currentValue,
    sessionResume: resume !== null && typeof resume === 'object' && !Array.isArray(resume),
    mcpCapabilities: { http: object(capabilities.mcpCapabilities).http === true },
    // Effort choices are exact-model dependent; only the selected route owns this list.
    models: [...new Set(models)].map(id => ({ id, efforts: id === model.currentValue ? efforts : [] })),
  };
}

/** One daemon-owned native session slot; transport lifetime does not grant turn authority. */
export class DshHost<TDelivery = unknown> {
  #running = false;
  #session?: { key: string; sessionKey: string; sessionId?: string; runtime: ReturnType<typeof createDshRuntime>; bridge: McpBridge<TDelivery> | null; lifetime: AbortController };
  #turn?: TurnState;
  constructor(private readonly runtimeFactory = createDshRuntime) {}
  async #release(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    session.lifetime.abort();
    try { await session.runtime.shutdown(); } finally { await session.bridge?.close(); }
  }
  async close(): Promise<void> {
    if (this.#running) throw new Error('dock_driver_busy');
    await this.#release();
  }
  async inspect(environment: DshHostEnvironment, signal: AbortSignal): Promise<DshInspection> {
    signal.throwIfAborted();
    const prepared = await prepareDshEnvironment(environment);
    let initializeId: unknown;
    let initialization: Record<string, unknown> = {};
    const runtime = this.runtimeFactory(prepared, undefined, { onAcpMessage(direction, value) {
      const message = object(value);
      if (direction === 'outbound' && message.method === 'initialize') initializeId = message.id;
      if (direction === 'inbound' && !('method' in message) && initializeId !== undefined && message.id === initializeId) initialization = object(message.result);
    } });
    const abort = () => { void runtime.shutdown().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const previous = await runtime.findSession({ sessionKey: 'capability-probe', agent: 'dsh' });
      if (previous) await runtime.prepareFreshSession({ handle: previous });
      const handle = await runtime.ensureSession({ sessionKey: 'capability-probe', agent: 'dsh', mode: 'persistent', cwd: environment.cwd });
      signal.throwIfAborted();
      const status = await runtime.getStatus({ handle, signal });
      const discovered = inspection(status.details?.configOptions, initialization);
      for (const model of discovered.models) {
        signal.throwIfAborted();
        if (model.id === discovered.currentModelId) continue;
        const selected = await runtime.setConfigOption({ handle, key: 'model', value: model.id, signal });
        const configured = inspection(selected.configOptions, initialization);
        model.efforts = configured.models.find(candidate => candidate.id === model.id)?.efforts ?? [];
      }
      if (discovered.models.length > 1) await runtime.setConfigOption({ handle, key: 'model', value: discovered.currentModelId!, signal });
      return discovered;
    } finally { signal.removeEventListener('abort', abort); await runtime.shutdown(); }
  }
  #observe(direction: string, value: unknown): void {
    const turn = this.#turn;
    if (!turn) return;
    const message = object(value);
    if (direction === 'outbound' && message.method === 'session/prompt' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      turn.rpcId = message.id; turn.promptSent = true;
    }
    if (direction === 'inbound' && !('method' in message) && turn.rpcId !== undefined && message.id === turn.rpcId) {
      if ('error' in message) turn.terminal = { state: 'failed', error: typeof object(message.error).message === 'string' ? String(object(message.error).message) : 'dsh_native_error' };
      else if (['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(object(message.result).stopReason))) {
        const stopReason = String(object(message.result).stopReason);
        turn.terminal = { state: stopReason === 'cancelled' ? 'cancelled' : 'completed', stopReason };
      }
    }
    if (direction !== 'inbound' || message.method !== 'session/update') return;
    const update = object(object(message.params).update);
    if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return;
    const id = update.toolCallId;
    if (update.status === 'completed' || update.status === 'failed') turn.tools.delete(id);
    else if (Buffer.byteLength(JSON.stringify(update), 'utf8') <= MAX_OBSERVATION_BYTES) {
      if (!turn.tools.has(id) && turn.tools.size >= 128) turn.tools.delete(turn.tools.keys().next().value!);
      turn.tools.set(id, { ...turn.tools.get(id), ...update });
    }
  }
  async execute(input: DshHostInput<TDelivery>): Promise<DshEvidence> {
    if (this.#running) throw new Error('dock_driver_busy');
    input.signal.throwIfAborted();
    this.#running = true;
    let retain = false, active = false;
    let evidence: DshEvidence | undefined;
    let ownedEvidence = false;
    const turn: TurnState = this.#turn = { promptSent: false, tools: new Map() };
    const outputAbort = new AbortController();
    const signal = AbortSignal.any([input.signal, input.tools.invocation.signal, outputAbort.signal]);
    const answer = new AnswerBudget();
    let target = '';
    const save = async () => {
      if (!evidence) return;
      const encoded = JSON.stringify(evidence);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('resource_exhausted:evidence_bytes');
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, target);
    };
    try {
      const environment = await prepareDshEnvironment(input.environment);
      await mkdir(join(environment.stateDir, 'runs'), { recursive: true, mode: 0o700 });
      target = join(environment.stateDir, 'runs', `${hash(input.runId)}.json`);
      evidence = { runId: input.runId, state: 'unknown', messages: [] };
      await writeFile(target, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
      ownedEvidence = true;
      const key = hash(JSON.stringify({ environment, definitions: input.tools.definitions, name: input.tools.name }));
      if (this.#session?.key !== key) {
        await this.#release();
        const lifetime = new AbortController();
        const bridge = input.tools.definitions.length ? await createMcpBridge<TDelivery>({ signal: lifetime.signal, name: input.tools.name, tools: input.tools.definitions }) : null;
        this.#session = { key, sessionKey: randomUUID(), bridge, lifetime,
          runtime: this.runtimeFactory({ ...environment, mcpServers: bridge ? [bridge.descriptor] : [] }, undefined, { onAcpMessage: (direction, value) => this.#observe(direction, value) }),
        };
      }
      const session = this.#session;
      if (session.sessionId && input.resumeThreadId !== session.sessionId) throw new Error('dsh_resume_identity_mismatch');
      session.bridge?.bind({ ...input.tools.invocation, signal, onToolCall: async call => {
        signal.throwIfAborted();
        if (!active) throw new Error('mcp_invocation_not_active');
        return input.tools.invocation.onToolCall(call);
      } });
      const handle = await session.runtime.ensureSession({ sessionKey: session.sessionKey, agent: 'dsh', mode: 'persistent', cwd: environment.cwd, resumeSessionId: input.resumeThreadId });
      signal.throwIfAborted();
      if (!handle.backendSessionId || input.resumeThreadId && handle.backendSessionId !== input.resumeThreadId) throw new Error('dsh_resume_identity_mismatch');
      evidence.sessionId = session.sessionId = handle.backendSessionId;
      await save();
      if (input.model !== undefined) await session.runtime.setConfigOption({ handle, key: 'model', value: input.model, signal });
      if (input.effort !== undefined) await session.runtime.setConfigOption({ handle, key: 'reasoning_effort', value: input.effort, signal });
      signal.throwIfAborted();
      await input.onReady(handle.backendSessionId);
      signal.throwIfAborted();
      active = true;
      const running = session.runtime.startTurn({ handle, requestId: input.runId, text: input.prompt, mode: 'prompt', rawSessionUpdates: true, timeoutMs: 0, signal,
        onPermissionRequest: async (request, context) => {
          if (!active || signal.aborted || context.signal.aborted) return { outcome: 'cancel' };
          const raw = request.raw;
          const details = { ...turn.tools.get(raw.toolCall.toolCallId), ...raw.toolCall };
          const decision = await input.permission?.({ id: randomUUID(), title: typeof details.title === 'string' ? details.title : 'DeepSeek Harness permission', details,
            canAllow: raw.options.some(option => option.kind === 'allow_once'), options: raw.options }, context.signal, context.responseSent);
          if (!active || signal.aborted || context.signal.aborted || !decision || typeof decision !== 'object' || !('optionId' in decision)
            || !raw.options.some(option => option.optionId === decision.optionId)) return { outcome: 'cancel' };
          return { outcome: 'selected', optionId: decision.optionId };
        },
      });
      void running.promptStarted.catch(() => {}); void running.result.catch(() => {});
      for await (const raw of running.events) {
        if (raw.type === 'session_update') {
          if (raw.sessionId !== evidence.sessionId) throw new Error('dsh_session_identity_mismatch');
          session.bridge?.acknowledgeToolUpdate(raw.update);
          if (raw.update.sessionUpdate === 'agent_message_chunk' && object(raw.update.content).type === 'text') {
            const text = object(raw.update.content).text;
            if (typeof text !== 'string') throw new Error('dsh_message_invalid');
            answer.add(text);
            const id = typeof raw.update.messageId === 'string' ? raw.update.messageId : `message-${evidence.messages.length}`;
            const existing = evidence.messages.find(message => message.id === id);
            if (existing) existing.text += text;
            else {
              if (evidence.messages.length >= 10_000) throw new Error('resource_exhausted:answer_messages');
              evidence.messages.push({ id, text });
            }
          }
          if (raw.event) await input.onEvent(raw.event);
        } else await input.onEvent(raw);
      }
      const result = await running.result;
      if (turn.terminal && result.status === turn.terminal.state) Object.assign(evidence, turn.terminal);
      else if (result.status === 'failed') evidence.error = result.error.message;
      retain = input.retainSession && evidence.state === 'completed' && !signal.aborted;
      await save();
      return evidence;
    } catch (error) {
      outputAbort.abort(error);
      if (!ownedEvidence || !evidence) throw error;
      // A terminal response cannot validate output that failed projection or delivery.
      evidence.state = turn.promptSent ? 'unknown' : 'failed';
      evidence.error ??= error instanceof Error ? error.message : String(error);
      await save();
      return evidence;
    } finally {
      active = false;
      this.#turn = undefined;
      try { await this.#session?.bridge?.unbind(); } finally {
        try { if (!retain) await this.#release(); } finally { this.#running = false; }
      }
    }
  }
}
