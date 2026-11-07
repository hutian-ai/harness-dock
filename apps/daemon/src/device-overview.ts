import type { DatabaseSync } from 'node:sqlite';

const WINDOW_MS = 24 * 60 * 60_000;
const MAX_ROWS = 50;
type ExecutionState = 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled';
export interface ExecutionOverview {
  runId: string; provider: string; model?: string; state: ExecutionState;
  startedAt?: number; endedAt?: number; elapsedMs?: number;
}
export interface ReportedUsage {
  inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number;
}
export interface ProviderUsageOverview extends Partial<ReportedUsage> {
  provider: string; executions: number; reportedExecutions: number;
}
/** Local management projection, never an application or Provider wire contract. */
export interface DeviceOverview {
  capturedAt: number; since: number; source: 'live' | 'persisted';
  executions: ExecutionOverview[];
  counts: { total: number; running: number; unknown: number; ended: number };
  truncated: boolean; maxConcurrentExecutions?: number; usage: ProviderUsageOverview[];
}
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown, now: number): number | undefined => safeCount(value) && value > 0 && value <= now ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f]/u.test(value) ? value : undefined;

/** Cached input is a subset of input. Session cumulative totals are intentionally not accepted. */
export function reportedUsage(value: unknown): ReportedUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens, totalTokens } = value as Record<string, unknown>;
  if (!safeCount(inputTokens) || !safeCount(outputTokens) || !safeCount(cachedInputTokens) || !safeCount(totalTokens)
    || cachedInputTokens > inputTokens || inputTokens + outputTokens !== totalTokens) return undefined;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

/** Select only presentation facts; prompts, callbacks, credentials and native sessions never leave the store. */
export function readDeviceOverview(database: DatabaseSync, source: DeviceOverview['source'], now = Date.now(), maxConcurrentExecutions?: number): DeviceOverview {
  const since = now - WINDOW_MS;
  const counts = { total: 0, running: 0, unknown: 0, ended: 0 };
  const executions: ExecutionOverview[] = [];
  const usage = new Map<string, ProviderUsageOverview>(['codex', 'dsh'].map(provider => [provider, { provider, executions: 0, reportedExecutions: 0 }]));
  const totals = new Map<string, Record<keyof ReportedUsage, bigint>>();
  const rows = database.prepare(`SELECT run_id AS runId,
    json_extract(value,'$.provider') AS provider, json_extract(value,'$.model') AS model,
    json_extract(value,'$.state') AS state, json_extract(value,'$.createdAt') AS createdAt,
    json_extract(value,'$.finishedAt') AS finishedAt, json_extract(value,'$.lastObservedAt') AS lastObservedAt,
    coalesce(json_extract(value,'$.usage'),json_extract(value,'$.result.usage')) AS usage
    FROM device_executions WHERE json_extract(value,'$.state') IN ('running','unknown')
      OR json_extract(value,'$.createdAt') BETWEEN ? AND ?
    ORDER BY CASE WHEN json_extract(value,'$.state') IN ('running','unknown') THEN 0 ELSE 1 END,
      json_extract(value,'$.createdAt') DESC, run_id`).iterate(since, now);
  for (const row of rows) {
    const runId = text(row.runId), provider = text(row.provider), model = text(row.model);
    if (!runId || !provider || !['running', 'unknown', 'completed', 'failed', 'cancelled'].includes(String(row.state))) continue;
    const state = source === 'persisted' && row.state === 'running' ? 'unknown' : row.state as ExecutionState;
    const startedAt = timestamp(row.createdAt, now), endedAt = timestamp(row.finishedAt, now);
    const observedAt = timestamp(row.lastObservedAt, now);
    const end = state === 'running' ? now : state === 'unknown' ? observedAt : endedAt;
    const elapsedMs = startedAt !== undefined && end !== undefined && end >= startedAt ? end - startedAt : undefined;
    counts.total++;
    if (state === 'running') counts.running++; else if (state === 'unknown') counts.unknown++; else counts.ended++;
    if (executions.length < MAX_ROWS) executions.push({ runId, provider, ...(model ? { model } : {}), state,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(state !== 'running' && state !== 'unknown' && endedAt !== undefined ? { endedAt } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    });
    // All nonterminal records remain visible; usage has a single explicit 24h-start window.
    if (startedAt === undefined || startedAt < since) continue;
    const summary = usage.get(provider);
    if (!summary) continue;
    summary.executions++;
    let reported: ReportedUsage | undefined;
    try { reported = reportedUsage(typeof row.usage === 'string' ? JSON.parse(row.usage) : undefined); } catch { /* No usable usage evidence. */ }
    if (!reported) continue;
    summary.reportedExecutions++;
    const total = totals.get(provider) ?? { inputTokens: 0n, outputTokens: 0n, cachedInputTokens: 0n, totalTokens: 0n };
    for (const key of Object.keys(total) as (keyof ReportedUsage)[]) total[key] += BigInt(reported[key]);
    totals.set(provider, total);
  }
  return { capturedAt: now, since, source, executions, counts, truncated: counts.total > executions.length,
    ...(maxConcurrentExecutions !== undefined ? { maxConcurrentExecutions } : {}),
    usage: [...usage.values()].map(summary => {
      const total = totals.get(summary.provider);
      // Missing reporting and unsafe arithmetic are unavailable, never a fabricated zero.
      return { ...summary, ...(total && Object.values(total).every(value => value <= BigInt(Number.MAX_SAFE_INTEGER))
        ? Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Number(value)])) : {}) };
    }),
  };
}
