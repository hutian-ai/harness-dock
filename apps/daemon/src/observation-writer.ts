import { boundedObservation } from '@harness-dock/drivers';

type Observation = { kind: string; payload: unknown; bytes: number };
type TextBatch = Observation & { key: string; payload: Record<string, unknown> & { text: string } };
const INTERVAL_MS = 100;
const BATCH_BYTES = 4 * 1024;
const BUFFER_BYTES = 64 * 1024;
const BUFFER_BATCHES = 16;

/** One run's bounded observation stream. Admission, permissions and cancellation stay outside it. */
export class ObservationWriter {
  #pending?: TextBatch;
  #lastKey?: string;
  #bytes = 0;
  #batches = 0;
  #timer?: NodeJS.Timeout;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #failed = false;
  #failure: unknown;
  #wake!: () => void;
  readonly #stopped = new Promise<void>(resolve => { this.#wake = resolve; });
  readonly #abort = () => this.close();
  readonly #send: (kind: string, payload: unknown) => Promise<void>;
  readonly #signal: AbortSignal;

  constructor(send: (kind: string, payload: unknown) => Promise<void>, signal: AbortSignal) {
    this.#send = send;
    this.#signal = signal;
    if (signal.aborted) this.close();
    else signal.addEventListener('abort', this.#abort, { once: true });
  }

  #check(): boolean {
    if (this.#failed) throw this.#failure;
    return !this.#closed;
  }
  #queue(observation: Observation): void {
    this.#tail = this.#tail.then(async () => {
      if (!this.#closed) await this.#send(observation.kind, observation.payload);
    }).catch(error => {
      this.#failed = true;
      this.#failure = error;
      this.close();
    }).finally(() => { this.#bytes -= observation.bytes; this.#batches--; });
  }
  #flush(): void {
    clearTimeout(this.#timer); this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) this.#queue(pending);
  }
  /** Close a text batch at a control boundary without waiting for its network receipt. */
  seal(): void {
    if (this.#closed) return;
    this.#flush();
    this.#lastKey = undefined;
  }
  async #drain(): Promise<void> {
    this.#flush();
    await Promise.race([this.#tail, this.#stopped]);
    this.#check();
  }
  async #reserve(bytes: number): Promise<boolean> {
    while (this.#bytes + bytes > BUFFER_BYTES || this.#batches >= BUFFER_BATCHES) {
      await this.#drain();
      if (!this.#check()) return false;
    }
    if (!this.#check()) return false;
    this.#bytes += bytes;
    this.#batches++;
    return true;
  }
  async write(kind: string, payload: unknown): Promise<void> {
    if (!this.#check()) return;
    payload = boundedObservation(kind, payload);
    const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const bytes = typeof value?.text === 'string' ? Buffer.byteLength(value.text, 'utf8') : 0;
    if (kind !== 'event' || value?.type !== 'text_delta' || typeof value.messageId !== 'string' || !value.messageId
      || typeof value.text !== 'string' || !bytes || bytes > BATCH_BYTES) {
      await this.#drain();
      if (!this.#check()) return;
      this.#lastKey = undefined;
      if (!await this.#reserve(0)) return;
      this.#queue({ kind, payload, bytes: 0 });
      await Promise.race([this.#tail, this.#stopped]);
      this.#check();
      return;
    }
    const { text, ...envelope } = value;
    // Include every routing field (message, stream, phase, tag, etc.), preserving unknown metadata.
    const key = JSON.stringify(Object.fromEntries(Object.entries(envelope).sort(([a], [b]) => a.localeCompare(b))));
    if (this.#lastKey !== key) {
      await this.#drain();
      if (!this.#check()) return;
    }
    if (this.#pending && this.#pending.bytes + bytes > BATCH_BYTES) this.#flush();
    if (!await this.#reserve(bytes)) return;
    if (this.#closed) {
      this.#bytes -= bytes; this.#batches--;
      this.#check();
      return;
    }
    if (this.#pending && (this.#pending.key !== key || this.#pending.bytes + bytes > BATCH_BYTES)) this.#flush();
    const first = this.#lastKey !== key;
    this.#lastKey = key;
    if (this.#pending) {
      this.#pending.payload.text += text;
      this.#pending.bytes += bytes;
      this.#batches--;
    } else this.#pending = { kind, key, payload: { ...value, text: text as string }, bytes };
    if (first || this.#pending.bytes >= BATCH_BYTES) this.#flush();
    else if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#flush(); }, INTERVAL_MS);
      this.#timer.unref();
    }
  }
  /** Provider completion cannot overtake already accepted observations. */
  async finish(): Promise<void> { await this.#drain(); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer); this.#timer = undefined;
    this.#bytes -= this.#pending?.bytes ?? 0;
    if (this.#pending) this.#batches--;
    this.#pending = undefined;
    this.#signal.removeEventListener('abort', this.#abort);
    this.#wake();
  }
}
