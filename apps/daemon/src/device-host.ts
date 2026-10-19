import { randomUUID } from 'node:crypto';
import { arch, hostname, platform, release } from 'node:os';
import { readdir } from 'node:fs/promises';
import {
  CodexHost, discoverProviders, createProviderAdapter, boundedObservation,
  type CodexHostEnvironment, type ProviderAdapter, type ProviderCapabilities, type McpInvocation,
  type McpToolDefinition, type DiscoveredProvider, type ProviderKey, type NativePermissionRequest, type NativePermissionDecision,
} from '@harness-dock/drivers';
import type { DeviceConfig } from './config.ts';
import { providerEnvironment } from './provider-environment.ts';
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
  readiness?: { level: 'protocol'; checkedAt: string; modelExecutionVerified: false };
  capabilities?: ProviderCapabilities;
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

type ActiveExecution = { sessionKey: string; provider: ProviderKey; nativeSessionId?: string; adapter: ProviderAdapter; runId: string; controller: AbortController; promise: Promise<unknown>; cancellationRequested: boolean; historyTruncated: boolean; steer?: (text: string) => Promise<'accepted' | 'rejected' | 'unknown'> };

/** Owns device processes and evidence independently of any controller connection. */
export class DeviceHost {
  readonly daemonId = randomUUID();
  readonly nodeId: string;
  readonly #store: DeviceStore;
  readonly #codex: CodexHostPort;
  readonly #createCodex: () => CodexHostPort;
  readonly #discovered = new Map<ProviderKey, DiscoveredProvider>();
  readonly #sessions = new Map<string, { sessionKey: string; provider: ProviderKey; adapter: ProviderAdapter }>();
  readonly #limits: DeviceResourceLimits;
  readonly #lifetime = new AbortController();
  readonly #adapters = new Map<ProviderKey, ProviderAdapter>();
  readonly #adapterKeys = new Map<ProviderKey, string>();
  #providers?: InventoryProvider[];
  #probing?: Promise<unknown>;
  #maintenance?: Promise<unknown>;
  #exclusiveMaintenance = false;
  #idleTimer?: NodeJS.Timeout;
  #idleGeneration = 0;
  #idleDeadline?: number;
  #closing?: Promise<void>;
  #persistenceFailed = false;
  #closed = false;
  #callback?: DeviceCallback;
  readonly #active = new Map<string, ActiveExecution>();
  constructor(readonly config: DeviceConfig, codex: CodexHostPort | (() => CodexHostPort) = () => new CodexHost()) {
    this.nodeId = config.nodeId;
    this.#createCodex = typeof codex === 'function' ? codex : () => codex;
    this.#codex = this.#createCodex();
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
    if (this.#closed || this.#maintenance || this.#active.size) return;
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
  #maintain<T>(operation: () => Promise<T>, concurrent = false): Promise<T> {
    this.#assertOpen();
    if (this.#exclusiveMaintenance || !concurrent && this.#active.size) throw new Error('busy');
    if (!concurrent) this.#exclusiveMaintenance = true;
    this.#clearIdleTimer();
    // Serialize short mutations, never the lifetime of an ACP prompt or approval.
    const pending = (this.#maintenance ?? Promise.resolve()).catch(() => {}).then(() => {
      this.#assertOpen();
      if (!concurrent && this.#active.size) throw new Error('busy');
      return operation();
    });
    this.#maintenance = pending;
    return pending.finally(() => {
      if (!concurrent) this.#exclusiveMaintenance = false;
      if (this.#maintenance === pending) this.#maintenance = undefined;
      this.#armIdleTimer();
    });
  }
  async #closeProviders(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.#adapters.values()].map(adapter => adapter.close()),
      ...[...this.#sessions.values()].map(session => session.adapter.close()),
      ...(!this.#adapters.has('codex') ? [this.#codex.close()] : []),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    this.#sessions.clear();
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async #cleanup(): Promise<void> {
    if (!this.#active.size) this.#store.expireDetails();
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
  get activeRunIds(): string[] { return [...this.#active.keys()]; }
  maintenanceStatus() { return { activeRunIds: this.activeRunIds, unresolvedRunIds: this.#store.unresolved() }; }
  /** Reserve shutdown synchronously so admission cannot race an installation change. */
  closeIfIdle(): Promise<void> {
    this.#assertOpen();
    if (this.#active.size || this.#maintenance || this.#probing) throw new Error('device_busy');
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
    const active = this.#active.get(runId);
    if (!stored && active && !active.historyTruncated) {
      active.historyTruncated = true;
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
  async inventory(refresh = false): Promise<unknown> {
    if (this.#closed) throw new Error('device_stopping');
    if (this.#probing) return this.#probing;
    if (this.#providers && (!refresh || this.#active.size)) return this.#inventory();
    this.#probing = this.#maintain(async () => {
      await this.#cleanup();
      const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(90_000)]);
      const found = await discoverProviders({ overrides: this.config.providers, signal });
      const providers: InventoryProvider[] = [];
      for (const provider of found) {
        const item: InventoryProvider = { key: provider.key, displayName: provider.displayName,
          status: provider.status === 'installed' ? 'unavailable' : provider.status, version: provider.version, models: [] };
        providers.push(item);
        this.#discovered.set(provider.key, provider);
        if (provider.status !== 'installed') {
          item.error = provider.reason;
          await this.#adapters.get(provider.key)?.close();
          this.#adapters.delete(provider.key); this.#adapterKeys.delete(provider.key);
          continue;
        }
        try {
          const environment = providerEnvironment(this.config.providers?.[provider.key]);
          const key = digest(canonical({ executable: provider.executable, home: provider.home, environment }));
          let adapter = this.#adapters.get(provider.key);
          if (!adapter || this.#adapterKeys.get(provider.key) !== key) {
            for (const [sessionKey, session] of this.#sessions) if (session.provider === provider.key) {
              await session.adapter.close(); this.#sessions.delete(sessionKey);
            }
            await adapter?.close();
            adapter = createProviderAdapter(provider, { cwd: this.config.cwd, stateDir: this.config.stateDir,
              idleTimeoutMs: this.#limits.idleTimeoutMs, environment, codex: this.#codex });
            this.#adapters.set(provider.key, adapter); this.#adapterKeys.set(provider.key, key);
          }
          const inspection = await adapter.inspect(signal);
          item.inspection = inspection.inspection; item.models = inspection.models; item.capabilities = inspection.capabilities;
          item.readiness = { level: 'protocol', checkedAt: new Date().toISOString(), modelExecutionVerified: false };
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
      activeRunIds: this.activeRunIds, unresolvedRunIds: this.#store.unresolved(), resources: this.#limits,
      providers: (this.#providers ?? []).map(provider => ({ ...provider,
        sessionResumeMode: provider.capabilities?.sessionResume ?? 'unsupported',
        ...(provider.capabilities?.sessionResume === 'warm' ? { warmSessionIdleTimeoutMs: this.#limits.idleTimeoutMs } : {}),
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
      if ([...this.#active.values()].some(active => active.sessionKey === sessionKey)) throw new Error('session_busy');
      await this.#capacity(runId);
      const directories = await prepareDirectories(this.config.stateDir, runId, sessionKey, (input.files ?? []) as DeviceFile[], this.config.cwd);
      this.#store.prepare(runId, { input: fingerprint, sessionKey, directories });
      return directories;
    }, true);
  }
  getExecution(runId: string) {
    this.#assertOpen();
    const value = this.#store.get(identity(runId));
    if (!value) return null;
    const state = value.state === 'running' && !this.#active.has(runId) ? 'unknown' : value.state;
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
      if (this.#active.has(input.runId)) return this.#active.get(input.runId)!.promise;
      return { provider: existing.provider, result: existing.result ?? { state: existing.state, error: 'unconfirmed_previous_execution' } };
    }
    const admitted = await this.#maintain(async () => {
      const duplicate = this.#store.get(input.runId);
      if (duplicate) {
        if (duplicate.input !== fingerprint) throw new Error('execution_identity_conflict');
        if (duplicate.detailsExpired) throw new Error('execution_details_expired');
        return { result: this.#active.get(input.runId)?.promise ?? Promise.resolve({ provider: duplicate.provider, result: duplicate.result ?? { state: duplicate.state, error: 'unconfirmed_previous_execution' } }) };
      }
      if (this.#active.size >= this.#limits.maxConcurrentExecutions) throw new Error('device_busy');
      const key = input.sessionKey ?? input.runId;
      if ([...this.#active.values()].some(active => active.sessionKey === key ||
        input.resumeSessionId && active.provider === input.provider && active.nativeSessionId === input.resumeSessionId)) throw new Error('session_busy');
      await this.#capacity(input.runId);
      this.#assertOpen();
      this.#store.assertSessionOpen(input.sessionKey ?? input.runId);
      const unresolved = this.#store.unresolved();
      if (unresolved.length) throw new Error(`unresolved_execution:${unresolved[0]}`);
      const prepared = this.#store.preparation(input.runId);
      if (!prepared || prepared.released || prepared.sessionKey !== (input.sessionKey ?? input.runId)) throw new Error('execution_not_prepared');
      const probeAdapter = this.#adapters.get(input.provider);
      const available = this.#providers?.find(item => item.key === input.provider);
      if (!probeAdapter || available?.status !== 'ready') throw new Error('provider_unavailable');
      if (input.model && !available.models.includes(input.model)) throw new Error('model_unavailable');
      const adapterKey = `${input.provider}:${key}`;
      let retained = this.#sessions.get(adapterKey);
      if (!retained) {
        if (this.#sessions.size >= this.#limits.maxConcurrentExecutions) {
          const idle = [...this.#sessions].find(([, session]) => ![...this.#active.values()].some(active => active.adapter === session.adapter));
          if (idle) { await idle[1].adapter.close(); this.#sessions.delete(idle[0]); }
        }
        retained = { sessionKey: key, provider: input.provider, adapter: createProviderAdapter(this.#discovered.get(input.provider)!, {
          cwd: this.config.cwd, stateDir: this.config.stateDir, idleTimeoutMs: this.#limits.idleTimeoutMs,
          environment: providerEnvironment(this.config.providers?.[input.provider]), codex: this.#createCodex(), inspection: available.inspection,
        }) };
        this.#sessions.set(adapterKey, retained);
      }
      const adapter = retained.adapter;
      const config = input.config ?? {};
      const callerSkillsPresent = (await readdir(prepared.directories.skillDirectory)).length > 0;
      adapter.validate({ model: input.model, config, resumeSessionId: input.resumeSessionId, callerSkillsPresent });
      const controller = new AbortController();
      const environment = adapter.environment({ sessionKey: prepared.sessionKey, workdir: prepared.directories.workdir,
        config, skillDirectory: prepared.directories.skillDirectory });
      const record: StoredExecution = { runId: input.runId, provider: input.provider, input: fingerprint, state: 'running', environment };
      this.#store.admit(record); // Persist before any provider process or prompt is started.
      const active = { runId: input.runId, sessionKey: key, provider: input.provider, nativeSessionId: input.resumeSessionId, adapter, controller, cancellationRequested: false, historyTruncated: false, promise: Promise.resolve<unknown>(null), steer: undefined as ((text: string) => Promise<'accepted' | 'rejected' | 'unknown'>) | undefined };
      this.#active.set(input.runId, active);
      active.promise = (async () => {
        const signal = AbortSignal.any([controller.signal, this.#lifetime.signal]);
        const observations = new ObservationWriter((kind, payload) => this.#observe(input.runId, kind, payload), signal);
        const reports = new Set<Promise<unknown>>();
        let pendingPermissions = 0;
        let started = false;
        const ready = async (sessionId?: string) => {
          if (sessionId && [...this.#active.values()].some(other => other !== active && other.provider === input.provider && other.nativeSessionId === sessionId)) throw new Error('native_session_busy');
          active.nativeSessionId = sessionId;
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
          if (this.#active.get(input.runId) !== active || signal.aborted || nativeSignal.aborted || pendingPermissions + reports.size >= 32) return 'deny';
          observations.seal();
          pendingPermissions++;
          let decision: unknown;
          try { decision = await withSignal(this.#call(input.runId, 'permission', request, 30 * 60_000), AbortSignal.any([signal, nativeSignal])); } catch { /* Fail closed. */ }
          finally { pendingPermissions--; }
          let effective: NativePermissionDecision = request.form ? { action: 'cancel' } : 'deny';
          if (!signal.aborted && !nativeSignal.aborted && this.#active.get(input.runId) === active) {
            if (request.options && decision && typeof decision === 'object' && 'optionId' in decision
              && request.options.some(option => option.optionId === decision.optionId)) effective = { optionId: String(decision.optionId) };
            else if (request.form && decision && typeof decision === 'object' && 'action' in decision
              && ['accept', 'decline', 'cancel'].includes(String(decision.action)) && Buffer.byteLength(JSON.stringify(decision)) <= 32768)
              effective = decision as NativePermissionDecision;
            else if (!request.form && (!request.options || input.provider !== 'codex')
              && (decision === 'deny' || decision === 'allow' && request.canAllow)) effective = decision;
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
          const result = await adapter.execute({ runId: input.runId, sessionKey: prepared.sessionKey,
            prompt: input.prompt, model: input.model, config, resumeSessionId: input.resumeSessionId,
            previousRunId: input.previousRunId, retainSession: input.retainSession ?? false,
            workdir: prepared.directories.workdir, skillDirectory: prepared.directories.skillDirectory, callerSkillsPresent,
            signal, cancellationRequested: () => active.cancellationRequested, tools: input.tools, invocation,
            ready, observe: (kind, payload) => observations.write(kind, payload), permission,
            steering: steer => { active.steer = steer ?? undefined; void this.#call(input.runId, 'steering', { available: Boolean(steer) }).catch(() => {}); },
          }, environment);
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
            this.#active.delete(input.runId);
            this.#idleDeadline = Date.now() + this.#limits.idleTimeoutMs;
            this.#armIdleTimer();
          }
        }
        return { provider: input.provider, result: record.result };
      })();
      return { result: active.promise };
    }, true);
    return admitted.result;
  }
  cancel(runId: string) {
    this.#assertOpen();
    identity(runId);
    const active = this.#active.get(runId);
    if (active) { active.cancellationRequested = true; active.controller.abort(new Error('cancel_requested')); return { requested: true }; }
    return { requested: false, state: this.#store.get(runId)?.state ?? null };
  }
  async steer(runId: string, text: string) {
    this.#assertOpen();
    identity(runId);
    if (typeof text !== 'string' || !text || text.length > 100_000) throw new Error('invalid_steer');
    const active = this.#active.get(runId);
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
      if (this.#active.has(runId)) throw new Error('busy');
      const prepared = this.#store.preparation(identity(runId));
      if (!prepared || prepared.released) throw new Error('preparation_not_found');
      return collectFiles(this.config.stateDir, prepared.directories.outputDirectory);
    }, true);
  }
  async release(runId: string) {
    return this.#maintain(async () => {
      if (this.#active.has(runId)) throw new Error('busy');
      const prepared = this.#store.preparation(identity(runId));
      if (!prepared || prepared.released) return null;
      const execution = this.#store.get(runId);
      if (execution?.state === 'running' || execution?.state === 'unknown') throw new Error('unresolved_execution');
      await releaseDirectories(this.config.stateDir, runId);
      this.#store.markReleased(runId);
      if (!this.#active.size) this.#store.expireDetails();
      return null;
    }, true);
  }
  async forgetSession(sessionKey: string) {
    identity(sessionKey);
    return this.#maintain(async () => {
      // Durable invalidation precedes deletion; interrupted cleanup remains safely retryable.
      const forgotten = this.#store.forgetSession(sessionKey);
      if (!this.#adapters.has('codex')) await this.#codex.close();
      for (const [key, session] of this.#sessions) if (session.sessionKey === sessionKey) {
        await session.adapter.forgetSession(sessionKey); await session.adapter.close(); this.#sessions.delete(key);
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
    for (const active of this.#active.values()) active.controller.abort(new Error('daemon_shutdown'));
    this.#closing = (async () => {
      await this.#maintenance?.catch(() => {});
      await Promise.allSettled([...this.#active.values()].map(active => active.promise));
      try { await this.#closeProviders(); } finally { this.#store.close(); }
    })();
    return this.#closing;
  }
}
