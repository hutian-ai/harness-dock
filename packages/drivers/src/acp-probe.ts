import { PROTOCOL_VERSION, client, methods, ndJsonStream, type ClientConnection, type NewSessionResponse } from '@agentclientprotocol/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ACP_PROBE_TOOLS } from './acp-types.ts';
import { createMcpBridge } from './mcp-bridge.ts';
import { startProtocolProcess, closeProtocolProcess, type ProtocolProcess } from './process-command.ts';
import { createProtocolWaiter, raceWithSignalAndTimeout } from './protocol-operation.ts';

/** Probe full ACP metadata with the official SDK; no prompts, file callbacks or terminal capabilities. */
export async function probeAcpSession<T>(options: {
  executable: string; args: (cwd: string) => readonly string[]; env: NodeJS.ProcessEnv; signal: AbortSignal; label: string;
}, inspect: (context: { agent: ClientConnection['agent']; session: NewSessionResponse; awaitAcp: ReturnType<typeof createProtocolWaiter> }) => T | Promise<T>) {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-dock-acp-probe-'));
  let bridge: Awaited<ReturnType<typeof createMcpBridge>> | undefined, child: ProtocolProcess | undefined;
  try {
    options.signal.throwIfAborted();
    bridge = await createMcpBridge({ tools: ACP_PROBE_TOOLS, signal: options.signal,
      invocation: { signal: options.signal, onToolCall: async () => ({ isError: true, content: { code: 'PROBE_DATA_ONLY' } }) } });
    const spawnedChild = child = startProtocolProcess(options.executable, options.args(cwd), { cwd, env: options.env });
    spawnedChild.stderr.resume();
    const descriptor = bridge.descriptor, ready = bridge.ready;
    const probe = client({ name: 'harness-dock-probe' });
    const connectionReady = new Promise<ClientConnection>(resolve => { probe.onConnect(resolve); });
    // The SDK closes ACP on return or failure; the owner still closes the Provider and MCP below.
    return await probe.connectWith(ndJsonStream(
      Writable.toWeb(spawnedChild.stdin) as WritableStream<Uint8Array>, Readable.toWeb(spawnedChild.stdout) as ReadableStream<Uint8Array>), async agent => {
      const connection = await connectionReady;
      const awaitAcp = createProtocolWaiter({ signal: options.signal, label: `${options.label} ACP probe`, closed: connection.closed, exited: spawnedChild.exited });
      const initialized = await awaitAcp(agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'harness-dock-probe', version: '0.1.0' },
      }), 'initialize');
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}`);
      const session = await awaitAcp(agent.request(methods.agent.session.new, { cwd, mcpServers: [descriptor] }), 'session new');
      const details = await inspect({ agent, session, awaitAcp });
      const mcpTools = await raceWithSignalAndTimeout(ready, { signal: options.signal, timeoutMs: 3000, label: `${options.label} MCP tool discovery` }).then(() => true, () => false);
      options.signal.throwIfAborted();
      return { ...details, protocolVersion: initialized.protocolVersion, mcpTools,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        resumeSession: initialized.agentCapabilities?.sessionCapabilities?.resume != null };
    });
  } finally {
    try { if (child) await closeProtocolProcess(child); }
    finally { try { await bridge?.close(); } finally { await rm(cwd, { recursive: true, force: true }); } }
  }
}
