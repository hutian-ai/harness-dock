import { randomUUID } from "node:crypto";
import { AGENT_PROCESS_ENV_ALLOW } from "./agent-environment.ts";
import { createAcpRuntime, createAgentRegistry, type AcpSessionRecord } from "acpx/runtime";
import { PROTOCOL_VERSION, type SessionConfigOption, type SessionModeState, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpExecutionInput, AcpExecutionResult } from "./acp-types.ts";
import { acpFileChangeEvent } from "./acp-file-changes.ts";
import { protocolFailureResult, raceWithSignalAndTimeout } from "./protocol-operation.ts";
import { createMcpBridge } from "./mcp-bridge.ts";
import { AnswerBudget } from "./output-limits.ts";
import { nativeElicitationForm, nativeElicitationResponse, nativePermissionOption, type NativePermissionDecision } from "./execution.ts";

type SessionConfiguration = {
  sessionId: string;
  session: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null };
  resumed: boolean;
  setMode(mode: string): Promise<void>;
  setConfigOption(key: string, value: string): Promise<{ configOptions?: SessionConfigOption[] | null }>;
};

/** ACPX owns processes, protocol, turns and permission response transport.
 * Each invocation cold-loads an explicit native session. Runtime records are
 * ephemeral; the Daemon retains admission, execution facts and session identity.
 */
export async function runAcpSession<TDelivery>(
  options: AcpExecutionInput<TDelivery> & {
    provider: { source: string; label: string; stopErrorPrefix: string };
    prepareCommand: () => { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv } | Promise<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
    configure(context: SessionConfiguration): Promise<void>;
  },
): Promise<AcpExecutionResult> {
  const { callbacks, provider } = options;
  const outputAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, outputAbort.signal]);
  const cancellationRequested = () => options.cancellationRequested?.() ?? options.signal.aborted;
  const budget = new AnswerBudget();
  let sessionId: string | null = null;
  let dispatched = false;
  let text = "";
  let callbackError: unknown;
  let record: AcpSessionRecord | undefined;
  let runtime: ReturnType<typeof createAcpRuntime> | undefined;
  let bridge: Awaited<ReturnType<typeof createMcpBridge<TDelivery>>> | undefined;
  const wait = <T>(operation: Promise<T>, phase: string, timeoutMs: number | null = 15_000, abortGraceMs = timeoutMs === null ? 5_000 : 0) =>
    raceWithSignalAndTimeout(operation, {
      signal, label: `${provider.label} ${phase}`, timeoutMs,
      abortGraceMs,
    });

  await callbacks.onStarted(options.runId);
  try {
    signal.throwIfAborted();
    if (options.tools?.length) {
      if (!options.mcp) throw new Error("ACP tool callback is unavailable");
      bridge = await createMcpBridge({ tools: options.tools, signal, invocation: options.mcp, name: options.mcpName });
    }
    const command = await options.prepareCommand();
    signal.throwIfAborted();
    runtime = createAcpRuntime({
      cwd: options.cwd,
      agentRegistry: createAgentRegistry({ overrides: { [provider.source]: [command.executable, ...command.args] } }),
      agentProcessEnvAllow: AGENT_PROCESS_ENV_ALLOW,
      agentProcessEnv: Object.fromEntries(Object.entries(command.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      sessionStore: {
        load: async id => record?.acpxRecordId === id ? structuredClone(record) : undefined,
        save: async value => { record = structuredClone(value); },
      },
      mcpServers: bridge ? [bridge.descriptor] : [],
      permissionMode: "deny-all", nonInteractivePermissions: "deny", fs: false, terminal: false,
      elicitationModes: ["form", "url"],
      timeoutMs: 15_000,
      processLifecycle: { onBeforeSpawn: () => signal.throwIfAborted() },
    });
    // ACPX bounds initialize and new/load/resume separately. A single outer
    // deadline would spend the resume budget on starting the native process.
    const handle = await wait(runtime.ensureSession({
      sessionKey: randomUUID(), agent: provider.source, cwd: options.cwd, mode: "persistent",
      resumeSessionId: options.allowSessionResume ? options.resumeSessionId : undefined,
    }), "session setup", null, 0);
    if (record?.protocolVersion !== PROTOCOL_VERSION)
      throw new Error(`Unsupported ACP protocol version ${record?.protocolVersion}`);
    sessionId = handle.backendSessionId ?? null;
    if (!sessionId || (options.allowSessionResume && options.resumeSessionId && sessionId !== options.resumeSessionId))
      throw new Error(`${provider.label} Provider session identity mismatch`);
    const resumed = options.allowSessionResume === true && Boolean(options.resumeSessionId);
    const capabilities = record?.agentCapabilities;
    const resumable = options.allowSessionResume === true &&
      (capabilities?.loadSession === true || capabilities?.sessionCapabilities?.resume != null);
    if (resumed && !resumable) throw new Error(`${provider.label} no longer supports loading its Provider session`);
    if (bridge) await wait(bridge.ready, "MCP tool discovery");
    const status = await wait(runtime.getStatus({ handle }), "session metadata");
    const activeRuntime = runtime;
    await options.configure({
      sessionId, resumed,
      session: {
        configOptions: status.details?.configOptions as SessionConfigOption[] | undefined,
        modes: status.details?.modes as SessionModeState | null | undefined,
      },
      setMode: mode => wait(activeRuntime.setMode({ handle, mode, signal }), "mode configuration"),
      // Validate the actual acknowledgement, not ACPX's optimistic saved selection.
      setConfigOption: (key, value) => wait(activeRuntime.setConfigOption({ handle, key, value, signal }), "configuration") as Promise<{ configOptions?: SessionConfigOption[] | null }>,
    });
    signal.throwIfAborted();
    const turn = runtime.startTurn({
      handle, requestId: options.runId, text: options.prompt, mode: "prompt", signal,
      rawSessionUpdates: true, timeoutMs: 0,
      onPermissionRequest: async (request, context) => {
        let decision: NativePermissionDecision | undefined;
        try {
          decision = await callbacks.permission?.({
            id: randomUUID(), sessionId: request.sessionId, toolCall: request.raw.toolCall,
            title: request.raw.toolCall.title ?? `${provider.label} permission`,
            canAllow: request.raw.options.filter(option => option.kind === "allow_once").length === 1,
            options: request.raw.options,
          }, context.signal, context.responseSent);
        } catch { /* Callback failure cannot grant access. */ }
        const option = nativePermissionOption(request.raw.options, decision);
        await callbacks.onProgress({
          source: provider.source, sessionId: request.sessionId,
          permission: {
            toolCallId: request.raw.toolCall.toolCallId, kind: request.raw.toolCall.kind,
            optionId: option?.optionId,
            decision: option && !signal.aborted && !context.signal.aborted ? option.kind : "cancelled",
          },
        });
        return option && !signal.aborted && !context.signal.aborted
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancel" };
      },
      onElicitation: async (request, context) => {
        const form = nativeElicitationForm(request);
        if (!form) return { action: "cancel" };
        let decision: NativePermissionDecision | undefined;
        try {
          decision = await callbacks.permission?.({
            id: randomUUID(), sessionId: sessionId!, toolCall: {},
            title: form.message.slice(0, 200), canAllow: true, form,
          }, context.signal, context.responseSent);
        } catch { /* A missing or failed answer cannot accept an elicitation. */ }
        return nativeElicitationResponse(signal.aborted || context.signal.aborted ? undefined : decision);
      },
    });
    void turn.promptStarted.then(() => { dispatched = true; }, () => {});
    const events = (async () => {
      try {
        for await (const event of turn.events) {
          if (event.type !== "session_update") continue;
          const update = event.update as SessionUpdate;
          bridge?.acknowledgeToolUpdate(update);
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            budget.add(update.content.text);
            text += update.content.text;
          }
          const changes = await acpFileChangeEvent(provider.source, event.sessionId, update);
          if (changes) await callbacks.onFileChanges?.(changes);
          await callbacks.onProgress({ source: provider.source, sessionId: event.sessionId, update });
        }
      } catch (error) {
        callbackError = error;
        outputAbort.abort(error);
      }
    })();
    const [result] = await wait(Promise.all([turn.result, events]), "prompt", null);
    if (callbackError) throw callbackError;
    if (result.status === "failed") throw new Error(result.error.message);
    // ACPX labels every non-cancelled stop reason completed. Only end_turn is success here.
    const state = result.stopReason === "end_turn" ? "completed"
      : result.stopReason === "cancelled" && cancellationRequested() ? "cancelled" : "failed";
    const usage = record ? usageRecord(record.cumulative_token_usage) : undefined;
    return {
      state, sessionId, resumed, resumable, text, usage,
      ...(state === "failed" ? { errorCode: `${provider.stopErrorPrefix}_${result.stopReason ?? result.status}` } : {}),
    };
  } catch (error) {
    if (callbackError) throw callbackError;
    return protocolFailureResult(error, cancellationRequested(), dispatched, {
      errorPrefix: provider.source.replaceAll("-", "_"), stderr: "", sessionId, text,
    });
  } finally {
    try { await runtime?.shutdown(); }
    finally { await bridge?.close(); }
  }
}

function usageRecord(usage: AcpSessionRecord["cumulative_token_usage"]): Record<string, number> | undefined {
  const names = {
    input_tokens: "inputTokens", output_tokens: "outputTokens", thought_tokens: "thoughtTokens",
    cache_creation_input_tokens: "cachedWriteTokens", cache_read_input_tokens: "cachedReadTokens", total_tokens: "totalTokens",
  };
  const entries = Object.entries(usage).flatMap(([key, value]) => typeof value === "number" && key in names
    ? [[names[key as keyof typeof names], value] as const] : []);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
