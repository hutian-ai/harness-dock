import type { CodexEvent } from './codex-events.ts';
import type { ElicitationContentValue } from '@agentclientprotocol/sdk';

export type NativeInteractionResponse = { optionId: string } | { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export interface NativePermissionRequest {
  id: string; title: string; details: unknown; canAllow: boolean;
  options?: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
  form?: { mode: 'form'; message: string; requestedSchema: Record<string, unknown> } | { mode: 'url'; message: string; url: string; elicitationId: string };
}
export type NativePermissionDecision = 'allow' | 'deny' | NativeInteractionResponse;

export function nativeElicitationForm(request: unknown): NativePermissionRequest['form'] | undefined {
  if (!request || typeof request !== 'object') return;
  const raw = request as Record<string, unknown>;
  if (typeof raw.message !== 'string') return;
  if (raw.mode === 'form' && raw.requestedSchema && typeof raw.requestedSchema === 'object' && !Array.isArray(raw.requestedSchema))
    return { mode: 'form', message: raw.message, requestedSchema: raw.requestedSchema as Record<string, unknown> };
  if (raw.mode === 'url' && typeof raw.url === 'string' && typeof raw.elicitationId === 'string')
    return { mode: 'url', message: raw.message, url: raw.url, elicitationId: raw.elicitationId };
}

/** Callers fence the active turn and signal before mapping a native answer. */
export function nativeElicitationResponse(decision: NativePermissionDecision | undefined):
  { action: 'cancel' | 'decline' } | { action: 'accept'; content?: Record<string, ElicitationContentValue> } {
  if (!decision || typeof decision !== 'object' || !('action' in decision)) return { action: 'cancel' };
  return decision.action === 'accept'
    ? { action: 'accept', content: decision.content as Record<string, ElicitationContentValue> | undefined }
    : { action: decision.action };
}

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
