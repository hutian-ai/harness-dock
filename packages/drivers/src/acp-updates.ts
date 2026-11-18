import type { AcpRuntimeEvent } from "acpx/runtime";

/** Driver-local envelope. ACPX continues to own normalization and its event queue. */
export type DriverAcpEvent =
  | AcpRuntimeEvent
  | {
      type: "session_update";
      sessionId: string;
      update: Record<string, unknown>;
      event: AcpRuntimeEvent | null;
    };

const tags = new Set([
  "session_info_update",
  "tool_call",
  "tool_call_update",
  "agent_message_chunk",
  "agent_thought_chunk",
]);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Join only updates used by these drivers to ACPX's ordered, normalized events.
 * Unknown updates and non-text chunks are left to ACPX. Drift fails closed instead
 * of attaching native metadata to another event. No raw envelope leaves drivers.
 */
export class AcpUpdates {
  #pending: {
    sessionId: string;
    update: Record<string, unknown>;
    bytes: number;
    afterPrompt: boolean;
  }[] = [];
  #bytes = 0;
  #sessionId?: string;
  #failure?: Error;
  #abort?: (error: Error) => void;
  #promptId?: string | number;
  #promptReturned = false;

  begin(sessionId: string, abort?: (error: Error) => void): void {
    this.end();
    this.#sessionId = sessionId;
    this.#abort = abort;
  }

  end(): void {
    this.#pending = [];
    this.#bytes = 0;
    this.#sessionId = undefined;
    this.#failure = undefined;
    this.#abort = undefined;
    this.#promptId = undefined;
    this.#promptReturned = false;
  }

  observe(direction: string, value: unknown): void {
    if (!this.#sessionId || this.#failure) return;
    const message = object(value);
    if (
      direction === "outbound" &&
      message.method === "session/prompt" &&
      object(message.params).sessionId === this.#sessionId &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      this.#promptId = message.id;
      this.#promptReturned = false;
    }
    if (direction !== "inbound") return;
    if (
      this.#promptId !== undefined &&
      message.id === this.#promptId &&
      !("method" in message) &&
      typeof object(message.result).stopReason === "string"
    )
      this.#promptReturned = true;
    if (message.method !== "session/update") return;
    const params = object(message.params),
      update = object(params.update);
    const tag =
      typeof update.sessionUpdate === "string"
        ? update.sessionUpdate.trim()
        : "";
    if (!tags.has(tag)) return;
    // ACPX emits no normalized event for empty/non-text chunks.
    if (tag === "agent_message_chunk" || tag === "agent_thought_chunk") {
      const content = object(update.content);
      if (
        typeof content.type === "string" &&
        content.type.trim() &&
        content.type.trim() !== "text"
      )
        return;
      if (
        !(typeof content.text === "string" && content.text.length) &&
        !(typeof update.text === "string" && update.text.length)
      )
        return;
    }
    const encoded = JSON.stringify(update),
      bytes = Buffer.byteLength(encoded);
    if (
      typeof params.sessionId !== "string" ||
      this.#pending.length >= 4096 ||
      this.#bytes + bytes > 64 * 1024 * 1024
    ) {
      this.#failure = new Error(
        typeof params.sessionId !== "string"
          ? "acp_session_identity_missing"
          : "resource_exhausted:acp_update_queue",
      );
      this.#abort?.(this.#failure);
      return;
    }
    // Preserve subagent session routing; each named driver decides which identities it accepts.
    this.#pending.push({
      sessionId: params.sessionId,
      update: JSON.parse(encoded),
      bytes,
      afterPrompt: this.#promptReturned,
    });
    this.#bytes += bytes;
  }

  async *events(
    events: AsyncIterable<AcpRuntimeEvent>,
  ): AsyncGenerator<DriverAcpEvent> {
    try {
      for await (const event of events) {
        if (this.#failure) throw this.#failure;
        if (!("tag" in event) || !event.tag || !tags.has(event.tag)) {
          yield event;
          continue;
        }
        const raw = this.#pending.shift();
        if (!raw || String(raw.update.sessionUpdate).trim() !== event.tag)
          throw new Error("acp_update_order_mismatch");
        this.#bytes -= raw.bytes;
        const id =
          event.type === "tool_call"
            ? event.toolCallId
            : event.type === "text_delta"
              ? event.messageId
              : undefined;
        const rawId =
          event.type === "tool_call"
            ? raw.update.toolCallId
            : raw.update.messageId;
        if (
          id !== undefined &&
          id !== (typeof rawId === "string" ? rawId.trim() : undefined)
        )
          throw new Error("acp_update_identity_mismatch");
        yield {
          type: "session_update",
          sessionId: raw.sessionId,
          update: raw.update,
          event,
        };
      }
      if (this.#failure) throw this.#failure;
      // ACPX switches a retained session to its idle projection before the
      // consumer necessarily drains this queue. Late session metadata then has
      // no turn event. Only discard metadata beyond the matching prompt reply;
      // unmatched text/tools and all in-turn drift still fail closed.
      if (
        this.#pending.some(
          (raw) =>
            !raw.afterPrompt ||
            raw.sessionId !== this.#sessionId ||
            String(raw.update.sessionUpdate).trim() !== "session_info_update",
        )
      )
        throw new Error("acp_update_order_mismatch");
    } finally {
      this.end();
    }
  }
}
