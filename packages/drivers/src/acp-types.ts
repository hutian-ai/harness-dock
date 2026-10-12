import type { McpInvocation, McpToolDefinition } from "./mcp-bridge.ts";
import type { runBoundedCommand } from "./process-command.ts";

export type ProbeCommand = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
) => ReturnType<typeof runBoundedCommand>;
export class AcpProbeError extends Error {
  readonly status: "protocol_error" | "unsupported_version";
  constructor(
    status: "protocol_error" | "unsupported_version",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "AcpProbeError";
    this.status = status;
  }
}
export type AcpReportedFileChange = Readonly<{
  path: string;
  beforeText: string | null;
  afterText: string | null;
}>;
export type AcpFileChangeEvent = Readonly<{
  kind: "delta";
  eventKey: string;
  changes: readonly AcpReportedFileChange[];
}>;
export interface AcpInspection {
  version: string;
  protocolVersion: number;
  models: string[];
  modes: string[];
  loadSession: boolean;
  resumeSession: boolean;
  mcpTools: boolean;
  reasoningEffortsByModel: Record<string, string[]>;
  permissionPresets: string[];
}
export interface AcpPermissionRequest {
  id: string;
  sessionId: string;
  toolCall: unknown;
  canAllow: boolean;
}
export interface AcpExecutionCallbacks {
  /** Persist the owner's admission fence before process execution. */
  onStarted(runId: string): Promise<void>;
  onProgress(payload: Record<string, unknown>): Promise<void>;
  onFileChanges?(event: AcpFileChangeEvent): Promise<void>;
  permission?(
    request: AcpPermissionRequest,
    signal: AbortSignal,
    responseSent: Promise<void>,
  ): Promise<"allow" | "deny">;
}
export interface AcpExecutionInput<TDelivery = unknown> {
  runId: string;
  cwd: string;
  prompt: string;
  model: string;
  config: Record<string, unknown>;
  signal: AbortSignal;
  resumeSessionId?: string;
  allowSessionResume?: boolean;
  skillDirectory?: string;
  tools?: readonly McpToolDefinition[];
  mcp?: McpInvocation<TDelivery>;
  mcpName?: string;
  /** Distinguishes requested cancellation from shutdown/lease loss in an embedding owner. */
  cancellationRequested?(): boolean;
  callbacks: AcpExecutionCallbacks;
}
export interface AcpExecutionResult {
  state: "completed" | "cancelled" | "failed" | "unknown";
  sessionId: string | null;
  resumable: boolean;
  resumed: boolean;
  text: string;
  usage?: Record<string, number>;
  errorCode?: string;
  message?: string;
  stderr?: string;
}
export interface AcpExecutor {
  probe(signal?: AbortSignal): Promise<AcpInspection>;
  execute<TDelivery = unknown>(
    input: AcpExecutionInput<TDelivery>,
  ): Promise<AcpExecutionResult>;
}
export const ACP_PROBE_TOOLS: McpToolDefinition[] = [
  {
    name: "synthetic_search",
    description: "Synthetic tool used only to verify tool discovery",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];
