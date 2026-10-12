import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createMcpBridge,
  type McpToolCall,
  type McpToolResult,
  type McpToolDefinition,
} from "../packages/drivers/src/mcp-bridge.ts";

const MCP_TEST_TOOLS: readonly McpToolDefinition[] = [{
  name: "synthetic_search",
  description: "Search synthetic test data.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
}];

test(
  "official MCP client negotiates stdio, sees only the manifest and forwards calls",
  { timeout: 10_000 },
  async () => {
    const controller = new AbortController();
    const calls: McpToolCall[] = [];
    let release: ((value: McpToolResult) => void) | undefined;
    const bridge = await createMcpBridge({
      tools: MCP_TEST_TOOLS,
      signal: controller.signal,
    });
    bridge.bind({
      signal: controller.signal,
      onToolCall: async (call) => {
        calls.push(call);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const descriptor = bridge.descriptor;
    assert.ok("command" in descriptor);
    assert.equal(
      descriptor.env.some((entry) => /CONNECTION_TOKEN|DATABASE|CLAIM/u.test(entry.name)),
      false,
    );
    const transport = new StdioClientTransport({
      command: descriptor.command,
      args: descriptor.args,
      env: Object.fromEntries(descriptor.env.map((entry) => [entry.name, entry.value])),
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "harness-dock-integration-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ["synthetic_search"],
      );
      await bridge.ready;
      const result = client.callTool({
        name: "synthetic_search",
        arguments: { query: "synthetic" },
      });
      await client.ping();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.arguments, { query: "synthetic" });
      release?.({ content: { found: "synthetic-only" } });
      const response = (await result).content[0]!;
      assert.equal(response.type, "text");
      assert.equal(
        JSON.parse(response.type === "text" ? response.text : "{}").found,
        "synthetic-only",
      );
      await assert.rejects(client.callTool({ name: "shell", arguments: {} }), ProtocolError);
      assert.equal(calls.length, 1);
      // Reuse the same negotiated MCP connection, but never the old invocation callback.
      const late = assert.rejects(
        client.callTool({ name: "synthetic_search", arguments: { query: "late" } }),
        ProtocolError,
      );
      await client.ping();
      assert.equal(calls.length, 2);
      const detached = bridge.unbind();
      assert.throws(
        () =>
          bridge.bind({
            signal: controller.signal,
            onToolCall: async () => {
              throw new Error();
            },
          }),
        /already bound/u,
      );
      release?.({ content: { old: true } });
      await detached;
      await late;
      await assert.rejects(
        client.callTool({ name: "synthetic_search", arguments: {} }),
        ProtocolError,
      );
      const nextController = new AbortController();
      let nextCalls = 0;
      bridge.bind({
        signal: nextController.signal,
        onToolCall: async () => {
          nextCalls++;
          return { content: { next: true } };
        },
      });
      const next = await client.callTool({ name: "synthetic_search", arguments: {} });
      assert.equal(
        next.content[0]?.type === "text" && JSON.parse(next.content[0].text).next,
        true,
      );
      nextController.abort();
      await assert.rejects(
        client.callTool({ name: "synthetic_search", arguments: {} }),
        ProtocolError,
      );
      assert.equal(nextCalls, 1);
      assert.equal(calls.length, 2);
      await bridge.unbind();
      const closed = new Promise<void>((resolve) => {
        client.onclose = resolve;
      });
      controller.abort();
      await closed;
    } finally {
      await client.close();
      await bridge.close();
    }
  },
);

test("unauthenticated IPC cannot discover or invoke tools", { timeout: 5_000 }, async () => {
  let calls = 0;
  const bridge = await createMcpBridge({
    tools: MCP_TEST_TOOLS,
    signal: new AbortController().signal,
    invocation: {
      signal: new AbortController().signal,
      async onToolCall() {
        calls++;
        throw new Error("must not run");
      },
    },
  });
  try {
    const descriptor = bridge.descriptor;
    assert.ok("command" in descriptor);
    const socket = connect(
      descriptor.env.find((entry) => entry.name === "HARNESS_DOCK_MCP_ENDPOINT")!.value,
    );
    const closed = once(socket, "close");
    socket.write(JSON.stringify({ token: "wrong" }) + "\n");
    await closed;
    assert.equal(calls, 0);
    assert.equal(bridge.isReady(), false);
  } finally {
    await bridge.close();
  }
});
