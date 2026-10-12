import { randomUUID } from 'node:crypto';
import { RunStore } from './store.ts';
import {
  applyEvent,
  DockError,
  terminal,
  unsupported,
  VERSION,
  type Decision,
  type PermissionInput,
  type Probe,
  type RunChange,
  type RunEvent,
  type RunSnapshot,
  type OutputEvent,
  type StartInput,
} from '@harness-dock/protocol';
import type { HarnessExecutor, HarnessExecutionInput } from '@harness-dock/drivers';

type PermissionRequest = Parameters<NonNullable<HarnessExecutionInput['permission']>>[0];

interface Pending {
  runId: string;
  finish(decision: Decision): void;
}
interface RecordEntry {
  snapshot: RunSnapshot;
  controller: AbortController;
  work?: Promise<void>;
}
export class Engine {
  readonly daemonId = randomUUID();
  readonly nodeId: string;
  private readonly store: RunStore;
  private sessionId?: string;
  private providerThreadId?: string;
  private previousRunId?: string;
  private activeRunId?: string;
  private readonly runs = new Map<string, RecordEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private stopping = false;
  constructor(private readonly driver: HarnessExecutor, options: { nodeId?: string; stateDir?: string; } = {}) {
    this.nodeId = options.nodeId ?? randomUUID();
    this.store = new RunStore(this.nodeId, options.stateDir);
  }
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async probe(): Promise<Probe> {
    return {
      nodeId: this.nodeId,
      daemonId: this.daemonId,
      protocolVersion: VERSION,
      activeRunId: this.activeRunId,
      sessionId: this.sessionId,
      backend: await this.driver.inspect(AbortSignal.timeout(30_000)),
      unsupported: [...unsupported, ...this.driver.unsupported ?? []],
    };
  }
  getRun(runId: string): RunSnapshot {
    const entry = this.runs.get(runId) ?? this.store.get(runId);
    if (!entry) throw new DockError('run_not_found');
    return structuredClone(entry.snapshot);
  }
  start(input: StartInput): RunSnapshot {
    const identity = JSON.stringify([input.sessionId ?? null, input.prompt]);
    const existing = this.store.get(input.runId);
    if (existing) {
      if (existing.input !== identity) throw new DockError('identity_conflict');
      return this.getRun(input.runId);
    }
    if (this.stopping) throw new DockError('stopping');
    if (this.activeRunId) throw new DockError('busy');
    if (input.sessionId && input.sessionId !== this.sessionId)
      throw new DockError(
        'session_unavailable',
        'Resume requires this daemon’s exact current sessionId',
      );
    const sessionId = input.sessionId ?? randomUUID();
    const entry: RecordEntry = {
      controller: new AbortController(),
      snapshot: {
        nodeId: this.nodeId,
        daemonId: this.daemonId,
        sessionId,
        runId: input.runId,
        sequence: 0,
        state: 'running',
        output: '',
        messages: [],
        finalAnswer: null,
        permissions: [],
        tools: [],
      },
    };
    this.store.admit(identity, entry.snapshot);
    this.sessionId = sessionId;
    this.runs.set(input.runId, entry);
    this.activeRunId = input.runId;
    entry.work = this.execute(input, entry);
    return this.getRun(input.runId);
  }
  listRuns(limit = 50, offset = 0) { return this.store.list(limit, offset); }
  private emit(runId: string, change: RunChange): void {
    const entry = this.runs.get(runId)!;
    const snapshot = structuredClone(entry.snapshot);
    const event: RunEvent = {
      daemonId: this.daemonId,
      runId,
      sequence: snapshot.sequence + 1,
      change,
    };
    applyEvent(snapshot, event);
    try { this.store.save(snapshot); } catch (error) { this.stopping = true; throw error; }
    entry.snapshot = snapshot;
    for (const listener of this.listeners) listener(structuredClone(event));
  }
  private async execute(input: StartInput, entry: RecordEntry): Promise<void> {
    try {
      if (!input.sessionId && this.providerThreadId) {
        await this.driver.close();
        this.providerThreadId = undefined;
        this.previousRunId = undefined;
      }
      if (input.sessionId && !this.providerThreadId) throw new Error('provider_session_unavailable');
      const result = await this.driver.execute({
        runId: input.runId, prompt: input.prompt,
        resumeThreadId: this.providerThreadId, previousRunId: this.previousRunId,
        signal: entry.controller.signal,
        onReady: async threadId => { this.providerThreadId = threadId; },
        permission: (request, signal) => this.ask(input.runId, request, signal),
        onEvent: async event => {
          let output: OutputEvent | undefined;
          if (event.type === 'text_delta') output = { type: event.stream === 'thought' ? 'thought' : 'text', text: event.text, messageId: event.messageId, phase: event.phase };
          else if (event.type === 'message_completed') output = event;
          else if (event.type === 'tool_call') output = { type: 'tool', text: event.text, details: event };
          else if (event.type === 'status') output = { type: 'status', text: event.text, details: event };
          if (output) this.emit(input.runId, { type: 'output', output });
        },
      });
      if (result.state === 'completed') this.previousRunId = input.runId;
      this.expire(input.runId);
      this.emit(input.runId, { type: 'state', state: result.state === 'unknown' ? 'outcome_unknown' : result.state, stopReason: result.stopReason, error: result.error });
    } catch (error) {
      this.expire(input.runId);
      try {
        this.emit(input.runId, {
          type: 'state',
          state: 'outcome_unknown',
          error: error instanceof Error ? error.message : 'driver_error',
        });
      } catch {
        entry.snapshot.state = 'outcome_unknown';
        entry.snapshot.permissions = [];
        entry.snapshot.finalAnswer = null;
        entry.snapshot.error = 'Observation storage failed; daemon must stop.';
      }
    } finally {
      // Unknown work may still own Provider side effects; do not admit another turn.
      if (entry.snapshot.state !== 'outcome_unknown') {
        this.activeRunId = undefined;
        this.runs.delete(input.runId);
      }
    }
  }
  private ask(runId: string, request: PermissionRequest, signal: AbortSignal): Promise<Decision> {
    if (this.stopping || signal.aborted || this.runs.get(runId)?.snapshot.state !== 'running')
      return Promise.resolve('deny');
    return new Promise((resolve) => {
      const permissionId = randomUUID();
      const abort = () => finish('deny');
      const finish = (decision: Decision) => {
        if (!this.pending.delete(permissionId)) return;
        signal.removeEventListener('abort', abort);
        try {
          this.emit(runId, { type: 'permission_closed', permissionId });
          resolve(decision);
        } catch { resolve('deny'); }
      };
      this.pending.set(permissionId, { runId, finish });
      signal.addEventListener('abort', abort, { once: true });
      try { this.emit(runId, { type: 'permission', permission: { title: request.title, details: request.details, canAllow: request.canAllow, runId, permissionId } }); }
      catch { finish('deny'); }
    });
  }
  respondPermission(input: PermissionInput): RunSnapshot {
    if (this.stopping) throw new DockError('stopping');
    const pending = this.pending.get(input.permissionId);
    const snapshot = this.getRun(input.runId);
    if (!pending || pending.runId !== input.runId || snapshot.state !== 'running')
      throw new DockError('permission_expired');
    if (
      input.decision === 'allow' &&
      !snapshot.permissions.find((p) => p.permissionId === input.permissionId)?.canAllow
    )
      throw new DockError('allow_once_unavailable');
    pending.finish(input.decision);
    if (this.stopping) throw new DockError('storage_unavailable');
    return this.getRun(input.runId);
  }
  private expire(runId: string): void {
    for (const pending of this.pending.values())
      if (pending.runId === runId) pending.finish('deny');
  }
  async cancel(runId: string): Promise<RunSnapshot> {
    const entry = this.runs.get(runId);
    if (!entry) return this.getRun(runId);
    if (!terminal(entry.snapshot.state)) {
      this.emit(runId, { type: 'state', state: 'cancel_requested' });
      this.expire(runId);
      entry.controller.abort();
    }
    return this.getRun(runId);
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    try {
      if (this.activeRunId) await this.cancel(this.activeRunId).catch(() => { });
      await Promise.all([...this.runs.values()].map(entry => entry.work));
      await this.driver.close();
    } finally { this.store.close(); }
  }
}
