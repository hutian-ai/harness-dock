import type { CodexEvent } from './codex-events.ts';

export type NativeInteractionResponse = { optionId: string } | { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export interface NativePermissionRequest {
  id: string; title: string; details: unknown; canAllow: boolean;
  options?: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
  form?: { mode: 'form'; message: string; requestedSchema: Record<string, unknown> } | { mode: 'url'; message: string; url: string; elicitationId: string };
}
export type NativePermissionDecision = 'allow' | 'deny' | NativeInteractionResponse;

/** The execution owner retains admission, run persistence and business authorization. */
export interface HarnessExecutionInput {
  runId: string;
  prompt: string;
  resumeThreadId?: string;
  previousRunId?: string;
  signal: AbortSignal;
  onReady(sessionId: string): Promise<void>;
  onEvent(event: CodexEvent): Promise<void>;
  permission?(request: NativePermissionRequest, signal: AbortSignal, responseSent: Promise<void>): Promise<NativePermissionDecision>;
}
export interface HarnessExecutionResult {
  state: 'unknown' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  stopReason?: string;
}
export interface HarnessExecutor {
  readonly unsupported?: readonly string[];
  inspect(signal: AbortSignal): Promise<unknown>;
  execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult>;
  close(): Promise<void>;
}
