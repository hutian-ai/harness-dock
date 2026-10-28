/** Public JSON contracts. No provider implementation or application domain types. */
export type DeviceExecutionState = 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export interface DeviceProviderCapabilities {
  protocol: 'acp';
  sessionResume: 'native' | 'unsupported';
  resultQuery: 'native' | 'unsupported';
  exactFinalAnswer: boolean;
  callerSkills: boolean;
  permissionInteractions: readonly ('options' | 'form' | 'url')[];
  desktopTools: 'connected' | 'disabled' | 'unavailable' | 'not_reported';
  browser: 'unverified';
}
export interface DeviceProvider {
  /** Discovered by the device. This string does not authorize arbitrary commands. */
  key: string;
  displayName: string;
  status: 'ready' | 'not_found' | 'unavailable' | 'disabled';
  version: string | null;
  models: string[];
  inspection?: unknown;
  error?: string;
  readiness?: { level: 'protocol'; checkedAt: string; modelExecutionVerified: false };
  capabilities?: DeviceProviderCapabilities;
  sessionResumeMode: 'native' | 'unsupported';
}
export interface DeviceInventory {
  nodeId: string;
  daemonId: string;
  workdir: string;
  platform: { platform: string; arch: string; release: string; hostname: string };
  activeRunIds: string[];
  unresolvedRunIds: string[];
  resources: Record<string, number>;
  providers: DeviceProvider[];
}
export interface DeviceFile { path: string; contentBase64: string; executable?: boolean }
export interface DeviceOutput { reference: string; name: string; sha256: string; contentBase64: string }
export interface DevicePreparedDirectories { workdir: string; skillDirectory: string; outputDirectory: string }
export interface DeviceToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}
export interface DeviceToolCall { callId: string; name: string; arguments: Record<string, unknown> }
export interface DeviceToolResult { content: unknown; isError?: boolean; deliveryContext?: unknown }
export interface DevicePermissionRequest {
  id: string; title: string; details: unknown; canAllow: boolean;
  options?: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
  form?: { mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
    | { mode: 'url'; message: string; url: string; elicitationId: string };
}
export type DevicePermissionDecision = 'allow' | 'deny' | { optionId: string }
  | { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export interface DeviceExecuteInput {
  provider: string; runId: string; sessionKey?: string; prompt: string; model?: string;
  config?: Record<string, unknown>; resumeSessionId?: string; previousRunId?: string; retainSession?: boolean;
  tools?: { name: string; definitions: DeviceToolDefinition[] };
}
/** Native details remain provider-specific; state is the shared completion boundary. */
export interface DeviceExecutionResult {
  state: Exclude<DeviceExecutionState, 'running'>;
  [nativeDetail: string]: unknown;
}
export interface DeviceExecutionResponse { provider: string; result: DeviceExecutionResult }
export interface DeviceExecutionSnapshot {
  runId: string; provider: string; state: DeviceExecutionState; result?: DeviceExecutionResult;
  detailsExpired: boolean; historyTruncated: boolean;
}
export interface DeviceExecutionEvent { sequence: number; kind: string; payload: unknown }
type Callback<K extends string, P> = { runId: string; kind: K; payload: P };
export type DeviceExecutionCallback =
  | Callback<'ready', { sessionId?: string }>
  | Callback<'permission', DevicePermissionRequest>
  | Callback<'permissionDelivered', { id: string; decision: DevicePermissionDecision; success: boolean }>
  | Callback<'toolCall', DeviceToolCall>
  | Callback<'toolDelivery', { callId: string; status: 'delivered' | 'unknown'; context: unknown }>
  | Callback<'steering', { available: boolean }>
  | Callback<'event' | 'progress' | 'fileChanges' | 'historyTruncated', Record<string, unknown>>;
export type DeviceExecutionCallbackResult = DevicePermissionDecision | DeviceToolResult | null | void;

/** Existing wire methods; unknown completion stays unknown and mutations are never replayed. */
export interface DeviceRequestMap {
  inventory: { params: { refresh?: boolean }; result: DeviceInventory };
  prepare: { params: { runId: string; sessionKey?: string; files?: DeviceFile[] }; result: DevicePreparedDirectories };
  execute: { params: DeviceExecuteInput; result: DeviceExecutionResponse };
  getExecution: { params: { runId: string }; result: DeviceExecutionSnapshot | null };
  events: { params: { runId: string; after?: number }; result: DeviceExecutionEvent[] };
  /** null means no confirmed native evidence (including unsupported native query). */
  /** Legacy context hints are accepted but ignored; the persisted run selects its provider/context. */
  reconcile: { params: { runId: string; provider?: string; sessionKey?: string }; result: DeviceExecutionResponse | null };
  cancel: { params: { runId: string }; result: { requested: boolean; state?: DeviceExecutionState | null } };
  steer: { params: { runId: string; text: string }; result: 'accepted' | 'rejected' | 'unknown' };
  collect: { params: { runId: string }; result: DeviceOutput[] };
  release: { params: { runId: string }; result: null };
  forgetSession: { params: { sessionKey: string }; result: { runIds: string[] } };
}
export type DeviceMethod = keyof DeviceRequestMap;
export type DeviceRequestParams<M extends DeviceMethod> = DeviceRequestMap[M]['params'];
export type DeviceRequestResult<M extends DeviceMethod> = DeviceRequestMap[M]['result'];
export type DeviceRequestArgs<M extends DeviceMethod> = {} extends DeviceRequestParams<M>
  ? [params?: DeviceRequestParams<M>, timeoutMs?: number]
  : [params: DeviceRequestParams<M>, timeoutMs?: number];
