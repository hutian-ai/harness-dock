import { randomUUID } from 'node:crypto';
import { arch, hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import {
  CodexHost, LobiAcpExecutor, DeepSeekAcpExecutor, ZCodeExecutor, discoverProviders,
  AnswerBudget, boundedObservation,
  type AcpExecutor, type CodexHostEnvironment, type DiscoveredProvider, type McpInvocation,
  type McpToolDefinition, type ProviderKey, type NativePermissionRequest, type NativePermissionDecision,
} from '@harness-dock/drivers';
import type { DeviceConfig } from './config.ts';
import { collectFiles, digest, prepareDirectories, releaseDirectories, verifySkillFiles, managedStateBytes, forgetSessionDirectories, type DeviceFile } from './device-files.ts';
import { DeviceStore, type StoredExecution } from './device-store.ts';
import { resourceLimits, type DeviceResourceLimits } from './device-resources.ts';
import { ObservationWriter } from './observation-writer.ts';

export type DeviceCallback = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
export interface DeviceExecuteInput {
  provider: ProviderKey; runId: string; sessionKey?: string; prompt: string; model?: string;
  config?: Record<string, unknown>; resumeSessionId?: string; previousRunId?: string; retainSession?: boolean;
  tools?: { name: string; definitions: McpToolDefinition[] };
}
interface InventoryProvider {
  key: ProviderKey; displayName: string; status: 'ready' | 'not_found' | 'unavailable' | 'disabled';
  version: string | null; models: string[]; inspection?: unknown; error?: string;
}
type CodexHostPort = Pick<CodexHost, 'inspect' | 'execute' | 'reconcile' | 'close'>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  return value as Record<string, unknown>;
};
function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000-\u001f]/u.test(value)) throw new Error('invalid_identity');
  return value;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function executionInput(value: unknown): DeviceExecuteInput {
  const input = object(value);
  for (const key of Object.keys(input)) if (!['provider', 'runId', 'sessionKey', 'prompt', 'model', 'config', 'resumeSessionId', 'previousRunId', 'retainSession', 'tools'].includes(key)) throw new Error('unsupported_execution_field');
  if (!['codex', 'lobi', 'deepseek-harness', 'zcode'].includes(String(input.provider))) throw new Error('unsupported_provider');
  identity(input.runId);
  for (const key of ['sessionKey', 'model', 'resumeSessionId', 'previousRunId']) if (input[key] !== undefined) identity(input[key]);
  if (typeof input.prompt !== 'string' || !input.prompt || input.prompt.length > 1_000_000) throw new Error('invalid_prompt');
  if (input.config !== undefined) object(input.config);
  if (input.retainSession !== undefined && typeof input.retainSession !== 'boolean') throw new Error('invalid_retain_session');
  if (input.tools !== undefined) {
    const tools = object(input.tools);
    identity(tools.name);
    if (!Array.isArray(tools.definitions) || tools.definitions.length > 100 || JSON.stringify(tools).length > 1_000_000) throw new Error('invalid_tools');
    const names = new Set();
    for (const raw of tools.definitions) {
      const tool = object(raw); identity(tool.name); object(tool.inputSchema);
      if (names.has(tool.name) || typeof tool.description !== 'string') throw new Error('invalid_tools');
      names.add(tool.name);
    }
  }
  return input as unknown as DeviceExecuteInput;
}

/** Owns device processes and evidence independently of any controller connection. */
export class DeviceHost {
  readonly daemonId = randomUUID();
  readonly nodeId: string;
  readonly #store: DeviceStore;
  readonly #codex: CodexHostPort;
  readonly #limits: DeviceResourceLimits;
  readonly #lifetime = new AbortController();
  readonly #acp = new Map<ProviderKey, AcpExecutor>();
  readonly #found = new Map<ProviderKey, DiscoveredProvider>();
  #providers?: InventoryProvider[];
  #probing?: Promise<unknown>;
  #maintenance?: Promise<unknown>;
  #idleTimer?: NodeJS.Timeout;
  #idleGeneration = 0;
  #idleDeadline?: number;
  #closing?: Promise<void>;
  #persistenceFailed = false;
  #closed = false;
  #callback?: DeviceCallback;
  #zcode?: { key: string; executor: ZCodeExecutor };
  #active?: { runId: string; controller: AbortController; promise: Promise<unknown>; cancellationRequested: boolean; historyTruncated: boolean; steer?: (text: string) => Promise<'accepted' | 'rejected' | 'unknown'> };
  constructor(readonly config: DeviceConfig, codex: CodexHostPort = new CodexHost()) {
    this.nodeId = config.nodeId;
    this.#codex = codex;
    this.#limits = resourceLimits(config.resources);
    this.#store = new DeviceStore(config.nodeId, config.stateDir, config.resources);
    this.#store.expireDetails();
    this.#armIdleTimer();
  }
  #assertOpen(): void { if (this.#closed) throw new Error('device_stopping'); }
  #clearIdleTimer(): void {
    clearTimeout(this.#idleTimer); this.#idleTimer = undefined; this.#idleGeneration++;
  }
  #armIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#closed || this.#maintenance || this.#active) return;
    const generation = this.#idleGeneration;
    this.#idleTimer = setTimeout(() => {
      if (generation !== this.#idleGeneration || this.#closed) return;
      void this.#maintain(async () => {
        if (this.#idleDeadline !== undefined && Date.now() >= this.#idleDeadline) {
          this.#idleDeadline = undefined;
          await this.#closeProviders();
        }
        await this.#cleanup();
      }).catch(error => console.error('Device idle maintenance failed:', error instanceof Error ? error.message : 'unknown'));
    }, this.#idleDeadline === undefined ? 60_000 : Math.min(60_000, Math.max(0, this.#idleDeadline - Date.now())));
    this.#idleTimer.unref();
  }
  #maintain<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#active || this.#maintenance) throw new Error('busy');
    this.#clearIdleTimer();
    // Acquire before the first await, including a timer racing a newly admitted request.
    const pending = Promise.resolve().then(operation);
    this.#maintenance = pending;
    return pending.finally(() => {
      if (this.#maintenance === pending) this.#maintenance = undefined;
      this.#armIdleTimer();
    });
  }
  async #closeProviders(): Promise<void> {
    const zcode = this.#zcode; this.#zcode = undefined;
    const results = await Promise.allSettled([this.#codex.close(), zcode?.executor.close()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async #cleanup(): Promise<void> {
    this.#store.expireDetails();
    for (const prepared of this.#store.expirePreparations(Date.now() - this.#limits.preparationTtlMs)) {
      await releaseDirectories(this.config.stateDir, prepared.runId);
      this.#store.markReleased(prepared.runId);
    }
  }
  async #capacity(runId: string): Promise<void> {
    if (this.#persistenceFailed) throw new Error('resource_exhausted:persistence_unconfirmed');
    await this.#cleanup();
    this.#store.assertCapacity(runId);
    if (await managedStateBytes(this.config.stateDir, this.#limits.maxStateBytes) >= this.#limits.maxStateBytes)
      throw new Error('resource_exhausted:managed_state_bytes');
  }
  get activeRunId(): string | undefined { return this.#active?.runId; }
  maintenanceStatus() { return { activeRunId: this.activeRunId, unresolvedRunIds: this.#store.unresolved() }; }
  /** Reserve shutdown synchronously so admission cannot race an installation change. */
  closeIfIdle(): Promise<void> {
    this.#assertOpen();
    if (this.#active || this.#maintenance || this.#probing) throw new Error('device_busy');
    if (this.#store.unresolved().length) throw new Error('unresolved_execution');
    return this.close();
  }
  bind(callback: DeviceCallback): () => void {
    this.#callback = callback;
    return () => { if (this.#callback === callback) this.#callback = undefined; };
  }
  async #call(runId: string, kind: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.#callback) throw new Error('controller_disconnected');
    return this.#callback('execution.callback', { runId, kind, payload }, timeoutMs);
  }
  async #observe(runId: string, kind: string, payload: unknown): Promise<void> {
    const observation = boundedObservation(kind, payload);
    const stored = this.#store.observe(runId, kind, observation);
    if (!stored && this.#active?.runId === runId && !this.#active.historyTruncated) {
      this.#active.historyTruncated = true;
      try { await this.#call(runId, 'historyTruncated', { type: 'history_truncated', reason: 'observation_retention_limit' }); } catch { /* Persisted by the Store. */ }
    }
    try { await this.#call(runId, kind, observation); } catch { /* Reconnect observes persisted events; it never replays effects. */ }
  }
  events(runId: string, after: number) {
    this.#assertOpen();
    identity(runId);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid_sequence');
    return this.#store.events(runId, after);
  }
  #environment(provider: DiscoveredProvider, sessionKey: string, cwd: string, config: Record<string, unknown> = {}, skillDirectory?: string): CodexHostEnvironment {
    const home = join(this.config.stateDir, 'providers', 'codex', digest(sessionKey));
    return { cwd, codexHome: provider.home!, codexBin: provider.executable!, stateDir: join(home, 'execution'),
      sandbox: 'workspace-write',
      serviceTier: typeof config.serviceTier === 'string' ? config.serviceTier : undefined, skillDirectory };
  }
  async inventory(refresh = false): Promise<unknown> {
    if (this.#closed) throw new Error('device_stopping');
    if (this.#probing) return this.#probing;
    if (this.#providers && (!refresh || this.#active)) return this.#inventory();
    this.#probing = this.#maintain(async () => {
      await this.#cleanup();
      const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(90_000)]);
      const found = await discoverProviders({ overrides: this.config.providers, signal });
      this.#found.clear(); this.#acp.clear();
      const providers: InventoryProvider[] = [];
      for (const provider of found) {
        this.#found.set(provider.key, provider);
        const item: InventoryProvider = { key: provider.key, displayName: provider.displayName,
          status: provider.status === 'installed' ? 'unavailable' : provider.status, version: provider.version, models: [] };
        providers.push(item);
        if (provider.status !== 'installed') { item.error = provider.reason; continue; }
        try {
          if (provider.key === 'codex') {
            const environment = this.#environment(provider, 'probe', this.config.cwd);
            const inspection = await this.#codex.inspect(environment, signal);
            item.inspection = inspection; item.models = inspection.models.map(model => model.id);
          } else if (provider.key === 'zcode') {
            // The bridge's lazy handshake alone does not validate the login. Require local credentials too.
            await access(join(provider.home!, 'v2', 'credentials.json'));
            const executor = new ZCodeExecutor({ cwd: this.config.cwd, stateDir: join(this.config.stateDir, 'zcode-probe'), zcodeBin: provider.executable!, zcodeHome: provider.home! });
            const inspection = await executor.inspect(signal);
            item.inspection = inspection;
            item.models = inspection.models;
          } else {
            const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
              ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SYSTEMROOT'].includes(key.toUpperCase())));
            if (provider.key === 'deepseek-harness') env.DSH_HOME = provider.home!;
            const executor = provider.key === 'lobi'
              ? new LobiAcpExecutor({ executable: provider.executable!, env })
              : new DeepSeekAcpExecutor({ executable: provider.executable!, env });
            const inspection = await executor.probe(signal);
            this.#acp.set(provider.key, executor); item.inspection = inspection; item.models = inspection.models;
          }
          item.status = 'ready';
        } catch (error) { item.error = error instanceof Error ? error.message : String(error); }
      }
      this.#providers = providers;
      return this.#inventory();
    });
    try { return await this.#probing; } finally { this.#probing = undefined; }
  }
  #inventory() {
    return { nodeId: this.nodeId, daemonId: this.daemonId, workdir: this.config.cwd,
      platform: { platform: platform(), arch: arch(), release: release(), hostname: hostname() },
      activeRunId: this.activeRunId, unresolvedRunIds: this.#store.unresolved(), resources: this.#limits,
      providers: (this.#providers ?? []).map(provider => ({ ...provider,
        sessionResumeMode: provider.key === 'codex' ? 'native' : provider.key === 'zcode' ? 'warm'
          : (provider.inspection as { loadSession?: boolean; resumeSession?: boolean } | undefined)?.loadSession
            || (provider.inspection as { resumeSession?: boolean } | undefined)?.resumeSession ? 'native' : 'unsupported',
        ...(provider.key === 'zcode' ? { warmSessionIdleTimeoutMs: this.#limits.idleTimeoutMs,
          warmSessionId: this.#zcode?.executor.retainedSessionId ?? null,
          warmSessionExpiresAt: this.#zcode?.executor.retainedSessionId && !this.#active ? this.#idleDeadline ?? null : null } : {}),
      })) };
  }
  async prepare(value: unknown) {
    const input = object(value), runId = identity(input.runId), sessionKey = input.sessionKey === undefined ? runId : identity(input.sessionKey);
    const fingerprint = digest(canonical({ sessionKey, files: input.files ?? [] }));
    return this.#maintain(async () => {
      this.#store.assertSessionOpen(sessionKey);
      const previous = this.#store.preparation(runId);
      if (previous) {
        if (previous.input !== fingerprint || previous.released) throw new Error('preparation_identity_conflict');
        await verifySkillFiles(this.config.stateDir, previous.directories.skillDirectory, (input.files ?? []) as DeviceFile[]);
        return previous.directories;
      }
      await this.#capacity(runId);
      const directories = await prepareDirectories(this.config.stateDir, runId, sessionKey, (input.files ?? []) as DeviceFile[], this.config.cwd);
      this.#store.prepare(runId, { input: fingerprint, sessionKey, directories });
      return directories;
    });
  }
  getExecution(runId: string) {
    this.#assertOpen();
    const value = this.#store.get(identity(runId));
    if (!value) return null;
    const state = value.state === 'running' && this.#active?.runId !== runId ? 'unknown' : value.state;
    return { runId: value.runId, provider: value.provider, state, result: value.result,
      detailsExpired: value.detailsExpired ?? false, historyTruncated: value.historyTruncated ?? false };
  }
  async execute(value: unknown): Promise<unknown> {
    this.#assertOpen();
    const input = executionInput(value), fingerprint = digest(canonical(input));
    const existing = this.#store.get(input.runId);
    if (existing) {
      if (existing.input !== fingerprint) throw new Error('execution_identity_conflict');
      if (existing.detailsExpired) throw new Error('execution_details_expired');
      if (this.#active?.runId === input.runId) return this.#active.promise;
      return { provider: existing.provider, result: existing.result ?? { state: existing.state, error: 'unconfirmed_previous_execution' } };
    }
    return this.#maintain(async () => {
      await this.#capacity(input.runId);
      this.#assertOpen();
      this.#store.assertSessionOpen(input.sessionKey ?? input.runId);
      const unresolved = this.#store.unresolved();
      if (unresolved.length) throw new Error(`unresolved_execution:${unresolved[0]}`);
      const prepared = this.#store.preparation(input.runId);
      if (!prepared || prepared.released || prepared.sessionKey !== (input.sessionKey ?? input.runId)) throw new Error('execution_not_prepared');
      const provider = this.#found.get(input.provider);
      const available = this.#providers?.find(item => item.key === input.provider);
      if (!provider || available?.status !== 'ready') throw new Error('provider_unavailable');
      if (input.model && !available.models.includes(input.model)) throw new Error('model_unavailable');
      const config = input.config ?? {};
      if (input.provider === 'codex') {
        if (Object.keys(config).some(key => !['effort', 'serviceTier', 'mode'].includes(key))) throw new Error('unsupported_config');
        const inspection = available.inspection as { models: { id: string; efforts: string[]; serviceTiers: string[] }[] };
        const model = inspection.models.find(model => model.id === input.model);
        if (config.effort && !model?.efforts.includes(String(config.effort)) || config.serviceTier && !model?.serviceTiers.includes(String(config.serviceTier))) throw new Error('configuration_unavailable');
      } else if (input.provider === 'zcode') {
        if (Object.keys(config).some(key => !['effort', 'mode'].includes(key))) throw new Error('zcode_config_unsupported');
        const inspection = available.inspection as { reasoningEffortsByModel: Record<string, string[]> };
        if (config.effort && !inspection.reasoningEffortsByModel[input.model ?? '']?.includes(String(config.effort))) throw new Error('configuration_unavailable');
      }
      if ((input.provider === 'codex' || input.provider === 'zcode') && config.mode !== undefined) {
        const inspection = available.inspection as { permissionModes?: { value: string }[] };
        if (typeof config.mode !== 'string' || !inspection.permissionModes?.some(mode => mode.value === config.mode)) throw new Error('permission_mode_unavailable');
      }
      const controller = new AbortController();
      const environment = input.provider === 'codex' ? this.#environment(provider, prepared.sessionKey, prepared.directories.workdir, config, prepared.directories.skillDirectory) : undefined;
      const record: StoredExecution = { runId: input.runId, provider: input.provider, input: fingerprint, state: 'running', environment };
      this.#store.admit(record); // Persist before any provider process or prompt is started.
      const active = { runId: input.runId, controller, cancellationRequested: false, historyTruncated: false, promise: Promise.resolve<unknown>(null), steer: undefined as ((text: string) => Promise<'accepted' | 'rejected' | 'unknown'>) | undefined };
      this.#active = active;
      active.promise = (async () => {
        const signal = AbortSignal.any([controller.signal, this.#lifetime.signal]);
        const observations = new ObservationWriter((kind, payload) => this.#observe(input.runId, kind, payload), signal);
        const reports = new Set<Promise<unknown>>();
        let pendingPermissions = 0;
        let started = false;
        const ready = async (sessionId?: string) => {
          await this.#call(input.runId, 'ready', { sessionId }); signal.throwIfAborted(); started = true;
        };
        const invocation: McpInvocation = { signal,
          onToolCall: async call => {
            signal.throwIfAborted();
            observations.seal();
            return await withSignal(this.#call(input.runId, 'toolCall', call, 5 * 60_000), signal) as Awaited<ReturnType<McpInvocation['onToolCall']>>;
          },
          onToolResultDelivery: async delivery => { await this.#call(input.runId, 'toolDelivery', delivery); },
        };
        const permission = async (request: NativePermissionRequest, nativeSignal: AbortSignal, responseSent?: Promise<void>): Promise<NativePermissionDecision> => {
          if (this.#active !== active || signal.aborted || nativeSignal.aborted || pendingPermissions + reports.size >= 32) return 'deny';
          observations.seal();
          pendingPermissions++;
          let decision: unknown;
          try { decision = await withSignal(this.#call(input.runId, 'permission', request, 30 * 60_000), AbortSignal.any([signal, nativeSignal])); } catch { /* Fail closed. */ }
          finally { pendingPermissions--; }
          let effective: NativePermissionDecision = request.form ? { action: 'cancel' } : 'deny';
          if (!signal.aborted && !nativeSignal.aborted && this.#active === active) {
            if (request.options && decision && typeof decision === 'object' && 'optionId' in decision
              && request.options.some(option => option.optionId === decision.optionId)) effective = { optionId: String(decision.optionId) };
            else if (request.form && decision && typeof decision === 'object' && 'action' in decision
              && ['accept', 'decline', 'cancel'].includes(String(decision.action)) && Buffer.byteLength(JSON.stringify(decision)) <= 32768)
              effective = decision as NativePermissionDecision;
            else if (!request.options && !request.form && (decision === 'deny' || decision === 'allow' && request.canAllow)) effective = decision;
          }
          const confirmed = decision !== undefined && canonical(decision) === canonical(effective);
          if (responseSent) {
            const reporting = withSignal(responseSent, AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(30_000)])).then(
              () => this.#call(input.runId, 'permissionDelivered', { id: request.id, decision: effective, success: confirmed && !signal.aborted && !nativeSignal.aborted }),
              () => this.#call(input.runId, 'permissionDelivered', { id: request.id, decision: effective, success: false }),
            );
            reports.add(reporting);
            void reporting.finally(() => reports.delete(reporting)).catch(() => {});
          }
          return effective;
        };
        try {
          let result: unknown;
          if (input.provider === 'codex') {
            result = await this.#codex.execute({ environment: environment!, runId: input.runId, prompt: input.prompt,
              model: input.model, mode: typeof config.mode === 'string' ? config.mode : undefined, effort: typeof config.effort === 'string' ? config.effort : undefined,
              resumeThreadId: input.resumeSessionId, previousRunId: input.previousRunId, retainSession: input.retainSession ?? false,
              signal, tools: { name: input.tools?.name ?? 'controller', definitions: input.tools?.definitions ?? [], invocation },
              onReady: ready,
              onEvent: async event => { await observations.write('event', event); },
              onSteeringReady: steer => { active.steer = steer ?? undefined; void this.#call(input.runId, 'steering', { available: Boolean(steer) }).catch(() => {}); },
              permission,
            });
          } else if (input.provider === 'zcode') {
            const key = prepared.sessionKey;
            if (this.#zcode?.key !== key) { await this.#zcode?.executor.close(); this.#zcode = undefined; }
            const executor = (this.#zcode ??= { key, executor: new ZCodeExecutor({ cwd: prepared.directories.workdir,
              stateDir: join(this.config.stateDir, 'providers', 'zcode', digest(key)), zcodeHome: provider.home!, zcodeBin: provider.executable! }) }).executor;
            let text = '', sessionId: string | undefined;
            const textBudget = new AnswerBudget();
            const terminal = await executor.execute({ runId: input.runId, prompt: input.prompt, resumeThreadId: input.resumeSessionId, signal,
              model: input.model, mode: typeof config.mode === 'string' ? config.mode : undefined, effort: typeof config.effort === 'string' ? config.effort : undefined,
              tools: { name: input.tools?.name ?? 'controller', definitions: input.tools?.definitions ?? [], invocation },
              onReady: async value => { sessionId = value; await ready(value); },
              onEvent: async event => {
                if (event.type === 'text_delta' && event.stream !== 'thought') { textBudget.add(event.text); text += event.text; }
                await observations.write('event', event);
              }, permission });
            result = { ...terminal, text, sessionId, resumable: terminal.state === 'completed' && input.retainSession === true,
              sessionResumeMode: 'warm', warmSessionIdleTimeoutMs: this.#limits.idleTimeoutMs,
              resumed: Boolean(input.resumeSessionId), exactFinalAnswer: false };
            if (!input.retainSession) { await executor.close(); this.#zcode = undefined; }
          } else {
            result = await this.#acp.get(input.provider)!.execute({ runId: input.runId, cwd: prepared.directories.workdir,
              prompt: input.prompt, model: input.model ?? available.models[0]!, config, signal,
              resumeSessionId: input.resumeSessionId, allowSessionResume: true, skillDirectory: prepared.directories.skillDirectory,
              tools: input.tools?.definitions, mcp: invocation, mcpName: input.tools?.name,
              cancellationRequested: () => active.cancellationRequested,
              callbacks: {
                onStarted: async () => { await ready(); },
                onProgress: async payload => { await observations.write('progress', payload); },
                onFileChanges: async event => { await observations.write('fileChanges', event); },
                permission: async (request, nativeSignal, responseSent) => await permission({ id: request.id, title: `${input.provider} permission`, details: request.toolCall, canAllow: request.canAllow }, nativeSignal, responseSent) === 'allow' ? 'allow' : 'deny',
              },
            });
          }
          await observations.finish();
          const state = object(result).state;
          record.state = ['completed', 'failed', 'cancelled'].includes(String(state)) ? state as StoredExecution['state'] : 'unknown';
          record.result = result;
        } catch (error) {
          record.state = started ? 'unknown' : 'failed';
          record.result = { state: record.state, error: error instanceof Error ? error.message : String(error) };
        } finally {
          observations.close();
          try {
            try { this.#store.save(record); }
            catch (error) {
              // A Provider result that cannot be retained must not escape as confirmed success.
              record.state = 'unknown';
              record.result = { state: 'unknown', error: error instanceof Error ? error.message : 'execution_persistence_failed' };
              try { this.#store.save(record); }
              catch (failure) { this.#persistenceFailed = true; throw failure; }
            }
            // Delivery reporting failure never upgrades Provider evidence or retransmits a callback.
            await Promise.allSettled(reports);
          } finally {
            this.#active = undefined;
            this.#idleDeadline = Date.now() + this.#limits.idleTimeoutMs;
          }
        }
        return { provider: input.provider, result: record.result };
      })();
      return active.promise;
    });
  }
  cancel(runId: string) {
    this.#assertOpen();
    identity(runId);
    if (this.#active?.runId === runId) { this.#active.cancellationRequested = true; this.#active.controller.abort(new Error('cancel_requested')); return { requested: true }; }
    return { requested: false, state: this.#store.get(runId)?.state ?? null };
  }
  async steer(runId: string, text: string) {
    this.#assertOpen();
    identity(runId);
    if (typeof text !== 'string' || !text || text.length > 100_000) throw new Error('invalid_steer');
    const active = this.#active;
    if (active?.runId !== runId || !active.steer) return 'rejected';
    return active.steer(text);
  }
  async reconcile(runId: string) {
    this.#assertOpen();
    const record = this.#store.get(identity(runId));
    if (!record) return null;
    if (record.detailsExpired) throw new Error('execution_details_expired');
    if (['completed', 'failed', 'cancelled'].includes(record.state)) return { provider: record.provider, result: record.result };
    if (record.provider !== 'codex' || !record.environment) return null;
    return this.#maintain(async () => {
      const result = await this.#codex.reconcile(record.environment as CodexHostEnvironment, runId, AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]));
      if (result) { record.state = result.state; record.result = result; this.#store.save(record); }
      return result ? { provider: record.provider, result } : null;
    });
  }
  async collect(runId: string) {
    return this.#maintain(async () => {
      const prepared = this.#store.preparation(identity(runId));
      if (!prepared || prepared.released) throw new Error('preparation_not_found');
      return collectFiles(this.config.stateDir, prepared.directories.outputDirectory);
    });
  }
  async release(runId: string) {
    return this.#maintain(async () => {
      const prepared = this.#store.preparation(identity(runId));
      if (!prepared || prepared.released) return null;
      const execution = this.#store.get(runId);
      if (execution?.state === 'running' || execution?.state === 'unknown') throw new Error('unresolved_execution');
      await releaseDirectories(this.config.stateDir, runId);
      this.#store.markReleased(runId);
      this.#store.expireDetails();
      return null;
    });
  }
  async forgetSession(sessionKey: string) {
    identity(sessionKey);
    return this.#maintain(async () => {
      // Durable invalidation precedes deletion; interrupted cleanup remains safely retryable.
      const forgotten = this.#store.forgetSession(sessionKey);
      await this.#codex.close();
      if (this.#zcode?.key === sessionKey) {
        const zcode = this.#zcode; this.#zcode = undefined;
        await zcode.executor.close();
      }
      await forgetSessionDirectories(this.config.stateDir, sessionKey);
      return forgotten;
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#clearIdleTimer();
    this.#lifetime.abort(new Error('daemon_shutdown'));
    this.#active?.controller.abort(new Error('daemon_shutdown'));
    this.#closing = (async () => {
      await this.#maintenance?.catch(() => {});
      try { await this.#closeProviders(); } finally { this.#store.close(); }
    })();
    return this.#closing;
  }
}
