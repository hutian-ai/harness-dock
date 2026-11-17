import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { AcpUpdates } from "../packages/drivers/src/acp-updates.ts";

async function* events(...values: AcpRuntimeEvent[]) {
  yield* values;
}
async function collect(values: AsyncIterable<unknown>) {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}
const standard = {
  type: "status",
  tag: "session_info_update",
  text: "session updated",
} as const;
const observe = (
  updates: AcpUpdates,
  update: Record<string, unknown>,
  sessionId = "native",
) =>
  updates.observe("inbound", {
    method: "session/update",
    params: { sessionId, update },
  });

test("driver joins snapshots without replacing upstream normalization or retaining idle/previous-turn metadata", async () => {
  const updates = new AcpUpdates();
  observe(updates, { sessionUpdate: "session_info_update", stale: true });
  updates.begin("native");
  const update = {
    sessionUpdate: "session_info_update",
    _meta: { original: true },
  };
  observe(updates, update);
  update._meta.original = false;
  assert.deepEqual(await collect(updates.events(events(standard))), [
    {
      type: "session_update",
      sessionId: "native",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { original: true },
      },
      event: standard,
    },
  ]);
  updates.begin("native");
  await assert.rejects(
    collect(updates.events(events(standard))),
    /order_mismatch/,
  );
});

test("driver preserves subagent routing and ignores updates for which ACPX emits no event", async () => {
  const updates = new AcpUpdates();
  updates.begin("native");
  observe(updates, { sessionUpdate: "future" });
  observe(updates, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
  });
  observe(updates, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "image", text: "not text" },
  });
  observe(updates, { sessionUpdate: "session_info_update" }, "native-child");
  const result = await collect(updates.events(events(standard)));
  assert.equal((result[0] as { sessionId: string }).sessionId, "native-child");
});

test("driver rejects reordered or unmatched metadata and clears it when the consumer cancels", async () => {
  const updates = new AcpUpdates();
  updates.begin("native");
  observe(updates, { sessionUpdate: "tool_call", toolCallId: "first" });
  await assert.rejects(
    collect(
      updates.events(
        events({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "second",
          text: "tool",
        }),
      ),
    ),
    /identity_mismatch/,
  );
  updates.begin("native");
  observe(updates, { sessionUpdate: "session_info_update" });
  await assert.rejects(collect(updates.events(events())), /order_mismatch/);
  updates.begin("native");
  observe(updates, { sessionUpdate: "session_info_update" });
  observe(updates, { sessionUpdate: "session_info_update" });
  for await (const _ of updates.events(events(standard, standard))) break;
  updates.begin("native");
  observe(updates, { sessionUpdate: "session_info_update" });
  assert.equal((await collect(updates.events(events(standard)))).length, 1);
});

test("driver bounds unread raw updates and aborts the owning execution on overflow", async () => {
  const updates = new AcpUpdates();
  let failure: Error | undefined;
  updates.begin("native", (error) => {
    failure = error;
  });
  for (let index = 0; index < 4097; index++)
    observe(updates, { sessionUpdate: "session_info_update" });
  assert.match(failure?.message ?? "", /resource_exhausted/);
  await assert.rejects(
    collect(updates.events(events(standard))),
    /resource_exhausted/,
  );
});
