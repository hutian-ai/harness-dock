import assert from "node:assert/strict";
import test from "node:test";
import { ToolDeliveryTracker, type ToolDelivery } from "../packages/drivers/src/tool-delivery.ts";

const result = { text: "synthetic" };
const context = { observation: "test-only" };

test("does not claim prepared or echoed input as delivered; ACP requires completed exact output", async () => {
  const reports: ToolDelivery<typeof context>[] = [];
  const tracker = new ToolDeliveryTracker<typeof context>(async (delivery) => {
    reports.push(delivery);
  });
  tracker.prepared("first", JSON.stringify(result), context);
  tracker.acknowledgeAcpUpdate({
    sessionUpdate: "tool_call_update",
    status: "in_progress",
    rawOutput: result,
  });
  tracker.acknowledgeAcpUpdate({
    sessionUpdate: "tool_call_update",
    status: "completed",
    rawInput: result,
  });
  assert.equal(reports.length, 0);
  tracker.acknowledgeAcpUpdate({
    sessionUpdate: "tool_call_update",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: JSON.stringify(result) } }],
  });
  tracker.prepared("second", JSON.stringify(result), context);
  await tracker.close();
  assert.deepEqual(reports.map((delivery) => delivery.context), [context, context]);
  assert.deepEqual(
    reports.map(({ callId, status }) => ({ callId, status })),
    [
      { callId: "first", status: "delivered" },
      { callId: "second", status: "unknown" },
    ],
  );
});

test("a slow delivery observer does not block Provider progress", async () => {
  let resolve: (() => void) | undefined;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const tracker = new ToolDeliveryTracker<typeof context>(async () => pending);
  tracker.prepared("call", JSON.stringify(result), context);
  tracker.acknowledge("call");
  tracker.acknowledge("call");
  resolve!();
  await tracker.close();
});
