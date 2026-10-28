import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { CodexExecutor, type CodexEvidence, type CodexInspection, type CodexExecutionConfig, type CodexExecutionInput } from './codex.ts';
import { resolveCodexEnvironment } from './codex-environment.ts';
import { createMcpBridge, type McpInvocation, type McpToolDefinition } from './mcp-bridge.ts';
import { observeStartup } from './startup-trace.ts';

/** Frozen provider environment. The caller owns the identity used to choose this home. */
export interface CodexHostEnvironment extends Omit<CodexExecutionConfig, 'mcpServers'> {
  serviceTier?: string;
}
export interface CodexHostInput<TDelivery> extends CodexExecutionInput {
  environment: CodexHostEnvironment;
  tools: { name: string; definitions: McpToolDefinition[]; invocation: McpInvocation<TDelivery> };
  retainSession: boolean;
}

export function hasCodexFinalAnswer(evidence: CodexEvidence): boolean {
  return evidence.state === 'completed' && Boolean(evidence.threadId && evidence.turnId)
    && evidence.messages.some(message => message.phase === 'final_answer' && message.text.trim())
    && evidence.messages.every(message => message.phase !== null);
}

export async function prepareCodexEnvironment(environment: CodexHostEnvironment): Promise<void> {
  for (const path of [environment.codexHome, environment.stateDir, environment.cwd])
    if (!isAbsolute(path)) throw new Error('codex_paths_must_be_absolute');
  const rel = relative(environment.codexHome, environment.stateDir);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('codex_state_must_be_separate');
  if (!(await stat(environment.codexHome)).isDirectory()) throw new Error('codex_home_unavailable');
  if (environment.desktopHost) {
    const { pipePath, nodePath } = environment.desktopHost;
    if (!isAbsolute(pipePath) || !isAbsolute(nodePath)) throw new Error('codex_desktop_host_paths_invalid');
    if (!(await stat(pipePath)).isSocket()) throw new Error('codex_desktop_host_pipe_unavailable');
    await access(nodePath, 1);
  }
  if (environment.skillDirectory && !(await stat(environment.skillDirectory)).isDirectory())
    throw new Error('codex_skill_root_unavailable');
}

/** One embedded session slot; transport lifetime and per-turn authority are separate. */
export class CodexHost<TDelivery = unknown> {
  #running = false;
  #session?: {
    key: string;
    executor: CodexExecutor;
    bridge: Awaited<ReturnType<typeof createMcpBridge<TDelivery>>> | null;
    lifetime: AbortController;
  };
  async #release(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    session.lifetime.abort();
    try { await session.executor.close(); } finally { await session.bridge?.close(); }
  }
  async close(): Promise<void> {
    if (this.#running) throw new Error('dock_driver_busy');
    await this.#release();
  }
  async inspect(environment: CodexHostEnvironment, signal: AbortSignal): Promise<CodexInspection> {
    const resolved = await resolveCodexEnvironment(environment, signal);
    await prepareCodexEnvironment(resolved);
    const inspection = await new CodexExecutor(resolved).inspect(signal);
    return { ...inspection, nativeEnvironment: { ...resolved.nativeEnvironment, desktopHost: inspection.desktopHostState ?? resolved.nativeEnvironment.desktopHost } };
  }
  async reconcile(environment: CodexHostEnvironment, runId: string, signal: AbortSignal) {
    const resolved = await resolveCodexEnvironment(environment, signal);
    return new CodexExecutor(resolved).reconcile(runId, signal);
  }
  async execute(input: CodexHostInput<TDelivery>): Promise<CodexEvidence> {
    if (this.#running) throw new Error('dock_driver_busy');
    this.#running = true;
    let retain = false;
    let accepting = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, input.tools.invocation.signal, controller.signal]);
    let bridge: Awaited<ReturnType<typeof createMcpBridge<TDelivery>>> | null = null;
    try {
      signal.throwIfAborted();
      const resolved = await observeStartup(input.runId, 'native_environment', () => resolveCodexEnvironment(input.environment, signal));
      const { serviceTier, ...environment } = resolved;
      const key = createHash('sha256').update(JSON.stringify({
        environment,
        tools: input.tools.definitions, name: input.tools.name,
      })).digest('hex');
      if (this.#session?.key !== key) {
        await this.#release();
        await prepareCodexEnvironment(environment);
        const lifetime = new AbortController();
        const endpoint = input.tools.definitions.length ? await createMcpBridge<TDelivery>({
          signal: lifetime.signal, name: input.tools.name, tools: input.tools.definitions,
        }) : null;
        this.#session = {
          key, lifetime, bridge: endpoint,
          executor: new CodexExecutor({ ...environment, mcpServers: endpoint ? [endpoint.descriptor] : [] }),
        };
      }
      bridge = this.#session.bridge;
      bridge?.bind({ ...input.tools.invocation, signal,
        onToolCall: async call => {
          signal.throwIfAborted();
          if (!accepting) throw new Error('mcp_invocation_not_active');
          return input.tools.invocation.onToolCall(call);
        },
      });
      const evidence = await this.#session.executor.execute({ ...input, serviceTier, signal,
        onReady: async threadId => {
          await input.onReady(threadId);
          signal.throwIfAborted();
          accepting = true;
        },
        onEvent: async event => {
          if (event.type === 'tool_call') bridge?.acknowledgeToolUpdate({ ...event, sessionUpdate: event.tag });
          await input.onEvent(event);
        },
      });
      retain = input.retainSession && hasCodexFinalAnswer(evidence) && !signal.aborted;
      return evidence;
    } finally {
      accepting = false;
      controller.abort();
      try { await bridge?.unbind(); } finally {
        try { if (!retain) await this.#release(); }
        finally { this.#running = false; }
      }
    }
  }
}
