import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CodexHost, type CodexHostEnvironment } from './codex-host.ts';
import type { CodexInspection } from './codex.ts';
import type { DiscoveredProvider } from './discovery.ts';
import type { NativePermissionRequest, NativePermissionDecision } from './execution.ts';
import type { McpInvocation, McpToolDefinition } from './mcp-bridge.ts';

export type CodexHostPort = Pick<CodexHost, 'inspect' | 'execute' | 'reconcile' | 'close'>;
export interface ProviderCapabilities {
  protocol: 'acp';
  sessionResume: 'native' | 'unsupported';
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
  workdir: string; skillDirectory: string;
  signal: AbortSignal;
  tools?: { name: string; definitions: McpToolDefinition[] };
  invocation: McpInvocation;
  ready(sessionId?: string): Promise<void>;
  observe(kind: string, payload: Record<string, unknown>): Promise<void>;
  permission(request: NativePermissionRequest, signal: AbortSignal, responseSent: Promise<void>): Promise<NativePermissionDecision>;
  steering(steer: ((text: string) => Promise<'accepted' | 'rejected' | 'unknown'>) | null): void;
}
export interface ProviderAdapter {
  inspect(signal: AbortSignal): Promise<ProviderInspection>;
  validate(input: Pick<ProviderExecution, 'model' | 'config'>): void;
  /** Private, durable provider context. The device stores it without interpreting it. */
  environment(input: Pick<ProviderExecution, 'sessionKey' | 'workdir' | 'skillDirectory' | 'config'>): unknown;
  execute(input: ProviderExecution, environment?: unknown): Promise<unknown>;
  close(): Promise<void>;
  forgetSession(sessionKey: string): Promise<void>;
}
export interface ProviderAdapterOptions {
  cwd: string; stateDir: string; environment: NodeJS.ProcessEnv; inspection?: unknown;
}
/** Provider selection and native recovery stay behind the same driver boundary. */
export interface ProviderAdapters {
  create(provider: DiscoveredProvider, options: ProviderAdapterOptions, scope: 'inspection' | 'session'): ProviderAdapter;
  reconcile(provider: string, context: unknown, runId: string, signal: AbortSignal): Promise<{ state: 'unknown' | 'completed' | 'failed' | 'cancelled' } | null>;
  close(): Promise<void>;
}
export function createProviderAdapters(codex: CodexHostPort | (() => CodexHostPort) = () => new CodexHost()): ProviderAdapters {
  const createCodex = typeof codex === 'function' ? codex : () => codex;
  const recoveryHost = createCodex();
  let inspectionOwnsHost = false;
  return {
    create(provider, options, scope) {
      if (scope === 'inspection') inspectionOwnsHost = true;
      return createProviderAdapter(provider, { ...options, codex: scope === 'inspection' ? recoveryHost : createCodex() });
    },
    async reconcile(provider, context, runId, signal) {
      if (provider !== 'codex' || !context) return null;
      return recoveryHost.reconcile(context as CodexHostEnvironment, runId, signal);
    },
    async close() { if (!inspectionOwnsHost) await recoveryHost.close(); },
  };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const interactions = ['options', 'form', 'url'] as const;
/** Codex policy and native recovery stay outside device admission. */
export function createProviderAdapter(provider: DiscoveredProvider, options: {
  cwd: string; stateDir: string; environment: NodeJS.ProcessEnv; codex: CodexHostPort; inspection?: unknown;
}): ProviderAdapter {
  if (provider.key !== 'codex') throw new Error('unsupported_provider');
  let inspection = options.inspection as CodexInspection;
  const environment = (input: Parameters<ProviderAdapter['environment']>[0]): CodexHostEnvironment => ({
    cwd: input.workdir, codexHome: provider.home!, codexBin: provider.executable!,
    stateDir: join(options.stateDir, 'providers', 'codex', digest(input.sessionKey), 'execution'),
    sandbox: 'workspace-write', skillDirectory: input.skillDirectory,
    serviceTier: typeof input.config.serviceTier === 'string' ? input.config.serviceTier : undefined,
    environment: options.environment,
  });
  return {
    async inspect(signal) {
      inspection = await options.codex.inspect(environment({ sessionKey: 'probe', workdir: options.cwd, skillDirectory: '', config: {} })!, signal);
      return { models: inspection.models.map(model => model.id), inspection, capabilities: {
        protocol: 'acp', browser: 'unverified',
        sessionResume: 'native', resultQuery: 'native', exactFinalAnswer: true, callerSkills: true,
        permissionInteractions: interactions, desktopTools: inspection.desktopHostState ?? 'not_reported',
      } };
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
        environment: selectedEnvironment as CodexHostEnvironment, runId: input.runId, prompt: input.prompt, model: input.model,
        mode: typeof input.config.mode === 'string' ? input.config.mode : undefined,
        effort: typeof input.config.effort === 'string' ? input.config.effort : undefined,
        resumeThreadId: input.resumeSessionId, previousRunId: input.previousRunId, retainSession: input.retainSession,
        signal: input.signal, tools: { name: input.tools?.name ?? 'controller', definitions: input.tools?.definitions ?? [], invocation: input.invocation },
        onReady: input.ready, onEvent: event => input.observe('event', event),
        onSteeringReady: input.steering, permission: input.permission,
      });
    },
    close: () => options.codex.close(),
    forgetSession: () => options.codex.close(),
  };
}

function validateMode(config: Record<string, unknown>, modes?: readonly { value: string }[]): void {
  if (config.mode !== undefined && (typeof config.mode !== 'string' || !modes?.some(mode => mode.value === config.mode))) throw new Error('permission_mode_unavailable');
}
