import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PreparedDirectories } from './device-files.ts';
import { resourceLimits, type DeviceResourceLimits } from './device-resources.ts';

export interface StoredPreparation { input: string; sessionKey: string; directories: PreparedDirectories; released?: boolean; createdAt?: number; releasedAt?: number }
export interface StoredExecution {
  runId: string; provider: string; input: string; state: 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown';
  result?: unknown; environment?: unknown; createdAt?: number; settledAt?: number; detailsExpired?: boolean; historyTruncated?: boolean;
}
/** Durable admission identities outlive disposable output; this is never a prompt replay queue. */
export class DeviceStore {
  readonly #db: DatabaseSync;
  readonly #limits: DeviceResourceLimits;
  constructor(nodeId: string, stateDir: string, resources: Partial<DeviceResourceLimits> = {}) {
    this.#limits = resourceLimits(resources);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'runs.sqlite');
    this.#db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.#db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS node (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS device_preparations (run_id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS device_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS device_events_run_sequence ON device_events(run_id,sequence);
        CREATE TABLE IF NOT EXISTS device_executions (run_id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS device_executions_state ON device_executions(json_extract(value,'$.state'));
        CREATE INDEX IF NOT EXISTS device_preparations_session ON device_preparations(json_extract(value,'$.sessionKey'));
        CREATE TABLE IF NOT EXISTS device_event_stats (run_id TEXT PRIMARY KEY, event_count INTEGER NOT NULL, event_bytes INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS device_closed_sessions (session_key TEXT PRIMARY KEY);
        INSERT OR IGNORE INTO device_event_stats(run_id,event_count,event_bytes) SELECT run_id,count(*),sum(length(CAST(payload AS BLOB))) FROM device_events GROUP BY run_id;
        COMMIT;`);
      const owner = this.#db.prepare('SELECT id FROM node').get();
      if (owner && owner.id !== nodeId) throw new Error('state_node_mismatch');
      if (!owner) this.#db.prepare('INSERT INTO node VALUES (?)').run(nodeId);
      this.#db.prepare("UPDATE device_executions SET value=json_set(value,'$.state','unknown') WHERE json_extract(value,'$.state')='running'").run();
      // Existing records receive a full retention period; no migration infers that an unknown run is safe to delete.
      const now = Date.now();
      this.#db.prepare("UPDATE device_preparations SET value=json_set(value,'$.createdAt',?) WHERE json_extract(value,'$.createdAt') IS NULL").run(now);
      this.#db.prepare("UPDATE device_preparations SET value=json_set(value,'$.releasedAt',?) WHERE json_extract(value,'$.released')=1 AND json_extract(value,'$.releasedAt') IS NULL").run(now);
      this.#db.prepare("UPDATE device_executions SET value=json_set(value,'$.settledAt',?) WHERE json_extract(value,'$.state') IN ('completed','cancelled','failed') AND json_extract(value,'$.settledAt') IS NULL").run(now);
    } catch (error) { this.#db.close(); throw error; }
  }
  preparation(runId: string): StoredPreparation | undefined {
    const row = this.#db.prepare('SELECT value FROM device_preparations WHERE run_id=?').get(runId);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  prepare(runId: string, value: StoredPreparation): void {
    this.#db.prepare('INSERT OR REPLACE INTO device_preparations VALUES (?,?)').run(runId, JSON.stringify({ ...value, createdAt: value.createdAt ?? Date.now() }));
  }
  get(runId: string): StoredExecution | undefined {
    const row = this.#db.prepare('SELECT value,(SELECT truncated FROM device_event_stats WHERE run_id=e.run_id) AS truncated FROM device_executions e WHERE run_id=?').get(runId);
    return row ? { ...JSON.parse(String(row.value)), ...(row.truncated ? { historyTruncated: true } : {}) } : undefined;
  }
  admit(execution: StoredExecution): void {
    this.#db.prepare('INSERT INTO device_executions VALUES (?,?)').run(execution.runId, JSON.stringify({ ...execution, createdAt: Date.now() }));
  }
  save(execution: StoredExecution): void {
    const stored = this.get(execution.runId);
    const value = { ...stored, ...execution, ...(execution.state !== 'running' && execution.state !== 'unknown' ? { settledAt: stored?.settledAt ?? Date.now() } : {}) };
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > this.#limits.maxResultBytes) throw new Error('execution_result_too_large');
    this.#db.prepare('UPDATE device_executions SET value=? WHERE run_id=?').run(encoded, execution.runId);
  }
  unresolved(): string[] {
    return this.#db.prepare("SELECT run_id FROM device_executions WHERE json_extract(value,'$.state')='unknown' LIMIT 100").all().map(row => String(row.run_id));
  }
  markReleased(runId: string): void {
    this.#db.prepare("UPDATE device_preparations SET value=json_set(value,'$.released',json('true'),'$.releasedAt',?) WHERE run_id=?").run(Date.now(), runId);
  }
  observe(runId: string, kind: string, payload: unknown): boolean {
    const encoded = JSON.stringify(payload ?? null), bytes = Buffer.byteLength(encoded);
    const stats = this.#db.prepare('SELECT event_count,event_bytes,truncated FROM device_event_stats WHERE run_id=?').get(runId);
    if (stats?.truncated) return false;
    const exceeded = bytes > this.#limits.maxEventBytes || Number(stats?.event_count ?? 0) >= this.#limits.maxRunEvents || Number(stats?.event_bytes ?? 0) + bytes > this.#limits.maxRunEventBytes;
    const content = exceeded ? JSON.stringify({ type: 'history_truncated', reason: 'observation_retention_limit' }) : encoded;
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('INSERT INTO device_events (run_id,kind,payload) VALUES (?,?,?)').run(runId, exceeded ? 'history_truncated' : kind, content);
      this.#db.prepare(`INSERT INTO device_event_stats VALUES (?,1,?,?) ON CONFLICT(run_id) DO UPDATE SET event_count=event_count+1,event_bytes=event_bytes+excluded.event_bytes,truncated=excluded.truncated`).run(runId, Buffer.byteLength(content), exceeded ? 1 : 0);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return !exceeded;
  }
  events(runId: string, after: number): { sequence: number; kind: string; payload: unknown }[] {
    if (this.get(runId)?.detailsExpired) throw new Error('execution_details_expired');
    const result: { sequence: number; kind: string; payload: unknown }[] = []; let bytes = 0;
    for (const row of this.#db.prepare(`SELECT sequence,kind,CASE WHEN length(CAST(payload AS BLOB))>? THEN json_object('type','observation_omitted','reason','observation_bytes_exceeded','originalKind',kind,'bytes',length(CAST(payload AS BLOB))) ELSE payload END AS payload FROM device_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 100`).iterate(this.#limits.maxEventBytes, runId, after)) {
      const text = String(row.payload); bytes += Buffer.byteLength(text);
      if (result.length && bytes > this.#limits.maxPageBytes) break;
      result.push({ sequence: Number(row.sequence), kind: String(row.kind), payload: JSON.parse(text) });
    }
    return result;
  }
  expirePreparations(before: number): { runId: string; directories: PreparedDirectories }[] {
    return this.#db.prepare(`SELECT run_id,value FROM device_preparations p WHERE NOT EXISTS(SELECT 1 FROM device_executions e WHERE e.run_id=p.run_id) AND coalesce(json_extract(value,'$.released'),0)=0 AND json_extract(value,'$.createdAt')<? LIMIT 100`).all(before).map(row => ({ runId: String(row.run_id), directories: (JSON.parse(String(row.value)) as StoredPreparation).directories }));
  }
  expireDetails(now = Date.now()): number {
    const rows = this.#db.prepare(`SELECT e.run_id FROM device_executions e JOIN device_preparations p ON p.run_id=e.run_id
      WHERE json_extract(e.value,'$.state') IN ('completed','cancelled','failed') AND coalesce(json_extract(e.value,'$.detailsExpired'),0)=0
      AND json_extract(p.value,'$.released')=1 AND max(json_extract(e.value,'$.settledAt'),json_extract(p.value,'$.releasedAt'))<? LIMIT 100`).all(now - this.#limits.historyRetentionMs);
    this.#db.exec('BEGIN');
    try {
      for (const row of rows) {
        this.#db.prepare("UPDATE device_executions SET value=json_set(json_remove(value,'$.result','$.environment'),'$.detailsExpired',json('true')) WHERE run_id=?").run(row.run_id!);
        this.#db.prepare('DELETE FROM device_events WHERE run_id=?').run(row.run_id!);
        this.#db.prepare('DELETE FROM device_event_stats WHERE run_id=?').run(row.run_id!);
      }
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    // Reclaim large freed SQLite pages only during idle maintenance, never during execution.
    const pages = Number(this.#db.prepare('PRAGMA page_count').get()?.page_count), free = Number(this.#db.prepare('PRAGMA freelist_count').get()?.freelist_count);
    if (free > 1024 && free > pages / 2) this.#db.exec('VACUUM');
    return rows.length;
  }
  storageUsage(): { databaseBytes: number; identities: number } {
    const pages = Number(this.#db.prepare('PRAGMA page_count').get()?.page_count), size = Number(this.#db.prepare('PRAGMA page_size').get()?.page_size);
    const row = this.#db.prepare('SELECT count(*) AS count FROM (SELECT run_id FROM device_preparations UNION SELECT run_id FROM device_executions)').get();
    return { databaseBytes: pages * size, identities: Number(row?.count ?? 0) };
  }
  assertCapacity(runId?: string): void {
    const exists = runId !== undefined && (this.preparation(runId) !== undefined || this.get(runId) !== undefined);
    const usage = this.storageUsage();
    if (!exists && usage.identities >= this.#limits.maxIdentities || usage.databaseBytes >= this.#limits.maxStateBytes) throw new Error('node_storage_full');
  }
  assertSessionOpen(sessionKey: string): void {
    if (this.#db.prepare('SELECT 1 FROM device_closed_sessions WHERE session_key=?').get(sessionKey)) throw new Error('session_forgotten');
  }
  forgetSession(sessionKey: string): { runIds: string[] } {
    const blocked = this.#db.prepare(`SELECT 1 FROM device_preparations p LEFT JOIN device_executions e ON e.run_id=p.run_id
      WHERE json_extract(p.value,'$.sessionKey')=? AND (coalesce(json_extract(p.value,'$.released'),0)=0 OR json_extract(e.value,'$.state') IN ('running','unknown')) LIMIT 1`).get(sessionKey);
    if (blocked) throw new Error('session_in_use');
    const rows = this.#db.prepare("SELECT run_id FROM device_preparations WHERE json_extract(value,'$.sessionKey')=?").all(sessionKey);
    if (!rows.length) throw new Error('session_not_found');
    this.#db.prepare('INSERT OR IGNORE INTO device_closed_sessions VALUES (?)').run(sessionKey);
    return { runIds: rows.map(row => String(row.run_id)) };
  }
  close(): void { this.#db.close(); }
}
