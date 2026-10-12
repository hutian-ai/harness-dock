import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { execa, type Result, type Subprocess } from "execa";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_LIMIT = 16_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;

const execute = execa({
  buffer: false,
  reject: false,
  forceKillAfterDelay: DEFAULT_TERMINATE_GRACE_MS,
});

export type ProtocolProcess = Subprocess<{
  buffer: false;
  reject: false;
  extendEnv: false;
}> & { exited: Promise<number> };

export function startProtocolProcess(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): ProtocolProcess {
  const child = execute(executable, args, { ...options, extendEnv: false });
  // Protocol failure follows the Provider's exit, even if descendants retain its pipes.
  const exited = once(child.nodeChildProcess, "exit").then(
    ([code]) => (code as number | null) ?? 1,
    async () => {
      throw await child;
    },
  );
  void exited.catch(() => undefined);
  return Object.assign(child, { exited });
}

export function captureProtocolStderr(child: ProtocolProcess): () => string {
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-DEFAULT_OUTPUT_LIMIT);
  });
  return () => stderr;
}

export async function closeProtocolProcess(
  child: ProtocolProcess,
): Promise<void> {
  child.stdin.end();
  await Promise.race([
    child.exited.catch(() => undefined),
    delay(DEFAULT_TERMINATE_GRACE_MS, undefined, { ref: false }),
  ]);
  child.kill();
  child.stdout.destroy();
  child.stderr.destroy();
  await child;
}

function boundedAppend(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${chunk}`.slice(0, limit);
}

export async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputCharacters?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<
  Pick<Result<{ encoding: "utf8" }>, "exitCode" | "stdout" | "stderr">
> {
  const maxOutputCharacters =
    options.maxOutputCharacters ?? DEFAULT_OUTPUT_LIMIT;
  let stdout = "";
  let stderr = "";
  const child = execute(executable, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.env === undefined,
    stdin: "ignore",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cancelSignal: options.signal,
  });
  // Keep draining after the prefix limit; Execa's maxBuffer would fail the command.
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = boundedAppend(stdout, chunk, maxOutputCharacters);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = boundedAppend(stderr, chunk, maxOutputCharacters);
  });
  const result = await child;
  if (
    result.timedOut ||
    result.isCanceled ||
    (result.failed && result.exitCode === undefined && !result.isTerminated)
  )
    throw result;
  return { ...result, stdout, stderr };
}
