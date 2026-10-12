import { createHash } from 'node:crypto';
import { lstat, mkdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexExecutor, type CodexEvidence, type CodexExecutionConfig, type CodexExecutionInput } from './codex.ts';
import { prepareCodexHome } from './codex-home.ts';
import { createMcpBridge, type McpInvocation, type McpToolDefinition } from './mcp-bridge.ts';

/** Frozen provider environment. The caller owns the identity used to choose this home. */
export interface CodexHostEnvironment extends Omit<CodexExecutionConfig, 'mcpServers'> {
  authFile: string;
  approvalPolicy: string;
  serviceTier?: string;
  skillDirectory?: string;
  skillBindingName?: string;
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
  if (environment.sandbox !== 'workspace-write' || environment.approvalPolicy !== 'on-request')
    throw new Error('dock_execution_policy_unverified');
  await prepareCodexHome(environment);
  const home = environment.codexHome;
  await writeFile(join(home, 'config.toml'),
    'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n'
    + (environment.serviceTier ? `service_tier = ${JSON.stringify(environment.serviceTier)}\n` : '')
    + '[features]\nmemories = false\nplugins = false\nremote_plugin = false\napps = false\nskip_host_skill_discovery = true\nskill_mcp_dependency_install = false\n[memories]\ngenerate_memories = false\nuse_memories = false\n',
    { mode: 0o600 });
  await mkdir(join(home, 'skills'), { recursive: true, mode: 0o700 });
  const name = environment.skillBindingName ?? 'authorized';
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('dock_skill_binding_invalid');
  const path = join(home, 'skills', name);
  try {
    if (!(await lstat(path)).isSymbolicLink()) throw new Error('dock_skill_binding_conflict');
    if (environment.skillDirectory && await readlink(path) === environment.skillDirectory) return;
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (environment.skillDirectory) await symlink(environment.skillDirectory, path, 'dir');
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
  async inspect(environment: CodexHostEnvironment, signal: AbortSignal) {
    await prepareCodexEnvironment(environment);
    return new CodexExecutor(environment).inspect(signal);
  }
  async reconcile(environment: CodexHostEnvironment, runId: string, signal: AbortSignal) {
    return new CodexExecutor(environment).reconcile(runId, signal);
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
      const key = createHash('sha256').update(JSON.stringify({
        environment: input.environment, model: input.model, effort: input.effort,
        tools: input.tools.definitions, name: input.tools.name,
      })).digest('hex');
      if (this.#session?.key !== key) {
        await this.#release();
        await prepareCodexEnvironment(input.environment);
        const lifetime = new AbortController();
        const endpoint = input.tools.definitions.length ? await createMcpBridge<TDelivery>({
          signal: lifetime.signal, name: input.tools.name, tools: input.tools.definitions,
        }) : null;
        this.#session = {
          key, lifetime, bridge: endpoint,
          executor: new CodexExecutor({ ...input.environment, mcpServers: endpoint ? [endpoint.descriptor] : [] }),
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
      const evidence = await this.#session.executor.execute({ ...input, signal,
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
