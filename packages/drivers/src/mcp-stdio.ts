import { createConnection } from "node:net";

// This subprocess only transports MCP. Caller credentials stay in the execution owner.
const endpoint = process.env.HARNESS_DOCK_MCP_ENDPOINT;
const token = process.env.HARNESS_DOCK_MCP_TOKEN;
if (!endpoint || !token) throw new Error("Invocation MCP transport is unavailable");
delete process.env.HARNESS_DOCK_MCP_ENDPOINT;
delete process.env.HARNESS_DOCK_MCP_TOKEN;
const socket = createConnection(endpoint);
socket.on("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
  socket.destroy();
});
socket.once("connect", () => {
  socket.write(`${JSON.stringify({ token })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("close", () => {
  process.stdin.destroy();
});
process.stdin.once("end", () => socket.end());
process.stdout.on("error", () => socket.destroy());
