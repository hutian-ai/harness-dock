import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createAcpRuntime, createRuntimeStore, type AcpRuntimeOptions } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import { nativeElicitationForm, nativeElicitationResponse, type HarnessExecutionInput } from './execution.ts';
import { AnswerBudget, MAX_EVIDENCE_BYTES, readBoundedText } from './output-limits.ts';
import { applyNativePermissionMode, nativePermissionModes, type NativePermissionMode } from './native-permission-modes.ts';
import { decodeCodexEvents } from './codex-events.ts';
import type { CodexMessage, CodexTokens } from './codex-events.ts';

export type { CodexEvent, CodexTokens, CodexMessage } from './codex-events.ts';
export interface CodexExecutionConfig {
  cwd: string;
  codexHome: string;
  codexBin?: string;
  /** Resolved by the local Codex adapter, never a remote execution parameter. */
  nativeNode?: string;
  stateDir: string;
  /** Locally selected runtime dependencies; never received from a remote execution request. */
  environment?: NodeJS.ProcessEnv;
  /** Application-wide native host endpoint; never another chat identity. */
  desktopHost?: { pipePath: string; nodePath: string };
  skillDirectory?: string;
  mcpServers?: AcpRuntimeOptions['mcpServers'];
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
export interface CodexModel { id: string; efforts: string[]; serviceTiers: string[] }
export interface CodexInspection {
  desktopHostState?: 'connected' | 'disabled' | 'unavailable';
  nativeEnvironment?: { id: string; kind: 'native'; contextScope: 'device_user'; discovery: 'harness'; desktopHost: string };
  models: CodexModel[];
  permissionModes?: NativePermissionMode[];
  defaultPermissionMode?: string | null;
  /** Values reported by config/read; null means no explicit setting. */
  config: { sandbox: string | null; approvalPolicy: string | null; nativeMemoryDisabled: boolean };
}
export interface CodexEvidence {
  runId: string;
  fingerprint: string;
  threadId?: string;
  turnId?: string;
  state: 'unknown' | 'completed' | 'failed' | 'cancelled';
  messages: CodexMessage[];
  total?: CodexTokens;
  usage?: CodexTokens;
  error?: string;
  stopReason?: string;
}
export interface CodexExecutionInput extends HarnessExecutionInput {
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  onSteeringReady?(steer: ((text: string) => Promise<'accepted' | 'rejected' | 'unknown'>) | null): void;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Fixed adapter entry and denied delegated callbacks are shared by both embedding modes. */
export function createCodexRuntime(config: CodexExecutionConfig, command?: string[]) {
  return createAcpRuntime({
    cwd: config.cwd,
    sessionStore: createRuntimeStore({ stateDir: config.stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { codex: command ?? [config.desktopHost?.nodePath ?? config.nativeNode ?? process.execPath, createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp')] } }),
    agentProcessEnv: {
      ...config.environment,
      CODEX_HOME: config.codexHome, INITIAL_AGENT_MODE: config.sandbox ?? 'workspace-write',
      ...(config.codexBin ? { CODEX_PATH: config.codexBin } : {}),
      ...(config.skillDirectory ? { HARNESS_DOCK_SKILL_ROOT: config.skillDirectory } : {}),
      ...(config.desktopHost ? { CODEX_APP_TOOLS_PIPE_PATH: config.desktopHost.pipePath, CODEX_MCP_NODE_PATH: config.desktopHost.nodePath, HARNESS_DOCK_CODEX_DESKTOP_HOST: '1' } : {}),
      ...(!config.desktopHost && config.nativeNode ? { CODEX_MCP_NODE_PATH: config.nativeNode } : {}),
    },
    mcpServers: config.mcpServers,
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false, elicitationModes: ['form', 'url'],
  });
}

/** Embeds in an existing execution owner; no SDK listener or second daemon. */
export class CodexExecutor {
  private readonly config: CodexExecutionConfig;
  private readonly runtimeFactory: typeof createCodexRuntime;
  private runtime?: ReturnType<typeof createCodexRuntime>;
  private sessionKey = randomUUID();
  private threadId?: string;
  private executing = false;
  constructor(config: CodexExecutionConfig, runtimeFactory = createCodexRuntime) {
    this.config = config;
    this.runtimeFactory = runtimeFactory;
  }
  /** Call only after the active execution settles; cancellation belongs to its signal. */
  async close(): Promise<void> {
    if (this.executing) throw new Error('codex_executor_busy');
    const runtime = this.runtime;
    this.runtime = undefined;
    this.threadId = undefined;
    this.sessionKey = randomUUID();
    await runtime?.shutdown();
  }
  private path(runId: string) { return join(this.config.stateDir, 'runs', `${hash(runId)}.json`); }
  async evidence(runId: string): Promise<CodexEvidence | null> {
    try {
      const evidence = JSON.parse(await readBoundedText(this.path(runId), MAX_EVIDENCE_BYTES)) as CodexEvidence;
      if (evidence.runId !== runId || !Array.isArray(evidence.messages) || evidence.messages.length > 10_000) throw new Error('codex_evidence_invalid');
      const budget = new AnswerBudget();
      for (const message of evidence.messages) {
        if (typeof message.text !== 'string') throw new Error('codex_evidence_invalid');
        budget.add(message.text);
      }
      return evidence;
    }
    catch (error) { if (object(error).code === 'ENOENT') return null; throw error; }
  }
  private async save(value: CodexEvidence) {
    const target = this.path(value.runId), temporary = `${target}.${randomUUID()}.tmp`;
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('resource_exhausted:evidence_bytes');
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, target);
  }
  async inspect(signal: AbortSignal): Promise<CodexInspection> {
    const runtime = this.runtimeFactory(this.config);
    try {
      // Inventory never resumes an empty native thread: Codex may not persist it until the first turn.
      const previous = await runtime.findSession({ sessionKey: 'capability-probe', agent: 'codex' });
      if (previous) await runtime.prepareFreshSession({ handle: previous });
      const handle = await runtime.ensureSession({ sessionKey: 'capability-probe', agent: 'codex', mode: 'persistent', cwd: this.config.cwd });
      const command = { operation: 'inspect' as const, hostStatus: !!this.config.desktopHost };
      const result = object(await runtime.dockControl({ handle, command, signal }));
      const desktopHostState = this.config.desktopHost ? this.desktopState(result) : undefined;
      const config = object(result.config);
      if (!Array.isArray(result.models) || (config.sandbox !== null && typeof config.sandbox !== 'string') || (config.approvalPolicy !== null && typeof config.approvalPolicy !== 'string')) throw new Error('codex_inspection_invalid');
      const models = result.models.map(object).filter(model => model.hidden !== true).map(model => ({
        id: String(model.id),
        efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(value => String(object(value).reasoningEffort)) : [],
        serviceTiers: Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.includes('fast') ? ['priority'] : [],
      }));
      const status = await runtime.getStatus({ handle, signal });
      return { models, desktopHostState, ...nativePermissionModes(status.details?.configOptions), config: { sandbox: config.sandbox, approvalPolicy: config.approvalPolicy, nativeMemoryDisabled: config.nativeMemoryDisabled === true } };
    } finally { await runtime.shutdown(); }
  }
  private desktopState(result: Record<string, unknown>): 'connected' | 'disabled' | 'unavailable' {
    const state = object(result.nativeHost).status;
    return state === 'connected' || state === 'disabled' ? state : 'unavailable';
  }
  /** Reads the exact recorded native turn; never loads a session or sends a prompt. */
  async reconcile(runId: string, signal: AbortSignal): Promise<CodexEvidence | null> {
    const evidence = await this.evidence(runId);
    if (!evidence?.threadId || !evidence.turnId) return null;
    const runtime = this.runtimeFactory(this.config);
    try {
      const result = object(await runtime.dockControl({ signal, command: { operation: 'read_turn', threadId: evidence.threadId, turnId: evidence.turnId } }));
      const turn = object(result.turn);
      if (result.threadId !== evidence.threadId || turn.id !== evidence.turnId || !Array.isArray(turn.messages)) return null;
      if (!['completed', 'failed', 'interrupted'].includes(String(turn.status))) return null;
      const messages = turn.messages.map(object);
      if (messages.length > 10_000 || messages.some(message => typeof message.id !== 'string' || typeof message.text !== 'string')) return null;
      const budget = new AnswerBudget();
      for (const message of messages) budget.add(String(message.text));
      evidence.messages = messages.map(message => ({ id: String(message.id), text: String(message.text), phase: message.phase === 'final_answer' || message.phase === 'commentary' ? message.phase : null }));
      evidence.state = turn.status === 'interrupted' ? 'cancelled' : turn.status as 'completed' | 'failed';
      await this.save(evidence);
      return evidence;
    } finally { await runtime.shutdown(); }
  }
  async execute(input: CodexExecutionInput): Promise<CodexEvidence> {
    input.signal.throwIfAborted();
    if (this.executing) throw new Error('codex_executor_busy');
    if (this.threadId && input.resumeThreadId !== this.threadId) throw new Error('codex_resume_identity_mismatch');
    this.executing = true;
    let completed = false;
    const outputAbort = new AbortController();
    const signal = AbortSignal.any([input.signal, outputAbort.signal]);
    const streamed = new AnswerBudget(), final = new AnswerBudget();
    try {
      await mkdir(join(this.config.stateDir, 'runs'), { recursive: true, mode: 0o700 });
      const evidence: CodexEvidence = { runId: input.runId, fingerprint: hash(JSON.stringify({ prompt: input.prompt, model: input.model, effort: input.effort, serviceTier: input.serviceTier, resume: input.resumeThreadId, cwd: this.config.cwd, home: this.config.codexHome })), state: 'unknown', messages: [] };
      // Exclusive creation also protects against a second owner or a caller retry after restart.
      await writeFile(this.path(input.runId), JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
      const runtime = this.runtime ??= this.runtimeFactory(this.config);
      let active = false;
      const baseline = input.resumeThreadId && input.previousRunId ? await this.evidence(input.previousRunId) : null;
      try {
        const handle = await runtime.ensureSession({ sessionKey: this.sessionKey, agent: 'codex', mode: 'persistent', cwd: this.config.cwd, resumeSessionId: input.resumeThreadId });
        const threadId = handle.backendSessionId;
        if (!threadId || (input.resumeThreadId && input.resumeThreadId !== threadId)) throw new Error('codex_resume_identity_mismatch');
        this.threadId = threadId;
        evidence.threadId = threadId;
        await this.save(evidence);
        await applyNativePermissionMode(runtime, handle, input.mode ?? this.config.sandbox ?? 'workspace-write', signal);
        if (input.model) await runtime.setModel({ handle, model: input.model, signal });
        if (input.effort) await runtime.setConfigOption({ handle, key: 'reasoning_effort', value: input.effort, signal });
        await runtime.setConfigOption({ handle, key: 'fast-mode', value: input.serviceTier === 'priority' ? 'on' : 'off', signal });
        await input.onReady(threadId);
        input.signal.throwIfAborted();
        active = true;
        const turn = runtime.startTurn({ handle, requestId: input.runId, text: input.prompt, mode: 'prompt', signal, rawSessionUpdates: true,
          onPermissionRequest: async (request, context) => {
            const canAllow = request.raw.options.some(option => option.kind === 'allow_once');
            const decision = await input.permission?.({ id: randomUUID(), title: request.raw.toolCall.title ?? 'Codex permission', details: request.raw.toolCall, canAllow, options: request.raw.options }, context.signal, context.responseSent);
            if (!active || context.signal.aborted || !decision || typeof decision !== 'object' || !('optionId' in decision)
              || !request.raw.options.some(option => option.optionId === decision.optionId)) return { outcome: 'cancel' };
            return { outcome: 'selected', optionId: decision.optionId };
          },
          onElicitation: async (request, context) => {
            const form = nativeElicitationForm(request);
            if (!form) return { action: 'cancel' };
            const decision = await input.permission?.({ id: randomUUID(), title: request.message.slice(0, 200), details: {}, canAllow: true, form }, context.signal, context.responseSent);
            return nativeElicitationResponse(!active || signal.aborted || context.signal.aborted ? undefined : decision);
          },
        });
        void turn.promptStarted.catch(() => {});
        void turn.result.catch(() => {});
        const steer = async (text: string): Promise<'accepted' | 'rejected' | 'unknown'> => {
          if (!active || !evidence.turnId || input.signal.aborted) return 'rejected';
          try {
            const result = object(await runtime.dockControl({ handle, requestId: input.runId, signal: input.signal, command: { operation: 'steer', threadId, turnId: evidence.turnId, text } }));
            return result.accepted === true && result.turnId === evidence.turnId ? 'accepted' : 'rejected';
          } catch { return 'unknown'; }
        };
        for await (const event of decodeCodexEvents(turn.events)) {
          try {
            if (event.type === 'text_delta' && event.stream !== 'thought') streamed.add(event.text);
            if (event.type === 'message_completed' && !evidence.messages.some(message => message.id === event.messageId)) {
              if (evidence.messages.length >= 10_000) throw new Error('resource_exhausted:answer_messages');
              final.add(event.text);
            }
          } catch (error) {
            // Cancel the turn before releasing the process. No Provider terminal was observed.
            outputAbort.abort(error);
            evidence.error = error instanceof Error ? error.message : String(error);
            await this.save(evidence);
            throw error;
          }
          if (event.type === 'codex_event') {
            if (event.threadId !== threadId || (evidence.turnId && evidence.turnId !== event.turnId)) throw new Error('codex_turn_identity_mismatch');
            evidence.turnId = event.turnId;
            if (event.kind === 'usage') evidence.total = event.total;
            await this.save(evidence);
            if (event.kind === 'turn_started') input.onSteeringReady?.(steer);
          } else if (event.type === 'message_completed') {
            if (!evidence.turnId || event.providerTurnId !== evidence.turnId) throw new Error('codex_message_identity_mismatch');
            if (!evidence.messages.some(message => message.id === event.messageId)) evidence.messages.push({ id: event.messageId, phase: event.phase, text: event.text });
          }
          await input.onEvent(event);
        }
        const result = await turn.result;
        evidence.state = result.status;
        if (result.status === 'failed') evidence.error = result.error.message;
        else evidence.stopReason = result.stopReason;
        if (evidence.total && (!input.resumeThreadId || baseline?.threadId === threadId && baseline.total)) {
          const usage = { ...evidence.total };
          for (const key of Object.keys(usage) as (keyof CodexTokens)[]) usage[key] -= baseline?.total?.[key] ?? 0;
          if (Object.values(usage).every(value => value >= 0)) evidence.usage = usage;
        }
        await this.save(evidence);
        completed = result.status === 'completed' && !input.signal.aborted;
        return evidence;
      } finally {
        active = false;
        input.onSteeringReady?.(null);
      }
    } finally {
      this.executing = false;
      if (!completed) await this.close();
    }
  }
}
