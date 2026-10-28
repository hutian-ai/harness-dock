/** Technical timings only: never include prompts, arguments, credentials or paths. */
export function startStartupSpan(runId: string, stage: string, queueMs?: number) {
  const started = performance.now();
  let finished = false;
  const emit = (status: string) => {
    try {
      console.error(`[dock-startup] ${JSON.stringify({
        runId, stage, status, at: new Date().toISOString(),
        ...(queueMs === undefined ? {} : { queueMs: Math.round(queueMs) }),
        ...(status === 'started' ? {} : { durationMs: Math.round(performance.now() - started) }),
      })}`);
    } catch { /* Diagnostic output must not decide execution or trigger a replay. */ }
  };
  emit('started');
  return (status: 'completed' | 'failed' = 'completed') => {
    if (finished) return;
    finished = true;
    emit(status);
  };
}

export async function observeStartup<T>(runId: string, stage: string, work: () => Promise<T>, queueMs?: number): Promise<T> {
  const finish = startStartupSpan(runId, stage, queueMs);
  try {
    const result = await work();
    finish();
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
}
