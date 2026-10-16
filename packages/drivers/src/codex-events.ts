import type { AcpRuntimeEvent } from 'acpx/runtime';

type StandardEvent = Exclude<AcpRuntimeEvent, { type: 'session_update' }>;
type MessagePhase = 'commentary' | 'final_answer';

export type CodexTokens = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number };
export type CodexMessage = { id: string; phase: MessagePhase | null; text: string };
export type CodexEvent = Exclude<StandardEvent, { type: 'text_delta' }>
  | (Extract<StandardEvent, { type: 'text_delta' }> & { phase?: MessagePhase })
  | { type: 'message_completed'; messageId: string; providerTurnId: string; phase: MessagePhase | null; text: string }
  | ({ type: 'codex_event'; threadId: string; turnId: string } & (
    { kind: 'turn_started' }
    | { kind: 'item'; stage: 'started' | 'completed'; item: Record<string, unknown> }
    | { kind: 'diff'; diff: string | null }
    | { kind: 'usage'; total: CodexTokens }
  ));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
const messagePhase = (value: unknown): MessagePhase | null => value === 'commentary' || value === 'final_answer' ? value : null;

function dockMessageMeta(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const extension = isRecord(payload._meta) ? payload._meta['harness-dock'] : undefined;
  return isRecord(extension) && extension.version === 1 ? extension : undefined;
}

function dockProviderEvent(payload: Record<string, unknown>): Extract<CodexEvent, { type: 'codex_event' }> | null {
  const event = dockMessageMeta(payload)?.event;
  if (!isRecord(event) || typeof event.threadId !== 'string' || typeof event.turnId !== 'string') return null;
  const base = { type: 'codex_event' as const, threadId: event.threadId, turnId: event.turnId };
  if (event.kind === 'turn_started') return { ...base, kind: event.kind };
  if (event.kind === 'item' && (event.stage === 'started' || event.stage === 'completed') && isRecord(event.item)
    && typeof event.item.id === 'string' && typeof event.item.type === 'string'
    && ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange', 'reasoning'].includes(event.item.type)) {
    return { ...base, kind: 'item', stage: event.stage, item: event.item };
  }
  if (event.kind === 'diff' && (event.diff === null || typeof event.diff === 'string')) return { ...base, kind: event.kind, diff: event.diff };
  if (event.kind === 'usage' && isRecord(event.total)) {
    const total = {} as CodexTokens;
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const) {
      const n = event.total[key];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
      total[key] = n;
    }
    return { ...base, kind: event.kind, total };
  }
  return null;
}

function completedMessageEvent(payload: Record<string, unknown>): Extract<CodexEvent, { type: 'message_completed' }> | null {
  const message = dockMessageMeta(payload)?.messageCompleted;
  if (!isRecord(message)) return null;
  const messageId = optionalString(message.messageId);
  const providerTurnId = optionalString(message.providerTurnId);
  if (!messageId || !providerTurnId || typeof message.text !== 'string') return null;
  return { type: 'message_completed', messageId, providerTurnId, phase: messagePhase(message.phase), text: message.text };
}

/** Decode only the named extension; raw updates never escape into device observations. */
export function decodeCodexEvent(event: AcpRuntimeEvent): CodexEvent | null {
  if (event.type !== 'session_update') return event;
  const { update, event: standard } = event;
  if (update.sessionUpdate === 'session_info_update') return dockProviderEvent(update) ?? completedMessageEvent(update) ?? standard;
  if (standard?.type === 'text_delta' && (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')) {
    const phase = messagePhase(dockMessageMeta(update)?.phase);
    if (phase) return { ...standard, phase };
  }
  return standard;
}

/** Retain the runtime queue order and its stream-close/cancellation behavior. */
export async function* decodeCodexEvents(events: AsyncIterable<AcpRuntimeEvent>): AsyncGenerator<CodexEvent> {
  for await (const event of events) {
    const decoded = decodeCodexEvent(event);
    if (decoded) yield decoded;
  }
}
