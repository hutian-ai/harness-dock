import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id as uuid } from '@harness-dock/protocol';

export interface SelfTestSnapshot {
  id: string;
  runId: string;
  daemonId: string;
  state: 'running' | 'passed' | 'failed' | 'unknown';
  phase: 'checking' | 'executing' | 'finished';
  startedAt: number;
  finishedAt?: number;
  model?: string;
  code?: string;
}
export interface SelfTestOutcome {
  state: 'passed' | 'failed' | 'unknown';
  model?: string;
  code?: string;
}
type Progress = (phase: 'checking' | 'executing', model?: string) => void;
type Run = (id: string, progress: Progress) => Promise<SelfTestOutcome>;

const MAX_BYTES = 4096;
const fields = new Set(['id', 'runId', 'daemonId', 'state', 'phase', 'startedAt', 'finishedAt', 'model', 'code']);
const modelValid = (value: unknown) => value === undefined || typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f]/u.test(value);
const codeValid = (value: unknown) => value === undefined || typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,127}$/u.test(value);
const storageError = () => new Error('self_test_storage_unavailable');

function snapshot(value: unknown): SelfTestSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !fields.has(key)) || !uuid.safeParse(item.id).success || item.runId !== item.id
    || !uuid.safeParse(item.daemonId).success || !['running', 'passed', 'failed', 'unknown'].includes(String(item.state))
    || !['checking', 'executing', 'finished'].includes(String(item.phase))
    || !Number.isSafeInteger(item.startedAt) || Number(item.startedAt) < 0
    || item.finishedAt !== undefined && (!Number.isSafeInteger(item.finishedAt) || Number(item.finishedAt) < Number(item.startedAt))
    || item.state === 'running' && (item.phase === 'finished' || item.finishedAt !== undefined)
    || item.phase !== 'finished' && item.finishedAt !== undefined
    || item.phase === 'finished' && item.finishedAt === undefined
    || ['passed', 'failed'].includes(String(item.state)) && item.phase !== 'finished'
    || !modelValid(item.model) || !codeValid(item.code)) throw storageError();
  return { ...item } as unknown as SelfTestSnapshot;
}

/** A local owner's fixed diagnostic job. Receipts restore observation, never model dispatch. */
export class DeviceSelfTest {
  readonly #path: string;
  readonly #run: Run;
  readonly #stateDir: string;
  readonly #daemonId: string;
  #status?: SelfTestSnapshot;
  #running = false;
  #storageFault = false;
  #unconfirmed = false;

  constructor(stateDir: string, daemonId: string, run: Run) {
    if (!uuid.safeParse(daemonId).success) throw new Error('invalid_self_test_id');
    this.#stateDir = stateDir; this.#daemonId = daemonId; this.#run = run;
    this.#path = join(stateDir, 'self-test.json');
    try {
      this.#directory();
      this.#status = this.#read();
      if (this.#status?.state === 'running' || this.#status && this.#status.phase !== 'finished') {
        this.#status = { ...this.#status, state: 'unknown', phase: 'finished', code: 'self_test_interrupted',
          finishedAt: Math.max(Date.now(), this.#status.startedAt) };
        this.#persist(this.#status);
      }
    } catch { this.#storageFault = true; }
  }

  get status(): SelfTestSnapshot | undefined { return this.#status ? { ...this.#status } : undefined; }
  get running(): boolean { return this.#running; }

  start(id: string): SelfTestSnapshot {
    if (!uuid.safeParse(id).success) throw new Error('invalid_self_test_id');
    if (this.#status?.id === id) return { ...this.#status };
    if (this.#running) throw new Error('device_busy');
    if (this.#storageFault) throw storageError();
    const next: SelfTestSnapshot = { id, runId: id, daemonId: this.#daemonId, state: 'running', phase: 'checking', startedAt: Date.now() };
    try { this.#persist(next); } catch { this.#storageFault = true; throw storageError(); }
    this.#status = next; this.#running = true; this.#unconfirmed = false;
    // The durable start receipt exists before the first native operation can run.
    void Promise.resolve().then(() => this.#run(id, (phase, model) => this.#progress(id, phase, model))).then(
      outcome => this.#finish(id, outcome),
      () => this.#finish(id, { state: 'unknown', code: 'self_test_unconfirmed' }),
    ).finally(() => { this.#running = false; });
    return { ...next };
  }

  #progress(id: string, phase: 'checking' | 'executing', model?: string): void {
    if (!this.#running || this.#status?.id !== id || this.#storageFault || this.#unconfirmed) return;
    if (!['checking', 'executing'].includes(phase) || !modelValid(model)) {
      this.#unconfirmed = true;
      this.#status = { ...this.#status, state: 'unknown', code: 'self_test_unconfirmed' };
      return;
    }
    const next = { ...this.#status, phase, ...(model ? { model } : {}) };
    try { this.#persist(next); this.#status = next; }
    catch { this.#storageFault = true; this.#status = { ...next, state: 'unknown', code: 'self_test_storage_unavailable' }; }
  }

  #finish(id: string, outcome: SelfTestOutcome): void {
    if (this.#status?.id !== id) return;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || Object.keys(outcome).some(key => !['state', 'model', 'code'].includes(key))
      || !['passed', 'failed', 'unknown'].includes(outcome.state) || !modelValid(outcome.model) || !codeValid(outcome.code)) {
      outcome = { state: 'unknown', code: 'self_test_unconfirmed' };
    }
    let next: SelfTestSnapshot = { ...this.#status, ...outcome, phase: 'finished', finishedAt: Math.max(Date.now(), this.#status.startedAt) };
    if (this.#storageFault || this.#unconfirmed) next = { ...next, state: 'unknown', code: this.#status.code ?? 'self_test_unconfirmed' };
    try { this.#persist(next); }
    catch {
      this.#storageFault = true;
      next = { ...next, state: 'unknown', code: this.#status.code ?? (next.state !== 'passed' ? next.code : undefined) ?? 'self_test_storage_unavailable' };
    }
    this.#status = next;
  }

  #directory(): void {
    mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.#stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw storageError();
  }

  #read(): SelfTestSnapshot | undefined {
    let fd: number;
    try { fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw storageError(); }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > MAX_BYTES) throw storageError();
      const bytes = Buffer.alloc(MAX_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > MAX_BYTES) throw storageError();
      return snapshot(JSON.parse(bytes.subarray(0, count).toString('utf8')));
    } finally { closeSync(fd); }
  }

  #persist(value: SelfTestSnapshot): void {
    const encoded = JSON.stringify(snapshot(value));
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw storageError();
    this.#directory();
    // Check the previous destination before atomic replacement, including changes since construction.
    try {
      const previous = lstatSync(this.#path);
      if (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== process.getuid?.() || previous.mode & 0o077) throw storageError();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const pending = `${this.#path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, encoded); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(pending, this.#path);
      const directory = openSync(this.#stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) try { unlinkSync(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
