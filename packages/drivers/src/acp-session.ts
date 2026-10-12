import {
  PROTOCOL_VERSION,
  type NewSessionRequest,
  type LoadSessionResponse,
  type LoadSessionRequest,
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
  type NewSessionResponse,
  type StopReason,
  type Usage,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import {
  startProtocolProcess,
  captureProtocolStderr,
  closeProtocolProcess,
  type ProtocolProcess,
} from "./process-command.ts";
import { acpFileChangeEvent } from "./acp-file-changes.ts";
import {
  createProtocolWaiter,
  protocolFailureResult,
} from "./protocol-operation.ts";
import type { AcpExecutionInput, AcpExecutionResult } from "./acp-types.ts";
import { createMcpBridge } from "./mcp-bridge.ts";
import { AnswerBudget } from './output-limits.ts';

type AcpProvider = {
  source: string;
  label: string;
  stopErrorPrefix: string;
};

type AcpCommand = {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
};

type SessionConfiguration = {
  agent: ClientConnection["agent"];
  awaitAcp: <T>(
    operation: Promise<T>,
    label: string,
    timeoutMs?: number | null,
  ) => Promise<T>;
  sessionId: string;
  session: Omit<NewSessionResponse, "sessionId">;
  resumed: boolean;
};

function usageRecord(
  usage: Usage | null | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const entries = Object.entries(usage).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resultFromStopReason(
  prefix: string,
  reason: StopReason,
  cancellationRequested: boolean,
  text: string,
  usage?: Record<string, number>,
): Pick<AcpExecutionResult, "state" | "text" | "usage" | "errorCode"> {
  if (reason === "end_turn") return { state: "completed", text, usage };
  if (reason === "cancelled" && cancellationRequested)
    return { state: "cancelled", text, usage };
  return { state: "failed", errorCode: `${prefix}_${reason}`, text, usage };
}

export async function runAcpSession<TDelivery>(
  options: AcpExecutionInput<TDelivery> & {
    provider: AcpProvider;
    prepareCommand: () => AcpCommand | Promise<AcpCommand>;
    configure: (context: SessionConfiguration) => Promise<void>;
  },
): Promise<AcpExecutionResult> {
  const { cwd, callbacks, provider } = options;
  const outputAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, outputAbort.signal]);
  const outputBudget = new AnswerBudget();
  const errorPrefix = provider.source.replaceAll("-", "_");
  const cancellationRequested = () =>
    options.cancellationRequested?.() ?? options.signal.aborted;
  let child: ProtocolProcess | null = null;
  let sessionId: string | null = null;
  let acceptAgentMessageChunks = false;
  let finalMessage = "";
  let readStderr = () => "";
  let callbackError: unknown = null;
  let promptDispatched = false;
  let onAbort: (() => void) | null = null;
  let bridge:
    Awaited<ReturnType<typeof createMcpBridge<TDelivery>>> | undefined;

  const permissionResponses = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  await callbacks.onStarted(options.runId);
  try {
    if (options.tools?.length) {
      if (!options.mcp) throw new Error("ACP tool callback is unavailable");
      bridge = await createMcpBridge({
        tools: options.tools,
        signal,
        invocation: options.mcp,
        name: options.mcpName,
      });
    }
    const command = await options.prepareCommand();
    const spawnedChild = startProtocolProcess(
      command.executable,
      command.args,
      {
        cwd,
        env: command.env,
      },
    );
    child = spawnedChild;
    readStderr = captureProtocolStderr(spawnedChild);

    const clientApp = createAcpClientApp({ name: "harness-dock" })
      .onNotification(methods.client.session.update, async ({ params }) => {
        const update = params.update;
        bridge?.acknowledgeToolUpdate(update);
        try {
          if (acceptAgentMessageChunks && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            outputBudget.add(update.content.text);
            finalMessage += update.content.text;
          }
          const fileChanges = await acpFileChangeEvent(
            provider.source,
            params.sessionId,
            update,
          );
          if (fileChanges) await callbacks.onFileChanges?.(fileChanges);
          await callbacks.onProgress({
            source: provider.source,
            sessionId: params.sessionId,
            update,
          });
        } catch (error) {
          callbackError = error;
          outputAbort.abort(error);
          throw error;
        }
      })
      .onRequest(
        methods.client.session.requestPermission,
        async ({ params, requestId, signal: requestSignal }) => {
          if (signal.aborted)
            return { outcome: { outcome: "cancelled" as const } };
          const selectedOption = params.options.find(
            (option) => option.kind === "allow_once",
          );
          const responseSent = new Promise<void>((resolve, reject) => { permissionResponses.set(JSON.stringify(requestId), { resolve, reject }); });
          void responseSent.catch(() => {});
          let decision: "allow" | "deny" = "deny";
          try {
            decision =
              (await callbacks.permission?.(
                {
                  id: randomUUID(),
                  sessionId: params.sessionId,
                  toolCall: params.toolCall,
                  canAllow: Boolean(selectedOption),
                },
                AbortSignal.any([signal, requestSignal]),
                responseSent,
              )) ?? "deny";
          } catch {
            // Failed permission callbacks cannot grant access.
          }
          await callbacks.onProgress({
            source: provider.source,
            sessionId: params.sessionId,
            permission: {
              toolCallId: params.toolCall.toolCallId,
              kind: params.toolCall.kind,
              decision:
                selectedOption && decision === "allow" && !signal.aborted
                  ? "allow_once"
                  : "cancelled",
            },
          });
          return selectedOption && decision === "allow" && !signal.aborted
            ? {
                outcome: {
                  outcome: "selected" as const,
                  optionId: selectedOption.optionId,
                },
              }
            : { outcome: { outcome: "cancelled" as const } };
        },
      );
    const transport = ndJsonStream(
      NodeWritable.toWeb(spawnedChild.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(spawnedChild.stdout) as ReadableStream<Uint8Array>,
    );
    const writer = transport.writable.getWriter();
    const connection = clientApp.connect({ readable: transport.readable, writable: new WritableStream({
      async write(message) {
        try {
          await writer.write(message);
          if ('id' in message && !('method' in message)) {
            const key = JSON.stringify(message.id);
            permissionResponses.get(key)?.resolve();
            permissionResponses.delete(key);
          }
        } catch (error) {
          for (const pending of permissionResponses.values()) pending.reject(error);
          permissionResponses.clear();
          throw error;
        }
      },
      close: () => writer.close(),
      abort: reason => writer.abort(reason),
    }) });
    const agent = connection.agent;

    const awaitAcp = createProtocolWaiter({
      signal,
      label: `${provider.label} ACP`,
      closed: connection.closed,
      exited: spawnedChild.exited,
    });
    onAbort = () => {
      if (sessionId)
        void agent
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    const initialized = await awaitAcp(
      agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "harness-dock", version: "0.1.0" },
      }),
      "initialize",
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION)
      throw new Error(
        `Unsupported ACP protocol version ${initialized.protocolVersion}`,
      );

    const supportsLoad = initialized.agentCapabilities?.loadSession === true;
    const supportsResume = initialized.agentCapabilities?.sessionCapabilities?.resume != null;
    const providerSessionResumable =
      options.allowSessionResume === true && (supportsLoad || supportsResume);
    const requestedProviderSessionId = options.allowSessionResume
      ? options.resumeSessionId
      : null;
    if (requestedProviderSessionId && !providerSessionResumable)
      throw new Error(
        `${provider.label} no longer supports loading its Provider session`,
      );
    const session = requestedProviderSessionId
      ? await awaitAcp(
          agent.request<LoadSessionResponse, LoadSessionRequest>(
            supportsLoad ? methods.agent.session.load : methods.agent.session.resume,
            {
              sessionId: requestedProviderSessionId,
              cwd,
              mcpServers: bridge ? [bridge.descriptor] : [],
            },
          ),
          "session load",
        )
      : await awaitAcp(
          agent.request<NewSessionResponse, NewSessionRequest>(
            methods.agent.session.new,
            {
              cwd,
              mcpServers: bridge ? [bridge.descriptor] : [],
            },
          ),
          "session new",
        );
    sessionId =
      requestedProviderSessionId || (session as NewSessionResponse).sessionId;
    const resumed = Boolean(requestedProviderSessionId);
    if (bridge) await awaitAcp(bridge.ready, "MCP tool discovery");
    await options.configure({ agent, awaitAcp, sessionId, session, resumed });

    if (signal.aborted)
      throw new Error(`${provider.label} was canceled before prompt dispatch`);
    acceptAgentMessageChunks = true;
    promptDispatched = true;
    const promptResult = await awaitAcp(
      agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: options.prompt }],
      }),
      "prompt",
      null,
    );
    if (callbackError) throw callbackError;
    const usage = usageRecord(promptResult.usage);
    const result = resultFromStopReason(
      provider.stopErrorPrefix,
      promptResult.stopReason,
      cancellationRequested(),
      finalMessage,
      usage,
    );
    return {
      ...result,
      sessionId,
      resumable: providerSessionResumable,
      resumed,
    };
  } catch (error) {
    if (callbackError) throw callbackError;
    return protocolFailureResult(
      error,
      cancellationRequested(),
      promptDispatched,
      {
        errorPrefix,
        stderr: readStderr(),
        sessionId,
        text: finalMessage,
      },
    );
  } finally {
    for (const pending of permissionResponses.values()) pending.reject(new Error("permission_transport_closed"));
    permissionResponses.clear();
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (child) await closeProtocolProcess(child);
    await bridge?.close();
  }
}
