import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('upstream license bytes retain their recorded hashes on every checkout platform', async () => {
  const codexRoot = 'third-party/openai-codex';
  const codex = JSON.parse(await readFile(join(codexRoot, 'SOURCES.json'), 'utf8')) as { files: Record<string, { sha256: string }> };
  const rust = JSON.parse(await readFile('third-party/rust-notices/sources.json', 'utf8')) as { notices: { path: string; sha256: string }[] }[];
  const entries = [
    ...Object.entries(codex.files).map(([path, record]) => ({ path: join(codexRoot, path), sha256: record.sha256 })),
    ...rust.flatMap(pkg => pkg.notices.map(record => ({ ...record, path: join('third-party/rust-notices', record.path) }))),
  ];
  for (const entry of entries) {
    assert.equal(createHash('sha256').update(await readFile(entry.path)).digest('hex'), entry.sha256, entry.path);
  }
});
