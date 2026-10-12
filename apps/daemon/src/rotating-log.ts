import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Synchronous bounded writes avoid a second unbounded queue when disk output is slow. */
export class RotatingLog {
  #fd: number; #size: number;
  readonly #path: string;
  readonly maxBytes: number;
  readonly files: number;
  constructor(directory: string, maxBytes = 10 * 1024 * 1024, files = 3) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(files) || files < 1) throw new Error('invalid_log_limits');
    this.maxBytes = maxBytes; this.files = files;
    this.#path = join(directory, 'daemon.log');
    this.#fd = this.#open(); this.#size = fstatSync(this.#fd).size;
  }
  #open(): number {
    const fd = openSync(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) { closeSync(fd); throw new Error('unsafe_log_file'); }
    fchmodSync(fd, 0o600);
    return fd;
  }
  #rotate(): void {
    closeSync(this.#fd);
    for (let index = this.files - 1; index >= 0; index--) {
      const from = index ? `${this.#path}.${index}` : this.#path;
      try {
        const info = lstatSync(from);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe_log_file');
        if (index === this.files - 1) unlinkSync(from);
        else {
          const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
          renameSync(from, `${this.#path}.${index + 1}`);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.#fd = this.#open(); this.#size = 0;
  }
  write(value: string | Uint8Array): void {
    // A pathological single log line is truncated too, rather than rotating indefinitely.
    const cap = Math.min(this.maxBytes, 64 * 1024);
    const input = typeof value === 'string' ? Buffer.from(value.slice(-cap)) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const bytes = input.length > cap ? input.subarray(input.length - cap) : input;
    if (this.#size + bytes.length > this.maxBytes) this.#rotate();
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset, bytes.length - offset);
    this.#size += bytes.length;
  }
  close(): void { closeSync(this.#fd); }
}

export function installBackgroundLog(directory: string): void {
  const log = new RotatingLog(directory);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      log.write(typeof chunk === 'string' && typeof encoding === 'string' ? Buffer.from(chunk, encoding) : chunk);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) queueMicrotask(() => done());
      return true;
    }) as typeof stream.write;
  }
  process.once('exit', () => log.close());
}
