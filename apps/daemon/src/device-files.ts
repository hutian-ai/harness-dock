import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface DeviceFile { path: string; contentBase64: string; executable?: boolean }
export interface PreparedDirectories { workdir: string; skillDirectory: string; outputDirectory: string }
export interface DeviceOutput { reference: string; name: string; sha256: string; contentBase64: string }
const MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_FILES = 64;

/** Anchor every managed ancestor; checking only the final directory misses parent links. */
async function checkedDirectories(stateDir: string, path: string): Promise<() => Promise<void>> {
  const root = resolve(stateDir), target = resolve(path), rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('unsafe_managed_directory');
  let current = root;
  const identities: { path: string; dev: number; ino: number }[] = [];
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_managed_directory');
    identities.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return async () => {
    for (const expected of identities) {
      const info = await lstat(expected.path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev || info.ino !== expected.ino)
        throw new Error('unsafe_managed_directory');
    }
  };
}

async function directory(path: string, root = path): Promise<void> {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('unsafe_managed_directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    if (part) { current = join(current, part); await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_managed_directory');
  }
}
function safeRelative(path: string): string[] {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || path.includes('\\') || parts.length > 12
    || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0')))
    throw new Error('unsafe_file_path');
  return parts;
}
export async function prepareDirectories(stateDir: string, runId: string, sessionKey: string, files: DeviceFile[], cwd: string): Promise<PreparedDirectories> {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('file_limits_exceeded');
  const seen = new Set<string>();
  let total = 0;
  const decoded = files.map(file => {
    if (typeof file.path !== 'string' || typeof file.contentBase64 !== 'string'
      || file.executable !== undefined && typeof file.executable !== 'boolean') throw new Error('invalid_file');
    const parts = safeRelative(file.path);
    if (seen.has(file.path) || file.contentBase64.length > Math.ceil(MAX_FILE / 3) * 4) throw new Error('file_limits_exceeded');
    seen.add(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64) throw new Error('invalid_base64');
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL) throw new Error('file_limits_exceeded');
    return { parts, bytes, executable: file.executable };
  });
  await directory(stateDir);
  const sessions = join(stateDir, 'sessions'), runs = join(stateDir, 'prepared');
  await directory(sessions, stateDir); await directory(runs, stateDir);
  const workdir = cwd;
  const session = join(sessions, digest(sessionKey));
  await directory(session, stateDir);
  const root = join(runs, digest(runId));
  await mkdir(root, { mode: 0o700 }); // Fresh publication boundary; caller handles idempotent preparation.
  const skillKey = digest(JSON.stringify(files.map(file => [file.path, file.contentBase64, file.executable ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  const result = { workdir, skillDirectory: join(session, `skills-${skillKey}`), outputDirectory: join(root, 'output') };
  let existingSkills = false;
  try { const info = await lstat(result.skillDirectory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_managed_directory'); existingSkills = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    await directory(result.skillDirectory, stateDir); await directory(result.outputDirectory, stateDir);
    if (existingSkills) await verifySkillFiles(stateDir, result.skillDirectory, files);
    for (const file of existingSkills ? [] : decoded) {
      let parent = result.skillDirectory;
      for (const part of file.parts.slice(0, -1)) { parent = join(parent, part); await directory(parent, stateDir); }
      const handle = await open(join(parent, file.parts.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.executable ? 0o700 : 0o600);
      try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
    }
    return result;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (!existingSkills) await rm(result.skillDirectory, { recursive: true, force: true });
    throw error;
  }
}
export async function collectFiles(stateDir: string, directory: string): Promise<DeviceOutput[]> {
  const result: DeviceOutput[] = [];
  let total = 0, visited = 0;
  const root = resolve(directory);
  const verifyRoot = await checkedDirectories(stateDir, root);
  async function visit(folder: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('file_limits_exceeded');
    const verifyFolder = await checkedDirectories(stateDir, folder);
    const entries = await readdir(folder, { withFileTypes: true });
    visited += entries.length;
    if (visited > MAX_FILES * 12 || entries.length > MAX_FILES) throw new Error('file_limits_exceeded');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('unsafe_output_path');
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!entry.isFile()) throw new Error('unsafe_output_path');
      await verifyFolder();
      const expected = await lstat(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('unsafe_output_path');
        if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL || result.length >= MAX_FILES) throw new Error('file_limits_exceeded');
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = await file.read(bytes, count, bytes.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await file.stat();
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('output_changed');
        await verifyFolder();
        const content = bytes.subarray(0, count); total += count;
        result.push({ reference: path, name: basename(path), sha256: createHash('sha256').update(content).digest('hex'), contentBase64: content.toString('base64') });
      } finally { await file.close(); }
    }
    await verifyFolder();
  }
  await visit(root, 0);
  await verifyRoot();
  return result;
}
export async function releaseDirectories(stateDir: string, runId: string): Promise<void> {
  await removeManagedDirectory(stateDir, join(stateDir, 'prepared', digest(runId)));
}

async function removeManagedDirectory(stateDir: string, target: string): Promise<void> {
  let verifyParents: () => Promise<void>;
  try { verifyParents = await checkedDirectories(stateDir, resolve(target, '..')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let verifyTarget: () => Promise<void>;
  try { verifyTarget = await checkedDirectories(stateDir, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await verifyParents(); return; } throw error; }
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const expected = await handle.stat();
    await verifyTarget();
    const quarantine = await mkdtemp(join(stateDir, '.release-'));
    const verifyQuarantine = await checkedDirectories(stateDir, quarantine);
    const moved = join(quarantine, 'run');
    await verifyTarget();
    await rename(target, moved);
    const actual = await lstat(moved);
    // A changed source is retained for inspection, never recursively deleted.
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error('unsafe_managed_directory');
    await verifyQuarantine();
    await rm(moved, { recursive: true, force: true });
    await verifyQuarantine();
    await rmdir(quarantine);
  } finally { await handle.close(); }
}

/** Reusing immutable skill paths must not trust files a provider could have changed. */
export async function verifySkillFiles(stateDir: string, directory: string, expected: DeviceFile[]): Promise<void> {
  const root = resolve(directory);
  const files = await collectFiles(stateDir, directory);
  if (files.length !== expected.length) throw new Error('skill_cache_mismatch');
  const byPath = new Map(expected.map(file => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const file of expected) {
    const parts = file.path.split('/');
    for (let end = 1; end < parts.length; end++) expectedDirectories.add(parts.slice(0, end).join('/'));
  }
  async function verifyDirectories(folder: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!expectedDirectories.has(key)) throw new Error('skill_cache_mismatch');
      await verifyDirectories(join(folder, entry.name), key);
    }
  }
  await verifyDirectories(directory);
  for (const file of files) {
    const target = byPath.get(relative(root, file.reference).split('\\').join('/'));
    if (!target || target.contentBase64 !== file.contentBase64) throw new Error('skill_cache_mismatch');
    const info = await lstat(file.reference);
    if ((info.mode & 0o777) !== (target.executable ? 0o700 : 0o600)) throw new Error('skill_cache_mismatch');
  }
}

/** Counts only managed files, without following links into the user work directory. */
export async function managedStateBytes(stateDir: string, maxBytes: number): Promise<number> {
  let bytes = 0, visited = 0;
  async function readInfo(path: string) {
    try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  function inspect(path: string, depth: number) {
    if (depth > 64 || ++visited > 200_000) { bytes = maxBytes + 1; return; }
    return readInfo(path);
  }
  async function visit(path: string, depth: number, info: Awaited<ReturnType<typeof inspect>>): Promise<void> {
    if (!info || bytes > maxBytes) return;
    // A directory may have changed while earlier batch entries were visited; recheck before opening it.
    if (info.isDirectory() && !info.isSymbolicLink()) info = await readInfo(path);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) { bytes += info.size; return; }
    const directory = await opendir(path);
    let batch: string[] = [];
    const flush = async () => {
      const paths = batch; batch = [];
      // Finish this bounded batch before descending; recursive directories cannot multiply concurrency.
      const items = await Promise.all(paths.map(child => inspect(child, depth + 1)));
      for (let index = 0; index < paths.length && bytes <= maxBytes; index++) {
        const item = items[index];
        if (!item) continue;
        if (!item.isDirectory() || item.isSymbolicLink()) bytes += item.size;
        else await visit(paths[index]!, depth + 1, item);
      }
    };
    for await (const entry of directory) {
      batch.push(join(path, entry.name));
      if (batch.length === 32) await flush();
      if (bytes > maxBytes) return;
    }
    await flush();
  }
  await visit(stateDir, 0, await inspect(stateDir, 0));
  return bytes;
}

/** Only derived homes and skills are removed; the configured cwd and original provider homes are never targets. */
export async function forgetSessionDirectories(stateDir: string, sessionKey: string): Promise<void> {
  const key = digest(sessionKey);
  for (const parts of [['sessions', key], ['providers', 'codex', key]])
    await removeManagedDirectory(stateDir, join(stateDir, ...parts));
}
