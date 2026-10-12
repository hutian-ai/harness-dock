import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import {
  Server,
  ProtocolError,
  INVALID_PARAMS,
  INVALID_REQUEST,
  INTERNAL_ERROR,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { fileURLToPath } from "node:url";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { ToolDeliveryTracker, type ToolDelivery } from "./tool-delivery.ts";

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};
export type McpToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type McpToolResult<TDelivery = unknown> = {
  /** The caller owns the JSON payload exposed to the provider. */
  content: unknown;
  isError?: boolean;
  deliveryContext?: TDelivery;
};
export type McpInvocation<TDelivery = unknown> = {
  signal: AbortSignal;
  onToolCall(call: McpToolCall): Promise<McpToolResult<TDelivery>>;
  onToolResultDelivery?(delivery: ToolDelivery<TDelivery>): Promise<void>;
};
export interface McpBridge<TDelivery = unknown> {
  descriptor: McpServerStdio;
  ready: Promise<void>;
  isReady(): boolean;
  bind(invocation: McpInvocation<TDelivery>): void;
  unbind(): Promise<void>;
  acknowledgeToolUpdate(update: unknown): void;
  close(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
const MAX_MCP_BUFFER_BYTES = 140_000;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The transport may outlive a turn; its authorization binding may not. */
export async function createMcpBridge<TDelivery = unknown>(
  input: {
    signal: AbortSignal;
    tools: readonly McpToolDefinition[];
    name?: string;
    invocation?: McpInvocation<TDelivery>;
  },
): Promise<McpBridge<TDelivery>> {
  input.signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "harness-dock-mcp-"));
  await chmod(directory, 0o700);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\harness-dock-${randomUUID()}`
      : join(directory, "bridge.sock");
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const binding = (invocation: McpInvocation<TDelivery>) => ({
    invocation,
    id: randomUUID(),
    delivery: new ToolDeliveryTracker<TDelivery>(invocation.onToolResultDelivery),
    requests: new Set<string>(),
    pending: new Set<Promise<unknown>>(),
  });
  let current: ReturnType<typeof binding> | null = input.invocation ? binding(input.invocation) : null;
  let detaching = false;
  async function unbind() {
    const previous = current;
    current = null;
    if (!previous) return;
    detaching = true;
    try {
      await Promise.allSettled(previous.pending);
      await previous.delivery.close();
    } finally {
      detaching = false;
    }
  }
  let ready = false;
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const server = createServer((socket) => {
    if (input.signal.aborted || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    const connectionId = randomUUID();
    let authenticated = false;
    let authentication = Buffer.alloc(0);
    // This first frame authenticates the local IPC channel, not the MCP protocol.
    const ingress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (authenticated) {
          callback(null, chunk);
          return;
        }
        authentication = Buffer.concat([authentication, chunk]);
        const newline = authentication.indexOf(10);
        if (newline < 0) {
          callback(
            authentication.length > 512 ? new Error("IPC authentication rejected") : undefined,
          );
          return;
        }
        try {
          if (newline > 512) throw new Error();
          const value: unknown = JSON.parse(authentication.subarray(0, newline).toString("utf8"));
          const presented =
            isObject(value) && typeof value.token === "string"
              ? Buffer.from(value.token)
              : Buffer.alloc(0);
          if (presented.length !== token.length || !timingSafeEqual(presented, Buffer.from(token)))
            throw new Error();
          authenticated = true;
          const rest = authentication.subarray(newline + 1);
          authentication = Buffer.alloc(0);
          callback(null, rest);
        } catch {
          callback(new Error("IPC authentication rejected"));
        }
      },
    });
    ingress.on("error", () => socket.destroy());
    // The low-level SDK server forwards the caller-owned JSON schemas unchanged.
    // SDK owns MCP initialization, versions, framing, request validation and errors.
    const mcp = new Server(
      { name: input.name ?? "harness-dock-tools", version: "1.0.0" },
      { capabilities: { tools: { listChanged: false } } },
    );
    let inFlight = 0;
    mcp.setRequestHandler("tools/list", async () => {
      ready = true;
      resolveReady?.();
      return {
        tools: input.tools.map((tool) => ({
          ...tool,
          inputSchema: { ...tool.inputSchema, type: "object" as const },
        })),
      };
    });
    mcp.setRequestHandler("tools/call", async (request, context) => {
      const active = current;
      if (!active || active.invocation.signal.aborted)
        throw new ProtocolError(INVALID_REQUEST, "Runtime invocation is not active");
      const key = `${connectionId}-${context.mcpReq.id}`;
      if (inFlight >= 8 || active.requests.size >= 100 || active.requests.has(key))
        throw new ProtocolError(INVALID_REQUEST, "Duplicate or excessive tool request");
      const call: McpToolCall = {
        callId: `mcp-${active.id}-${key}`,
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      };
      if (
        call.callId.length > 200 ||
        !isObject(call.arguments) ||
        JSON.stringify(call.arguments).length > 64_000 ||
        !input.tools.some((tool) => tool.name === call.name)
      )
        throw new ProtocolError(INVALID_PARAMS, "Unknown tool or invalid arguments");
      active.requests.add(key);
      inFlight += 1;
      const operation = (async () => {
        try {
          input.signal.throwIfAborted();
          active.invocation.signal.throwIfAborted();
          context.mcpReq.signal.throwIfAborted();
          const result = await active.invocation.onToolCall(call);
          const serialized = JSON.stringify(result.content);
          if (serialized === undefined) throw new Error("Tool result must be JSON serializable");
          if (result.deliveryContext !== undefined)
            active.delivery.prepared(call.callId, serialized, result.deliveryContext);
          if (current !== active) throw new Error("Runtime invocation expired");
          active.invocation.signal.throwIfAborted();
          input.signal.throwIfAborted();
          context.mcpReq.signal.throwIfAborted();
          return {
            content: [{ type: "text" as const, text: serialized }],
            isError: result.isError ?? false,
          };
        } catch {
          throw new ProtocolError(INTERNAL_ERROR, "Runtime tool request failed or was canceled");
        } finally {
          inFlight -= 1;
        }
      })();
      active.pending.add(operation);
      try {
        return await operation;
      } finally {
        active.pending.delete(operation);
      }
    });
    mcp.onerror = () => socket.destroy();
    socket.once("close", () => {
      ingress.destroy();
      void mcp.close();
    });
    socket.pipe(ingress);
    void mcp
      .connect(new StdioServerTransport(ingress, socket, { maxBufferSize: MAX_MCP_BUFFER_BYTES }))
      .catch(() => socket.destroy());
  });
  const abort = () => {
    for (const socket of sockets) socket.destroy();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const script = fileURLToPath(new URL(`./mcp-stdio.${extension}`, import.meta.url));
  const descriptor: McpServerStdio = {
    name: input.name ?? "harness_dock_tools",
    command: process.execPath,
    args: extension === "ts" ? ["--import", import.meta.resolve("tsx"), script] : [script],
    env: [
      { name: "HARNESS_DOCK_MCP_ENDPOINT", value: endpoint },
      { name: "HARNESS_DOCK_MCP_TOKEN", value: token },
    ],
  };
  return {
    descriptor,
    ready: readyPromise,
    isReady: () => ready,
    bind(invocation: McpInvocation<TDelivery>) {
      input.signal.throwIfAborted();
      invocation.signal.throwIfAborted();
      if (current || detaching) throw new Error("MCP invocation already bound");
      current = binding(invocation);
    },
    unbind,
    acknowledgeToolUpdate: (update: unknown) => current?.delivery.acknowledgeAcpUpdate(update),
    async close() {
      input.signal.removeEventListener("abort", abort);
      abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      await unbind();
    },
  };
}
