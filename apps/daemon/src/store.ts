import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DockError, terminal, type RunSnapshot, type RunSummary } from '@harness-dock/protocol';

/** Single-process durable admission and observations, never a replay queue. */
export class RunStore {
  private readonly db: DatabaseSync;
  constructor(nodeId: string, directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = directory ? join(directory, 'runs.sqlite') : ':memory:';
    this.db = new DatabaseSync(path);
    try {
      if (directory) chmodSync(path, 0o600);
      this.db.exec(`
        PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS node (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL
        );
        COMMIT;
      `);
      const owner = this.db.prepare('SELECT id FROM node').get();
      if (owner && owner.id !== nodeId) throw new DockError('state_node_mismatch');
      if (!owner) this.db.prepare('INSERT INTO node VALUES (?)').run(nodeId);
      for (const row of this.db.prepare("SELECT snapshot FROM runs WHERE state IN ('running', 'cancel_requested')").all()) {
        const snapshot = JSON.parse(row.snapshot as string) as RunSnapshot;
        snapshot.state = 'outcome_unknown';
        snapshot.error = 'Daemon restarted before confirmed completion; execution was not replayed.';
        snapshot.permissions = [];
        snapshot.finalAnswer = null;
        snapshot.sequence++;
        this.save(snapshot);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get(runId: string): { input: string; snapshot: RunSnapshot; } | undefined {
    const row = this.db.prepare('SELECT input, snapshot FROM runs WHERE run_id=?').get(runId);
    return row ? { input: row.input as string, snapshot: JSON.parse(row.snapshot as string) } : undefined;
  }
  admit(input: string, snapshot: RunSnapshot): void {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)')
      .run(snapshot.runId, input, snapshot.state, JSON.stringify(snapshot));
  }
  save(snapshot: RunSnapshot): void {
    this.db.prepare('UPDATE runs SET state=?, snapshot=? WHERE run_id=?')
      .run(snapshot.state, JSON.stringify(snapshot), snapshot.runId);
  }
  list(limit: number, offset: number): RunSummary[] {
    return this.db.prepare('SELECT snapshot FROM runs ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset).map((row) => {
        const snapshot = JSON.parse(row.snapshot as string) as RunSnapshot;
        const { runId, sessionId, daemonId, nodeId, state } = snapshot;
        return { runId, sessionId, daemonId, nodeId, state, finalAnswerAvailable: terminal(state) && snapshot.finalAnswer !== null };
      });
  }
  close(): void { this.db.close(); }
}
