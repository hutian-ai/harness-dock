export type ToolDelivery<TContext = unknown> = {
  callId: string;
  status: "delivered" | "unknown";
  context: TContext;
};

type PendingDelivery<TContext> = { callId: string; context: TContext; serialized: string };

/** Delivery is a Provider protocol acknowledgement, never a claim that the model read it. */
export class ToolDeliveryTracker<TContext = unknown> {
  readonly #pending = new Map<string, PendingDelivery<TContext>>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #report: ((delivery: ToolDelivery<TContext>) => Promise<void>) | undefined;

  constructor(report?: (delivery: ToolDelivery<TContext>) => Promise<void>) {
    this.#report = report;
  }

  prepared(callId: string, serialized: string, context: TContext): void {
    this.#pending.set(callId, { callId, context, serialized });
  }

  acknowledge(callId: string): void {
    const pending = this.#pending.get(callId);
    if (pending) this.#send(pending, "delivered");
  }

  /** ACP tool completion must contain our exact result, not just the tool's name. */
  acknowledgeAcpUpdate(update: unknown): void {
    if (!update || typeof update !== "object") return;
    const value = update as Record<string, unknown>;
    if (
      !["tool_call", "tool_call_update"].includes(String(value.sessionUpdate)) ||
      value.status !== "completed"
    )
      return;
    const contains = (candidate: unknown, expected: string): boolean => {
      if (typeof candidate === "string") return candidate === expected;
      if (!candidate || typeof candidate !== "object") return false;
      if (JSON.stringify(candidate) === expected) return true;
      return Object.values(candidate).some((nested) => contains(nested, expected));
    };
    for (const pending of this.#pending.values())
      if (
        contains(value.rawOutput, pending.serialized) ||
        contains(value.content, pending.serialized)
      )
        this.#send(pending, "delivered");
  }

  #send(pending: PendingDelivery<TContext>, status: ToolDelivery<TContext>["status"]): void {
    this.#pending.delete(pending.callId);
    if (!this.#report) return;
    // Keep protocol readers free while the delivery observer is in flight.
    const operation = Promise.resolve()
      .then(() =>
        this.#report!({
          callId: pending.callId,
          status,
          context: pending.context,
        }),
      )
      .catch(() => undefined)
      .finally(() => this.#inFlight.delete(operation));
    this.#inFlight.add(operation);
  }

  async close(): Promise<void> {
    for (const pending of this.#pending.values()) this.#send(pending, "unknown");
    await Promise.all(this.#inFlight);
  }
}
