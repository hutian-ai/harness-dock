import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { createAcpRuntime, createRuntimeStore, type AcpRuntimeOptions } from 'acpx/runtime';
import { createAgentRegistry } from 'acpx/agent-registry';
import type { HarnessExecutionInput, HarnessExecutionResult, HarnessExecutor } from './execution.ts';
import { createMcpBridge, type McpBridge, type McpInvocation, type McpToolDefinition } from './mcp-bridge.ts';
import { AnswerBudget } from './output-limits.ts';
import { applyNativePermissionMode, nativePermissionModes } from './native-permission-modes.ts';

export interface ZCodeExecutionConfig {
  cwd: string;
  stateDir: string;
  zcodeHome: string;
  /** Explicit installed ZCode CLI executable or its bundled .cjs file. */
  zcodeBin: string;
  mcpServers?: AcpRuntimeOptions['mcpServers'];
}
export interface ZCodeExecutionInput<TDelivery = unknown> extends HarnessExecutionInput {
  model?: string;
  mode?: string;
  effort?: string;
  tools?: { name: string; definitions: McpToolDefinition[]; invocation: McpInvocation<TDelivery> };
}
export async function createZCodeRuntime(config: ZCodeExecutionConfig) {
  for (const path of [config.cwd, config.stateDir, config.zcodeHome, config.zcodeBin])
    if (!isAbsolute(path)) throw new Error('zcode_paths_must_be_absolute');
  if (!(await stat(config.zcodeBin)).isFile()) throw new Error('zcode_binary_unavailable');
  if (!(await stat(config.zcodeHome)).isDirectory()) throw new Error('zcode_home_unavailable');
  const xdg = join(config.stateDir, 'zcode-bridge-config');
  const directory = join(xdg, 'zcode-acp');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    session: { mode: 'build', showCompletionStatus: false },
    remote: { enabled: false }, quota: { autoResume: false },
    interaction: { timeoutMs: 0 },
  }), { mode: 0o600 });
  // Launch the stdio entry directly: no TUI, Bun re-exec, CLI updater or remote Hub.
  const entry = join(dirname(createRequire(import.meta.url).resolve('zcode-acp-server')), 'index.js');
  return createAcpRuntime({
    cwd: config.cwd, sessionStore: createRuntimeStore({ stateDir: config.stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { zcode: [process.execPath, entry] } }),
    agentProcessEnv: {
      ZCODE_BIN: config.zcodeBin, ZCODE_NODE: process.execPath, ZCODE_HOME: config.zcodeHome,
      XDG_CONFIG_HOME: xdg, ZCODE_ACP_RUNTIME: 'node', ZCODE_ACP_MODE: 'build',
      ZCODE_ACP_REMOTE: '0',
    },
    mcpServers: config.mcpServers,
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false,
  });
}

/** Persistent ACPX-owned ZCode process; no ZCode desktop/relay dependency. */
export class ZCodeExecutor<TDelivery = unknown> implements HarnessExecutor {
  readonly unsupported = ['exact_final_answer'];
  private runtime?: Awaited<ReturnType<typeof createZCodeRuntime>>;
  private sessionKey = randomUUID();
  private sessionId?: string;
  private executing = false;
  private bridge?: McpBridge<TDelivery>;
  private bridgeLifetime?: AbortController;
  private toolsKey?: string;
  constructor(private readonly config: ZCodeExecutionConfig, private readonly factory = createZCodeRuntime) {}
  get retainedSessionId(): string | undefined { return this.sessionId; }

  async inspect(signal: AbortSignal) {
    signal.throwIfAborted();
    const runtime = await this.factory(this.config);
    try {
      const handle = await runtime.ensureSession({ sessionKey: randomUUID(), agent: 'zcode', mode: 'persistent', cwd: this.config.cwd });
      const status = await runtime.getStatus({ handle, signal });
      const options = Array.isArray(status.details?.configOptions) ? status.details.configOptions as Record<string, unknown>[] : [];
      const thought = options.find(option => option.id === 'thought');
      const reasoningEfforts = Array.isArray(thought?.options) ? thought.options.flatMap((option: unknown) => {
        const value = option && typeof option === 'object' && 'value' in option ? option.value : undefined;
        return typeof value === 'string' ? [value] : [];
      }) : [];
      const models = status.models?.availableModelIds ?? [];
      const currentModel = status.models?.currentModelId;
      return { provider: 'zcode', adapter: 'zcode-acp-server@0.68.2', configuredPermissionMode: 'build',
        sandbox: null, readiness: 'acp_session_created', modelExecutionVerified: false,
        models, currentModel, ...nativePermissionModes(options), defaultPermissionMode: 'build', reasoningEffortsByModel: currentModel ? { [currentModel]: reasoningEfforts } : {},
        mcpTools: true, mcpExecutionVerified: false, exactFinalAnswer: false, status };
    } finally { await runtime.shutdown(); }
  }
  async close(): Promise<void> {
    if (this.executing) throw new Error('zcode_executor_busy');
    const runtime = this.runtime;
    this.runtime = undefined;
    this.sessionId = undefined;
    this.sessionKey = randomUUID();
    this.bridgeLifetime?.abort();
    try { await runtime?.shutdown(); }
    finally {
      await this.bridge?.close(); this.bridge = undefined; this.bridgeLifetime = undefined; this.toolsKey = undefined;
    }
  }
  async execute(input: ZCodeExecutionInput<TDelivery>): Promise<HarnessExecutionResult> {
    if (this.executing) throw new Error('zcode_executor_busy');
    if (input.resumeThreadId && input.resumeThreadId !== this.sessionId)
      return { state: 'failed', error: 'zcode_session_unavailable' };
    if (this.sessionId && input.resumeThreadId !== this.sessionId)
      return { state: 'failed', error: 'zcode_resume_identity_mismatch' };
    this.executing = true;
    let dispatched = false, completed = false, accepting = false;
    const outputAbort = new AbortController();
    const signal = AbortSignal.any([input.signal, outputAbort.signal, ...(input.tools ? [input.tools.invocation.signal] : [])]);
    const outputBudget = new AnswerBudget();
    try {
      signal.throwIfAborted();
      const toolsKey = JSON.stringify({ name: input.tools?.name, definitions: input.tools?.definitions ?? [] });
      if (this.toolsKey !== undefined && this.toolsKey !== toolsKey) throw new Error('zcode_session_tools_changed');
      this.toolsKey = toolsKey;
      if (!this.runtime) {
        if (input.tools?.definitions.length) {
          this.bridgeLifetime = new AbortController();
          this.bridge = await createMcpBridge<TDelivery>({ signal: this.bridgeLifetime.signal,
            name: input.tools.name, tools: input.tools.definitions });
        }
        this.runtime = await this.factory({ ...this.config, mcpServers: this.bridge ? [this.bridge.descriptor] : this.config.mcpServers });
      }
      if (this.bridge && input.tools) this.bridge.bind({ ...input.tools.invocation, signal,
        onToolCall: async call => {
          signal.throwIfAborted();
          if (!accepting) throw new Error('mcp_invocation_not_active');
          return input.tools!.invocation.onToolCall(call);
        },
      });
      const runtime = this.runtime;
      const handle = await runtime.ensureSession({ sessionKey: this.sessionKey, agent: 'zcode', mode: 'persistent', cwd: this.config.cwd });
      const sessionId = handle.backendSessionId;
      if (!sessionId || (input.resumeThreadId && input.resumeThreadId !== sessionId)) throw new Error('zcode_resume_identity_mismatch');
      await applyNativePermissionMode(runtime, handle, input.mode ?? 'build', signal, 'session-mode');
      if (input.model) await runtime.setConfigOption({ handle, key: 'model', value: input.model, signal });
      if (input.effort) await runtime.setConfigOption({ handle, key: 'thought', value: input.effort, signal });
      this.sessionId = sessionId;
      await input.onReady(sessionId);
      signal.throwIfAborted();
      accepting = true;
      dispatched = true;
      const turn = runtime.startTurn({ handle, requestId: input.runId, text: input.prompt, mode: 'prompt', signal,
        onPermissionRequest: async (request, context) => {
          const canAllow = request.raw.options.some(option => option.kind === 'allow_once');
          let decision: 'allow' | 'deny' = 'deny';
          try { const answer = await input.permission?.({ id: randomUUID(), title: request.raw.toolCall.title ?? 'ZCode permission', details: request.raw.toolCall, canAllow }, context.signal, context.responseSent); decision = answer === 'allow' ? 'allow' : 'deny'; }
          catch { /* Permission transport/callback failure cannot grant access. */ }
          return { outcome: decision === 'allow' && canAllow && !signal.aborted && !context.signal.aborted ? 'allow_once' : 'reject_once' };
        },
      });
      void turn.promptStarted.catch(() => {});
      void turn.result.catch(() => {});
      for await (const event of turn.events) {
        if (event.type === 'text_delta' && event.stream !== 'thought') {
          try { outputBudget.add(event.text); }
          catch (error) { outputAbort.abort(error); throw error; }
        }
        if (event.type === 'tool_call') this.bridge?.acknowledgeToolUpdate({ ...event, sessionUpdate: event.tag });
        // ZCode ACP does not supply authoritative final-message boundaries.
        if (event.type !== 'session_update') await input.onEvent(event);
      }
      const result = await turn.result;
      completed = result.status === 'completed' && result.stopReason === 'end_turn' && !signal.aborted;
      return result.status === 'failed'
        // ACPX includes transport/process failures in `failed`; no confirmed Provider terminal.
        ? { state: 'unknown', error: result.error.message }
        : { state: result.status === 'completed' && result.stopReason !== 'end_turn' ? 'failed' : result.status, stopReason: result.stopReason };
    } catch (error) {
      return { state: dispatched ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      accepting = false;
      try { await this.bridge?.unbind(); }
      finally { this.executing = false; if (!completed) await this.close(); }
    }
  }
}
