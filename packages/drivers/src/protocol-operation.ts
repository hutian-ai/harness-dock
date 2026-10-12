import type { AcpExecutionResult } from "./acp-types.ts";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 15_000;
const CANCELLATION_CONFIRMATION_MS = 5_000;

export function createProtocolWaiter(context: {
  signal: AbortSignal;
  label: string;
  closed: Promise<unknown>;
  exited: Promise<number>;
}) {
  return <T>(
    operation: Promise<T>,
    phase: string,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
    exitDrainMs = 0,
  ): Promise<T> =>
    raceWithSignalAndTimeout(
      Promise.race([
        operation,
        context.closed.then(() => {
          throw new Error(`${context.label} connection closed during ${phase}`);
        }),
        context.exited.then(async (code) => {
          if (exitDrainMs) await delay(exitDrainMs);
          throw new Error(`${context.label} exited during ${phase} (${code})`);
        }),
      ]),
      {
        signal: context.signal,
        label: `${context.label} ${phase}`,
        timeoutMs,
        abortGraceMs: timeoutMs === null ? CANCELLATION_CONFIRMATION_MS : 0,
      },
    );
}

/** A dispatched request with no Provider terminal stays unknown. */
export function protocolFailureResult(
  error: unknown,
  cancellationRequested: boolean,
  dispatched: boolean,
  details: {
    errorPrefix: string;
    stderr: string;
    sessionId: string | null;
    text: string;
  },
): AcpExecutionResult {
  return {
    state:
      !dispatched && cancellationRequested
        ? "cancelled"
        : dispatched
          ? "unknown"
          : "failed",
    sessionId: details.sessionId,
    resumable: false,
    resumed: false,
    text: !dispatched && cancellationRequested ? details.text : "",
    errorCode:
      !dispatched && cancellationRequested
        ? undefined
        : `${details.errorPrefix}_${dispatched ? "outcome_unknown" : "start_failed"}`,
    message: error instanceof Error ? error.message : String(error),
    stderr: details.stderr.trim(),
  };
}

export async function raceWithSignalAndTimeout<T>(
  operation: Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number | null;
    abortGraceMs?: number;
    label: string;
  },
): Promise<T> {
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (options.signal?.aborted && !options.abortGraceMs)
    throw new DOMException(`${options.label} was aborted`, "AbortError");
  let timeout: NodeJS.Timeout | null = null;
  let abortTimeout: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (timeoutMs === null) return;
    timeout = setTimeout(
      () =>
        reject(
          new DOMException(
            `${options.label} timed out after ${timeoutMs}ms`,
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    timeout.unref();
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!options.signal) return;
    onAbort = () => {
      const rejectAbort = () =>
        reject(new DOMException(`${options.label} was aborted`, "AbortError"));
      if (options.abortGraceMs) {
        abortTimeout = setTimeout(rejectAbort, options.abortGraceMs);
        abortTimeout.unref();
      } else rejectAbort();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortTimeout) clearTimeout(abortTimeout);
    if (options.signal && onAbort)
      options.signal.removeEventListener("abort", onAbort);
  }
}
