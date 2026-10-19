import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexHost, type CodexHostEnvironment } from './codex-host.ts';
import type { CodexInspection } from './codex.ts';
import { LobiAcpExecutor } from './lobi.ts';
import { DeepSeekAcpExecutor } from './deepseek.ts';
import { ZCodeExecutor } from './zcode.ts';
import type { AcpExecutor, AcpInspection } from './acp-types.ts';
import type { DiscoveredProvider } from './discovery.ts';
import type { NativePermissionRequest, NativePermissionDecision } from './execution.ts';
import type { McpInvocation, McpToolDefinition } from './mcp-bridge.ts';
import { AnswerBudget } from './output-limits.ts';

export type CodexHostPort = Pick<CodexHost, 'inspect' | 'execute' | 'reconcile' | 'close'>;
export interface ProviderCapabilities {
  protocol: 'acp';
  sessionResume: 'native' | 'warm' | 'unsupported';
  resultQuery: 'native' | 'unsupported';
  exactFinalAnswer: boolean;
  callerSkills: boolean;
  permissionInteractions: readonly ('options' | 'form' | 'url')[];
  desktopTools: 'connected' | 'disabled' | 'unavailable' | 'not_reported';
  browser: 'unverified';
}
export interface ProviderInspection {
  models: string[];
  inspection: unknown;
  capabilities: ProviderCapabilities;
}
export interface ProviderExecution {
  runId: string; sessionKey: string; prompt: string; model?: string;
  config: Record<string, unknown>; resumeSessionId?: string; previousRunId?: string; retainSession: boolean;
  workdir: string; skillDirectory: string; callerSkillsPresent: boolean;
  signal: AbortSignal; cancellationRequested(): boolean;
  tools?: { name: string; definitions: McpToolDefinition[] };
  invocation: McpInvocation;
  ready(sessionId?: string): Promise<void>;
  observe(kind: string, payload: Record<string, unknown>): Promise<void>;
  permission(request: NativePermissionRequest, signal: AbortSignal, responseSent: Promise<void>): Promise<NativePermissionDecision>;
  steering(steer: ((text: string) => Promise<'accepted' | 'rejected' | 'unknown'>) | null): void;
}
export interface ProviderAdapter {
  inspect(signal: AbortSignal): Promise<ProviderInspection>;
  validate(input: Pick<ProviderExecution, 'model' | 'config' | 'resumeSessionId' | 'callerSkillsPresent'>): void;
  environment(input: Pick<ProviderExecution, 'sessionKey' | 'workdir' | 'skillDirectory' | 'config'>): CodexHostEnvironment | undefined;
  execute(input: ProviderExecution, environment?: CodexHostEnvironment): Promise<unknown>;
  close(): Promise<void>;
  retainedSessionId(): string | undefined;
  forgetSession(sessionKey: string): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const interactions = ['options', 'form', 'url'] as const;
const capabilities = (fields: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  protocol: 'acp', sessionResume: 'unsupported', resultQuery: 'unsupported', exactFinalAnswer: false,
  callerSkills: false, permissionInteractions: [], desktopTools: 'not_reported', browser: 'unverified', ...fields,
});

/** Named adapters keep harness policy and result differences outside device admission. */
export function createProviderAdapter(provider: DiscoveredProvider, options: {
  cwd: string; stateDir: string; idleTimeoutMs: number; environment: NodeJS.ProcessEnv; codex: CodexHostPort; inspection?: unknown;
}): ProviderAdapter {
  if (provider.key === 'codex') {
    let inspection = options.inspection as CodexInspection;
    const environment: ProviderAdapter['environment'] = input => ({
      cwd: input.workdir, codexHome: provider.home!, codexBin: provider.executable!,
      stateDir: join(options.stateDir, 'providers', 'codex', digest(input.sessionKey), 'execution'),
      sandbox: 'workspace-write', skillDirectory: input.skillDirectory,
      serviceTier: typeof input.config.serviceTier === 'string' ? input.config.serviceTier : undefined,
      environment: options.environment,
    });
    return {
      async inspect(signal) {
        inspection = await options.codex.inspect(environment({ sessionKey: 'probe', workdir: options.cwd, skillDirectory: '', config: {} })!, signal);
        return { models: inspection.models.map(model => model.id), inspection, capabilities: capabilities({
          sessionResume: 'native', resultQuery: 'native', exactFinalAnswer: true, callerSkills: true,
          permissionInteractions: interactions, desktopTools: inspection.desktopHostState ?? 'not_reported',
        }) };
      },
      validate({ model, config }) {
        if (Object.keys(config).some(key => !['effort', 'serviceTier', 'mode'].includes(key))) throw new Error('unsupported_config');
        const selected = inspection.models.find(value => value.id === model);
        if (config.effort && !selected?.efforts.includes(String(config.effort)) || config.serviceTier && !selected?.serviceTiers.includes(String(config.serviceTier))) throw new Error('configuration_unavailable');
        validateMode(config, inspection.permissionModes);
      },
      environment,
      async execute(input, selectedEnvironment) {
        return options.codex.execute({
          environment: selectedEnvironment!, runId: input.runId, prompt: input.prompt, model: input.model,
          mode: typeof input.config.mode === 'string' ? input.config.mode : undefined,
          effort: typeof input.config.effort === 'string' ? input.config.effort : undefined,
          resumeThreadId: input.resumeSessionId, previousRunId: input.previousRunId, retainSession: input.retainSession,
          signal: input.signal, tools: { name: input.tools?.name ?? 'controller', definitions: input.tools?.definitions ?? [], invocation: input.invocation },
          onReady: input.ready, onEvent: event => input.observe('event', event),
          onSteeringReady: input.steering, permission: input.permission,
        });
      },
      close: () => options.codex.close(), retainedSessionId: () => undefined,
      forgetSession: () => options.codex.close(),
    };
  }
  if (provider.key === 'zcode') {
    let inspection = options.inspection as Awaited<ReturnType<ZCodeExecutor['inspect']>>;
    let retained: { key: string; executor: ZCodeExecutor } | undefined;
    const executor = (cwd: string, stateDir: string) => new ZCodeExecutor({ cwd, stateDir,
      zcodeBin: provider.executable!, zcodeHome: provider.home!, environment: options.environment });
    const close = async () => { const previous = retained; retained = undefined; await previous?.executor.close(); };
    return {
      async inspect(signal) {
        await access(join(provider.home!, 'v2', 'credentials.json'));
        inspection = await executor(options.cwd, join(options.stateDir, 'zcode-probe')).inspect(signal);
        return { models: inspection.models, inspection, capabilities: capabilities({
          sessionResume: 'warm', permissionInteractions: inspection.permissionInteractions,
        }) };
      },
      validate({ model, config, callerSkillsPresent }) {
        if (Object.keys(config).some(key => !['effort', 'mode'].includes(key))) throw new Error('zcode_config_unsupported');
        if (config.effort && !inspection.reasoningEffortsByModel[model ?? '']?.includes(String(config.effort))) throw new Error('configuration_unavailable');
        validateMode(config, inspection.permissionModes);
        if (callerSkillsPresent) throw new Error('zcode_caller_skills_unsupported');
      },
      environment: () => undefined,
      async execute(input) {
        if (retained?.key !== input.sessionKey) await close();
        const selected = retained ??= { key: input.sessionKey,
          executor: executor(input.workdir, join(options.stateDir, 'providers', 'zcode', digest(input.sessionKey))) };
        let text = '', sessionId: string | undefined;
        const budget = new AnswerBudget();
        const terminal = await selected.executor.execute({
          runId: input.runId, prompt: input.prompt, resumeThreadId: input.resumeSessionId, signal: input.signal,
          model: input.model, mode: typeof input.config.mode === 'string' ? input.config.mode : undefined,
          effort: typeof input.config.effort === 'string' ? input.config.effort : undefined,
          skillDirectory: input.skillDirectory, callerSkillsPresent: input.callerSkillsPresent,
          tools: { name: input.tools?.name ?? 'controller', definitions: input.tools?.definitions ?? [], invocation: input.invocation },
          onReady: async value => { sessionId = value; await input.ready(value); },
          onEvent: async event => {
            if (event.type === 'text_delta' && event.stream !== 'thought') { budget.add(event.text); text += event.text; }
            await input.observe('event', event);
          }, permission: input.permission,
        });
        const result = { ...terminal, text, sessionId, resumable: terminal.state === 'completed' && input.retainSession,
          sessionResumeMode: 'warm', warmSessionIdleTimeoutMs: options.idleTimeoutMs,
          resumed: Boolean(input.resumeSessionId), exactFinalAnswer: false };
        if (!input.retainSession) await close();
        return result;
      },
      close, retainedSessionId: () => retained?.executor.retainedSessionId,
      forgetSession: async key => { if (retained?.key === key) await close(); },
    };
  }
  const env = { ...options.environment, ...(provider.key === 'deepseek-harness' ? { DSH_HOME: provider.home! } : {}) };
  let inspection = options.inspection as AcpInspection | undefined;
  const executor: AcpExecutor = provider.key === 'lobi'
    ? new LobiAcpExecutor({ executable: provider.executable!, env, inspection })
    : new DeepSeekAcpExecutor({ executable: provider.executable!, env, inspection });
  return {
    async inspect(signal) {
      inspection = await executor.probe(signal);
      return { models: inspection.models, inspection, capabilities: capabilities({
        sessionResume: inspection.loadSession || inspection.resumeSession ? 'native' : 'unsupported',
        callerSkills: inspection.callerSkills === true, permissionInteractions: inspection.permissionInteractions ?? [],
      }) };
    },
    validate({ resumeSessionId }) {
      if (resumeSessionId && !inspection?.loadSession && !inspection?.resumeSession) throw new Error('provider_session_resume_unsupported');
    },
    environment: () => undefined,
    execute: input => executor.execute({
      runId: input.runId, cwd: input.workdir, prompt: input.prompt, model: input.model ?? inspection?.models[0]!,
      config: input.config, signal: input.signal, resumeSessionId: input.resumeSessionId, allowSessionResume: true,
      skillDirectory: input.skillDirectory, tools: input.tools?.definitions, mcp: input.invocation, mcpName: input.tools?.name,
      cancellationRequested: input.cancellationRequested,
      callbacks: {
        onStarted: async () => input.ready(), onProgress: payload => input.observe('progress', payload),
        onFileChanges: event => input.observe('fileChanges', event),
        permission: (request, signal, responseSent) => input.permission({ ...request,
          title: request.title ?? `${provider.key} permission`, details: request.toolCall }, signal, responseSent),
      },
    }),
    close: async () => {}, retainedSessionId: () => undefined, forgetSession: async () => {},
  };
}
function validateMode(config: Record<string, unknown>, modes?: readonly { value: string }[]): void {
  if (config.mode !== undefined && (typeof config.mode !== 'string' || !modes?.some(mode => mode.value === config.mode))) throw new Error('permission_mode_unavailable');
}
