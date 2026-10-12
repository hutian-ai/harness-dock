import type { AcpRuntimeEvent } from 'acpx/runtime';

/** The execution owner retains admission, run persistence and business authorization. */
export interface HarnessExecutionInput {
  runId: string;
  prompt: string;
  resumeThreadId?: string;
  previousRunId?: string;
  signal: AbortSignal;
  onReady(sessionId: string): Promise<void>;
  onEvent(event: AcpRuntimeEvent): Promise<void>;
  permission?(request: { id: string; title: string; details: unknown; canAllow: boolean }, signal: AbortSignal, responseSent: Promise<void>): Promise<'allow' | 'deny'>;
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
