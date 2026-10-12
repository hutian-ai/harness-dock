import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
export const MAX_OBSERVATION_BYTES = 256 * 1024;
// JSON can escape one byte as six characters. The answer limit is enforced again after parsing.
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

export class AnswerBudget {
  #bytes = 0;
  add(text: string): void {
    this.#bytes += Buffer.byteLength(text, 'utf8');
    if (this.#bytes > MAX_ANSWER_BYTES) throw new Error('resource_exhausted:answer_bytes');
  }
}

/** Read an ordinary unchanged file without trusting a stat followed by an unbounded readFile. */
export async function readBoundedText(path: string, limit: number): Promise<string> {
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error('unsafe_evidence_file');
  if (expected.size > limit) throw new Error('resource_exhausted:file_bytes');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error('unsafe_evidence_file');
    if (before.size > limit) throw new Error('resource_exhausted:file_bytes');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await file.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('evidence_file_changed');
    return bytes.subarray(0, count).toString('utf8');
  } finally { await file.close(); }
}

/** Observation limits never alter the authoritative Provider result. */
export function boundedObservation(kind: string, payload: unknown): unknown {
  const bytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  return bytes <= MAX_OBSERVATION_BYTES ? payload
    : { type: 'observation_omitted', reason: 'observation_bytes_exceeded', originalKind: kind, bytes };
}
