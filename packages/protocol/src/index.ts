import { z } from 'zod';
export * from './device.ts';
export * from './device-limits.ts';

export const VERSION = 3;
export const id = z.uuid();
export const startSchema = z
  .object({ runId: id, sessionId: id.optional(), prompt: z.string().min(1).max(100_000) })
  .strict();
export const listSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();
export type RunSummary = Pick<RunSnapshot, 'runId' | 'sessionId' | 'daemonId' | 'nodeId' | 'state'> & { finalAnswerAvailable: boolean; };
export const runSchema = z.object({ runId: id }).strict();
export const permissionSchema = z
  .object({ runId: id, permissionId: id, decision: z.enum(['allow', 'deny']) })
  .strict();
export type StartInput = z.infer<typeof startSchema>;
export type PermissionInput = z.infer<typeof permissionSchema>;
export type Decision = PermissionInput['decision'];
export type RunState =
  'running' | 'cancel_requested' | 'completed' | 'cancelled' | 'failed' | 'outcome_unknown';
export const terminal = (state: RunState): boolean =>
  !['running', 'cancel_requested'].includes(state);
export interface Permission {
  permissionId: string;
  runId: string;
  title: string;
  details: unknown;
  canAllow: boolean;
}
export type MessagePhase = 'commentary' | 'final_answer';
export interface CompletedMessage {
  messageId: string;
  providerTurnId: string;
  phase: MessagePhase | null;
  text: string;
}
export type OutputEvent =
  | {
    type: 'text' | 'thought' | 'tool' | 'status';
    text: string;
    messageId?: string;
    phase?: MessagePhase;
    details?: unknown;
  }
  | ({ type: 'message_completed'; } & CompletedMessage);
export interface RunSnapshot {
  nodeId: string;
  daemonId: string;
  sessionId: string;
  runId: string;
  sequence: number;
  state: RunState;
  output: string;
  messages: CompletedMessage[];
  /** Available only after successful turn completion; never inferred from deltas. */
  finalAnswer: CompletedMessage[] | null;
  permissions: Permission[];
  tools: OutputEvent[];
  stopReason?: string;
  error?: string;
}
export type RunChange =
  | { type: 'output'; output: OutputEvent; }
  | { type: 'permission'; permission: Permission; }
  | { type: 'permission_closed'; permissionId: string; }
  | { type: 'state'; state: RunState; stopReason?: string; error?: string; };
export interface RunEvent {
  daemonId: string;
  runId: string;
  sequence: number;
  change: RunChange;
}
export type Observation =
  | { type: 'snapshot'; snapshot: RunSnapshot; }
  | { type: 'event'; event: RunEvent; }
  | { type: 'connection'; connected: boolean; };
export interface Probe {
  nodeId: string;
  daemonId: string;
  protocolVersion: number;
  activeRunId?: string;
  sessionId?: string;
  backend: unknown;
  unsupported: string[];
}
export const unsupported = [
  'steer',
  'exact_provider_turn_lookup',
  'execution_resume_after_daemon_restart',
];
export class DockError extends Error {
  constructor(
    readonly kind: string,
    message = kind,
  ) {
    super(message);
    this.name = 'DockError';
  }
}
export function applyEvent(snapshot: RunSnapshot, event: RunEvent): void {
  if (
    snapshot.daemonId !== event.daemonId ||
    snapshot.runId !== event.runId ||
    event.sequence <= snapshot.sequence
  )
    return;
  if (event.sequence !== snapshot.sequence + 1) throw new DockError('event_gap');
  const change = event.change;
  if (change.type === 'output') {
    if (change.output.type === 'text') snapshot.output += change.output.text;
    if (change.output.type === 'tool') snapshot.tools.push(change.output);
    if (change.output.type === 'message_completed') {
      const { type: _type, ...message } = change.output;
      const previous = snapshot.messages.find(
        (m) => m.messageId === message.messageId && m.providerTurnId === message.providerTurnId,
      );
      if (previous && (previous.text !== message.text || previous.phase !== message.phase))
        throw new DockError('message_conflict');
      if (!previous) snapshot.messages.push(message);
    }
  } else if (change.type === 'permission') snapshot.permissions.push(change.permission);
  else if (change.type === 'permission_closed')
    snapshot.permissions = snapshot.permissions.filter(
      (p) => p.permissionId !== change.permissionId,
    );
  else {
    snapshot.state = change.state;
    snapshot.stopReason = change.stopReason;
    snapshot.error = change.error;
    const finals = snapshot.messages.filter((message) => message.phase === 'final_answer');
    snapshot.finalAnswer =
      change.state === 'completed' &&
        finals.length > 0 &&
        snapshot.messages.every((message) => message.phase !== null)
        ? finals
        : null;
  }
  snapshot.sequence = event.sequence;
}
export function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', '[::1]'].includes(host);
}
export function assertEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (
    !(url.protocol === 'wss:' || (url.protocol === 'ws:' && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new DockError('invalid_endpoint', 'Use verified wss:// or loopback ws:// without credentials, query or path');
}
