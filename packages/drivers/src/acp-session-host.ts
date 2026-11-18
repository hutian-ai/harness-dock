import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAcpRuntime, type AcpRuntimeOptions } from "acpx/runtime";
import { AcpUpdates } from "./acp-updates.ts";
import { AcpInitialization, type ImageInput } from "./acp-input.ts";
import type {
  NativePermissionDecision,
  NativePermissionRequest,
} from "./execution.ts";
import {
  createMcpBridge,
  type McpBridge,
  type McpInvocation,
  type McpToolDefinition,
} from "./mcp-bridge.ts";
import {
  AnswerBudget,
  MAX_EVIDENCE_BYTES,
  MAX_OBSERVATION_BYTES,
} from "./output-limits.ts";

export interface AcpInspection {
  promptCapabilities?: { image: boolean };
  models: { id: string; efforts: string[] }[];
  currentModelId?: string;
  configOptions: unknown[];
  sessionResume: boolean;
  mcpCapabilities: { http: boolean };
}

export interface AcpHostEnvironment {
  cwd: string;
  stateDir: string;
}
export interface AcpHostDialect<E extends AcpHostEnvironment> {
  agent: string;
  prepare(environment: E): Promise<E>;
  runtime: (
    environment: E,
    command?: string[],
    observers?: Pick<AcpRuntimeOptions, "onAcpMessage">,
  ) => ReturnType<typeof createAcpRuntime>;
  inspect(options: unknown, initialization: AcpInitialization): AcpInspection;
  effortKey?: string;
  finalMessage?: "last-on-end-turn";
}
export interface AcpEvidence {
  runId: string;
  sessionId?: string;
  state: "unknown" | "completed" | "failed" | "cancelled";
  messages: {
    id: string;
    text: string;
    phase?: "commentary" | "final_answer";
  }[];
  stopReason?: string;
  error?: string;
}
export interface AcpHostInput<
  E extends AcpHostEnvironment,
  TDelivery = unknown,
> {
  environment: E;
  runId: string;
  prompt: string;
  attachments?: ImageInput[];
  model?: string;
  effort?: string;
  mode?: string;
  resumeThreadId?: string;
  previousRunId?: string;
  retainSession: boolean;
  signal: AbortSignal;
  tools: {
    name: string;
    definitions: McpToolDefinition[];
    invocation: McpInvocation<TDelivery>;
  };
  onReady(sessionId: string): Promise<void>;
  onEvent(event: Record<string, unknown>): Promise<void>;
  permission?(
    request: NativePermissionRequest,
    signal: AbortSignal,
    responseSent: Promise<void>,
  ): Promise<NativePermissionDecision>;
}
type TurnState = {
  rpcId?: number | string;
  promptSent: boolean;
  lastContent?: "message" | "tool";
  terminal?: Pick<AcpEvidence, "state" | "stopReason" | "error">;
  tools: Map<string, Record<string, unknown>>;
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** One daemon-owned native session slot; transport lifetime does not grant turn authority. */
export class AcpSessionHost<E extends AcpHostEnvironment, TDelivery = unknown> {
  #initialization = new AcpInitialization();
  #running = false;
  #session?: {
    key: string;
    sessionKey: string;
    sessionId?: string;
    runtime: ReturnType<typeof createAcpRuntime>;
    bridge: McpBridge<TDelivery> | null;
    lifetime: AbortController;
  };
  #turn?: TurnState;
  constructor(private readonly dialect: AcpHostDialect<E>) {}
  async #release(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    session.lifetime.abort();
    try {
      await session.runtime.shutdown();
    } finally {
      await session.bridge?.close();
    }
  }
  async close(): Promise<void> {
    if (this.#running) throw new Error("dock_driver_busy");
    await this.#release();
  }
  async inspect(environment: E, signal: AbortSignal): Promise<AcpInspection> {
    signal.throwIfAborted();
    const prepared = await this.dialect.prepare(environment);
    const initialization = new AcpInitialization();
    const runtime = this.dialect.runtime(prepared, undefined, {
      onAcpMessage(direction, value) {
        initialization.observe(direction, value);
      },
    });
    const abort = () => {
      void runtime.shutdown().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const previous = await runtime.findSession({
        sessionKey: "capability-probe",
        agent: this.dialect.agent,
      });
      if (previous) await runtime.prepareFreshSession({ handle: previous });
      const handle = await runtime.ensureSession({
        sessionKey: "capability-probe",
        agent: this.dialect.agent,
        mode: "persistent",
        cwd: environment.cwd,
      });
      signal.throwIfAborted();
      const status = await runtime.getStatus({ handle, signal });
      // Model selection is a native write, not a discovery operation. Only
      // the selected model advertises its effort choices in this response.
      return this.dialect.inspect(
        status.details?.configOptions,
        initialization,
      );
    } finally {
      signal.removeEventListener("abort", abort);
      await runtime.shutdown();
    }
  }
  readonly #updates = new AcpUpdates();
  #observe(direction: string, value: unknown): void {
    this.#updates.observe(direction, value);
    const turn = this.#turn;
    if (!turn) return;
    const message = object(value);
    if (
      direction === "outbound" &&
      message.method === "session/prompt" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      turn.rpcId = message.id;
      turn.promptSent = true;
    }
    if (
      direction === "inbound" &&
      !("method" in message) &&
      turn.rpcId !== undefined &&
      message.id === turn.rpcId
    ) {
      if ("error" in message)
        turn.terminal = {
          state: "failed",
          error:
            typeof object(message.error).message === "string"
              ? String(object(message.error).message)
              : `${this.dialect.agent}_native_error`,
        };
      else if (
        [
          "end_turn",
          "max_tokens",
          "max_turn_requests",
          "refusal",
          "cancelled",
        ].includes(String(object(message.result).stopReason))
      ) {
        const stopReason = String(object(message.result).stopReason);
        turn.terminal = {
          state: stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason,
        };
      }
    }
    if (direction !== "inbound" || message.method !== "session/update") return;
    const update = object(object(message.params).update);
    if (
      !["tool_call", "tool_call_update"].includes(
        String(update.sessionUpdate),
      ) ||
      typeof update.toolCallId !== "string"
    )
      return;
    const id = update.toolCallId;
    if (update.status === "completed" || update.status === "failed")
      turn.tools.delete(id);
    else if (
      Buffer.byteLength(JSON.stringify(update), "utf8") <= MAX_OBSERVATION_BYTES
    ) {
      if (!turn.tools.has(id) && turn.tools.size >= 128)
        turn.tools.delete(turn.tools.keys().next().value!);
      turn.tools.set(id, { ...turn.tools.get(id), ...update });
    }
  }
  async execute(input: AcpHostInput<E, TDelivery>): Promise<AcpEvidence> {
    if (this.#running) throw new Error("dock_driver_busy");
    input.signal.throwIfAborted();
    this.#running = true;
    let retain = false,
      active = false;
    let evidence: AcpEvidence | undefined;
    let ownedEvidence = false;
    const turn: TurnState = (this.#turn = {
      promptSent: false,
      tools: new Map(),
    });
    const outputAbort = new AbortController();
    const signal = AbortSignal.any([
      input.signal,
      input.tools.invocation.signal,
      outputAbort.signal,
    ]);
    const answer = new AnswerBudget();
    const settledTools = new Map<string, string>();
    let target = "";
    const save = async () => {
      if (!evidence) return;
      const encoded = JSON.stringify(evidence);
      if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES)
        throw new Error("resource_exhausted:evidence_bytes");
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, target);
    };
    try {
      const environment = await this.dialect.prepare(input.environment);
      await mkdir(join(environment.stateDir, "runs"), {
        recursive: true,
        mode: 0o700,
      });
      target = join(environment.stateDir, "runs", `${hash(input.runId)}.json`);
      evidence = { runId: input.runId, state: "unknown", messages: [] };
      await writeFile(target, JSON.stringify(evidence), {
        flag: "wx",
        mode: 0o600,
      });
      ownedEvidence = true;
      const key = hash(
        JSON.stringify({
          environment,
          definitions: input.tools.definitions,
          name: input.tools.name,
        }),
      );
      if (this.#session?.key !== key) {
        await this.#release();
        const lifetime = new AbortController();
        const bridge = input.tools.definitions.length
          ? await createMcpBridge<TDelivery>({
              signal: lifetime.signal,
              name: input.tools.name,
              tools: input.tools.definitions,
            })
          : null;
        this.#session = {
          key,
          sessionKey: randomUUID(),
          bridge,
          lifetime,
          runtime: this.dialect.runtime(
            { ...environment, mcpServers: bridge ? [bridge.descriptor] : [] },
            undefined,
            {
              onAcpMessage: (direction, value) => {
                this.#initialization.observe(direction, value);
                this.#observe(direction, value);
              },
            },
          ),
        };
      }
      const session = this.#session;
      if (session.sessionId && input.resumeThreadId !== session.sessionId)
        throw new Error(`${this.dialect.agent}_resume_identity_mismatch`);
      session.bridge?.bind({
        ...input.tools.invocation,
        signal,
        onToolCall: async (call) => {
          signal.throwIfAborted();
          if (!active) throw new Error("mcp_invocation_not_active");
          return input.tools.invocation.onToolCall(call);
        },
      });
      const handle = await session.runtime.ensureSession({
        sessionKey: session.sessionKey,
        agent: this.dialect.agent,
        mode: "persistent",
        cwd: environment.cwd,
        resumeSessionId: input.resumeThreadId,
      });
      signal.throwIfAborted();
      if (
        !handle.backendSessionId ||
        (input.resumeThreadId &&
          handle.backendSessionId !== input.resumeThreadId)
      )
        throw new Error(`${this.dialect.agent}_resume_identity_mismatch`);
      evidence.sessionId = session.sessionId = handle.backendSessionId;
      await save();
      if (input.model !== undefined)
        await session.runtime.setConfigOption({
          handle,
          key: "model",
          value: input.model,
          signal,
        });
      if (input.mode !== undefined)
        await session.runtime.setConfigOption({
          handle,
          key: "mode",
          value: input.mode,
          signal,
        });
      if (input.effort !== undefined)
        await session.runtime.setConfigOption({
          handle,
          key: this.dialect.effortKey ?? "reasoning_effort",
          value: input.effort,
          signal,
        });
      signal.throwIfAborted();
      this.#initialization.assertImages(input.attachments);
      await input.onReady(handle.backendSessionId);
      signal.throwIfAborted();
      active = true;
      this.#updates.begin(handle.backendSessionId!, (error) =>
        outputAbort.abort(error),
      );
      const running = session.runtime.startTurn({
        handle,
        requestId: input.runId,
        text: input.prompt,
        attachments: input.attachments,
        mode: "prompt",
        timeoutMs: 0,
        signal,
        onPermissionRequest: async (request, context) => {
          if (!active || signal.aborted || context.signal.aborted)
            return { outcome: "cancel" };
          const raw = request.raw;
          const details = {
            ...turn.tools.get(raw.toolCall.toolCallId),
            ...raw.toolCall,
          };
          const decision = await input.permission?.(
            {
              id: randomUUID(),
              title:
                typeof details.title === "string"
                  ? details.title
                  : `${this.dialect.agent} permission`,
              details,
              canAllow: raw.options.some(
                (option) => option.kind === "allow_once",
              ),
              options: raw.options,
            },
            context.signal,
            context.responseSent,
          );
          if (
            !active ||
            signal.aborted ||
            context.signal.aborted ||
            !decision ||
            typeof decision !== "object" ||
            !("optionId" in decision) ||
            !raw.options.some((option) => option.optionId === decision.optionId)
          )
            return { outcome: "cancel" };
          return { outcome: "selected", optionId: decision.optionId };
        },
      });
      void running.promptStarted.catch(() => {});
      void running.result.catch(() => {});
      for await (const raw of this.#updates.events(running.events)) {
        if (raw.type === "session_update") {
          if (raw.sessionId !== evidence.sessionId)
            throw new Error(`${this.dialect.agent}_session_identity_mismatch`);
          session.bridge?.acknowledgeToolUpdate(raw.update);
          if (
            raw.update.sessionUpdate === "tool_call" ||
            raw.update.sessionUpdate === "tool_call_update"
          ) {
            const status = raw.update.status;
            const toolCallId =
              typeof raw.update.toolCallId === "string"
                ? raw.update.toolCallId
                : undefined;
            // ZCode can repeat a settled tool's terminal update after its final
            // answer. That duplicate is not a new action after the answer.
            const duplicateTerminal =
              raw.update.sessionUpdate === "tool_call_update" &&
              toolCallId !== undefined &&
              typeof status === "string" &&
              settledTools.get(toolCallId) === status;
            if (!duplicateTerminal) turn.lastContent = "tool";
            if (toolCallId && (status === "completed" || status === "failed")) {
              if (!settledTools.has(toolCallId) && settledTools.size >= 10_000)
                settledTools.delete(settledTools.keys().next().value!);
              settledTools.set(toolCallId, status);
            } else if (toolCallId && status) settledTools.delete(toolCallId);
          }
          if (
            raw.update.sessionUpdate === "agent_message_chunk" &&
            object(raw.update.content).type === "text"
          ) {
            const text = object(raw.update.content).text;
            if (typeof text !== "string")
              throw new Error(`${this.dialect.agent}_message_invalid`);
            turn.lastContent = "message";
            answer.add(text);
            const id =
              typeof raw.update.messageId === "string"
                ? raw.update.messageId
                : `message-${evidence.messages.length}`;
            const existing = evidence.messages.find(
              (message) => message.id === id,
            );
            if (existing) existing.text += text;
            else {
              if (evidence.messages.length >= 10_000)
                throw new Error("resource_exhausted:answer_messages");
              evidence.messages.push({ id, text });
            }
          }
          if (raw.event) await input.onEvent(raw.event);
        } else await input.onEvent(raw);
      }
      const result = await running.result;
      if (turn.terminal && result.status === turn.terminal.state)
        Object.assign(evidence, turn.terminal);
      else if (result.status === "failed")
        evidence.error = result.error.message;
      // ACP does not carry Codex phases. Only a successful end_turn with a
      // trailing assistant message can establish the ZCode final response;
      // failed/cancelled/tool-ending turns never promote progress to an answer.
      if (
        this.dialect.finalMessage === "last-on-end-turn" &&
        evidence.state === "completed" &&
        evidence.stopReason === "end_turn" &&
        turn.lastContent === "message"
      ) {
        for (const message of evidence.messages) message.phase = "commentary";
        const last = evidence.messages.at(-1);
        if (last && !last.id.startsWith("turninfo_"))
          last.phase = "final_answer";
      }
      retain =
        input.retainSession &&
        evidence.state === "completed" &&
        !signal.aborted;
      await save();
      return evidence;
    } catch (error) {
      outputAbort.abort(error);
      if (!ownedEvidence || !evidence) throw error;
      // A terminal response cannot validate output that failed projection or delivery.
      evidence.state = turn.promptSent ? "unknown" : "failed";
      evidence.error ??= error instanceof Error ? error.message : String(error);
      await save();
      return evidence;
    } finally {
      active = false;
      this.#updates.end();
      this.#turn = undefined;
      try {
        await this.#session?.bridge?.unbind();
      } finally {
        try {
          if (!retain) await this.#release();
        } finally {
          this.#running = false;
        }
      }
    }
  }
}
