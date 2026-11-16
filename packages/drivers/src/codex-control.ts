import type { AcpRuntimeHandle, createAcpRuntime } from 'acpx/runtime';

type Runtime = Pick<ReturnType<typeof createAcpRuntime>, 'requestExtension'>;
type Command = { operation: 'inspect'; hostStatus?: boolean }
  | { operation: 'read_turn'; threadId: string; turnId: string }
  | { operation: 'steer'; threadId: string; turnId: string; text: string };

/** Named Codex contract stays in this driver, never in ACPX or the remote wire API. */
export async function codexControl(runtime: Runtime, input: {
  handle?: AcpRuntimeHandle; requestId?: string; signal?: AbortSignal; command: Command;
}): Promise<unknown> {
  const { command, handle } = input;
  if (command.operation === 'steer' && (!handle || command.threadId !== handle.backendSessionId || !input.requestId)) return { accepted: false };
  try {
    return await runtime.requestExtension({
      scope: command.operation === 'steer' ? 'active-turn' : handle ? 'session' : 'agent',
      ...(handle ? { handle } : { agent: 'codex' }),
      requestId: input.requestId, signal: input.signal,
      method: '_harness-dock/control',
      params: command.operation === 'inspect' && handle ? { ...command, threadId: handle.backendSessionId } : { ...command },
    });
  } catch (error) {
    if (command.operation === 'steer' && error && typeof error === 'object' && 'code' in error && error.code === 'ACP_TURN_NOT_ACTIVE') return { accepted: false };
    throw error;
  }
}
