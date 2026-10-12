import assert from "node:assert/strict";
import { test } from "node:test";
import { acpFileChangeEvent } from "../packages/drivers/src/acp-file-changes.ts";
type SessionUpdate = Parameters<typeof acpFileChangeEvent>[2];

test("extracts ACP tool diff content as a deduplicable delta event", async () => {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    content: [
      {
        type: "diff",
        path: "/workspace/src/file.ts",
        oldText: "before\n",
        newText: "after\n",
      },
    ],
  } as SessionUpdate;
  const event = await acpFileChangeEvent("acp", "session-1", update);
  assert.equal(event?.kind, "delta");
  if (event?.kind !== "delta") return;
  assert.deepEqual(event.changes, [
    {
      path: "/workspace/src/file.ts",
      beforeText: "before\n",
      afterText: "after\n",
    },
  ]);
  assert.equal(
    (await acpFileChangeEvent("acp", "session-1", update))?.eventKey,
    event.eventKey,
  );
});

test("normalizes a CodeWiz raw output patch into the shared ACP delta event", async () => {
  const path = "/workspace/new.txt";
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "write-1",
    rawInput: { filePath: path, content: "created\n" },
    rawOutput: {
      metadata: {
        filepath: path,
        exists: false,
        diff: `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -0,0 +1,1 @@\n+created\n`,
      },
    },
  } as unknown as SessionUpdate;

  const event = await acpFileChangeEvent("lobi", "session-1", update);
  assert.equal(event?.kind, "delta");
  if (event?.kind !== "delta") return;
  assert.deepEqual(event.changes, [
    { path, beforeText: null, afterText: "created\n" },
  ]);
});

test("reconstructs the previous file text from a CodeWiz patch and current file", async () => {
  const path = "/workspace/existing.txt";
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "write-2",
    rawInput: { filePath: path, content: "after\n" },
    rawOutput: {
      metadata: {
        filepath: path,
        exists: true,
        diff: `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -1,1 +1,1 @@\n-before\n+after\n`,
      },
    },
  } as unknown as SessionUpdate;

  const event = await acpFileChangeEvent("lobi", "session-1", update);
  assert.equal(event?.kind, "delta");
  if (event?.kind !== "delta") return;
  assert.deepEqual(event.changes, [
    { path, beforeText: "before\n", afterText: "after\n" },
  ]);
});

test("normalizes a CodeWiz deletion when the current file no longer exists", async () => {
  const path = "/workspace/deleted.txt";
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "write-3",
    rawOutput: {
      metadata: {
        filepath: path,
        exists: true,
        diff: `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -1,1 +0,0 @@\n-before\n`,
      },
    },
  } as unknown as SessionUpdate;

  const event = await acpFileChangeEvent(
    "lobi",
    "session-1",
    update,
    async () => null,
  );
  assert.equal(event?.kind, "delta");
  if (event?.kind !== "delta") return;
  assert.deepEqual(event.changes, [
    { path, beforeText: "before\n", afterText: null },
  ]);
});
