import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertWindowsPrivatePath } from '@harness-dock/drivers';
import { deviceBootIdentity } from './device-boot.ts';

export interface LegacyLockStatus { supported: boolean; checkpointId?: string; requiresRestart: boolean; canRecover: boolean }
interface LegacyCheckpoint { version: 1; id: string; bootId: string; fingerprint: string }
async function kernelMarker(path: string, key?: string): Promise<boolean> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return false; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077)) return false;
    await assertWindowsPrivatePath(path);
    const value = JSON.parse(await file.readFile('utf8')) as { harnessDockOperationOwner: number; key: string };
    return value.harnessDockOperationOwner === 1 && /^[a-f0-9]{64}$/u.test(value.key) && (key === undefined || value.key === key)
      && Object.keys(value).every(field => ['harnessDockOperationOwner', 'key'].includes(field));
  } catch { return false; }
  finally { await file.close(); }
}
async function removeSameFile(path: string, expected: string): Promise<void> {
  if (await fingerprint(path) !== expected) throw new Error('legacy_lock_changed');
  const retiring = `${path}.retiring.${randomUUID()}`;
  await rename(path, retiring);
  if (await fingerprint(retiring) !== expected) {
    // A replacement raced the move: restore it exclusively, or preserve both copies for inspection.
    try { await link(retiring, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    throw new Error('legacy_lock_changed');
  }
  await rm(retiring);
  if (await fingerprint(path)) throw new Error('legacy_lock_changed');
}
async function archiveSameFile(path: string, expected: string, archive: string): Promise<void> {
  try { await link(path, archive); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (await fingerprint(archive) !== expected || await fingerprint(path) !== expected) throw new Error('legacy_lock_changed');
  await removeSameFile(path, expected);
}
async function fingerprint(path: string): Promise<string | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('legacy_lock_changed'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('legacy_lock_changed');
    await assertWindowsPrivatePath(path);
    return createHash('sha256').update(`${info.dev}:${info.ino}:${info.size}:`).update(await file.readFile()).digest('hex');
  } finally { await file.close(); }
}
async function checkpoint(path: string): Promise<LegacyCheckpoint | undefined> {
  let file;
  try { file = await open(`${path}.recovery.json`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('legacy_lock_changed'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('legacy_lock_changed');
    await assertWindowsPrivatePath(`${path}.recovery.json`);
    const value = JSON.parse(await file.readFile('utf8')) as LegacyCheckpoint;
    if (value.version !== 1 || !/^[a-f0-9-]{36}$/iu.test(value.id) || !/^[a-f0-9]{64}$/u.test(value.bootId)
      || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) throw new Error('legacy_lock_changed');
    return value;
  } finally { await file.close(); }
}
/** Explicit migration for old ownerless files; a host reboot proves their original writer cannot still run. */
export async function legacyOperationRecovery(path: string, operation: 'status' | 'prepare' | 'recover', id?: string): Promise<LegacyLockStatus | undefined> {
  if (await kernelMarker(path)) return undefined;
  const current = await fingerprint(path);
  if (!current) return undefined;
  const bootId = deviceBootIdentity();
  if (!bootId) {
    if (operation !== 'status') throw new Error('legacy_lock_recovery_unsupported');
    return { supported: false, requiresRestart: false, canRecover: false };
  }
  let saved = await checkpoint(path);
  if (saved && saved.fingerprint !== current) {
    // An earlier migration may have archived its lock before removing its checkpoint.
    // A different current lock needs a fresh explicit prepare and a new host restart.
    if (operation === 'status') return { supported: true, requiresRestart: false, canRecover: false };
    if (operation !== 'prepare') throw new Error('legacy_lock_changed');
    const previousPath = `${path}.recovery.json`, previousIdentity = await fingerprint(previousPath);
    const previous = await checkpoint(path);
    if (!previousIdentity || !previous || previous.id !== saved.id || previous.bootId !== saved.bootId || previous.fingerprint !== saved.fingerprint)
      throw new Error('legacy_lock_changed');
    await archiveSameFile(previousPath, previousIdentity, `${previousPath}.retired.${saved.id}`);
    if (await fingerprint(path) !== current) throw new Error('legacy_lock_changed');
    saved = undefined;
  }
  if (operation === 'prepare' && !saved) {
    saved = { version: 1, id: randomUUID(), bootId, fingerprint: current };
    const temporary = `${path}.recovery.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(saved)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, `${path}.recovery.json`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        saved = await checkpoint(path);
        if (!saved || saved.fingerprint !== current) throw new Error('legacy_lock_changed');
      }
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  }
  const canRecover = !!saved && saved.bootId !== bootId;
  if (operation === 'recover') {
    if (!saved || saved.id !== id) throw new Error('legacy_lock_changed');
    if (!canRecover) throw new Error('legacy_lock_restart_required');
    if (await fingerprint(path) !== saved.fingerprint) throw new Error('legacy_lock_changed');
    const archive = `${path}.retired.${saved.id}`;
    // Publish without replacement. An interrupted migration can resume only its exact original inode/content.
    await archiveSameFile(path, saved.fingerprint, archive);
    await rm(`${path}.recovery.json`);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return undefined;
  }
  return { supported: true, checkpointId: saved?.id, requiresRestart: !!saved && !canRecover, canRecover };
}

/** Kernel-held local ownership. Process exit releases it; elapsed time and saved PIDs never do. */
export async function withOperationOwner<T>(options: {
  path: string; legacyPath: string; busy: string; legacy: string; invalid: string; recoverLegacy?: boolean;
}, operation: (ensureCompatibilityGuard: () => Promise<void>) => Promise<T>): Promise<T> {
  const parent = await lstat(dirname(options.path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.uid !== process.getuid?.() || parent.mode & 0o022))
    throw new Error(options.invalid);
  await assertWindowsPrivatePath(dirname(options.path));
  try { const file = await open(options.path, 'wx', 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(options.path);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
    throw new Error(options.invalid);
  await assertWindowsPrivatePath(options.path);
  const owner = new DatabaseSync(options.path);
  let ownMarker: string | undefined;
  try {
    try { owner.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;'); }
    catch (error) {
      if (/locked|busy/iu.test(error instanceof Error ? error.message : '')) throw new Error(options.busy);
      throw error;
    }
    const key = createHash('sha256').update(options.path).digest('hex');
    const existing = await fingerprint(options.legacyPath);
    if (existing) {
      if (await kernelMarker(options.legacyPath, key)) {
        // Obtaining this exact kernel owner proves the earlier marked helper has exited.
        const archive = `${options.legacyPath}.kernel-retired.${randomUUID()}`;
        await link(options.legacyPath, archive);
        if (await fingerprint(archive) !== existing) throw new Error(options.invalid);
        await removeSameFile(options.legacyPath, existing);
      } else if (!options.recoverLegacy) throw new Error(options.legacy);
    }
    const guard = async () => {
      if (ownMarker || options.recoverLegacy && await fingerprint(options.legacyPath)) return;
      try { await lstat(dirname(options.legacyPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const temporary = `${options.legacyPath}.kernel.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ harnessDockOperationOwner: 1, key })); await file.sync(); } finally { await file.close(); }
        try { await link(temporary, options.legacyPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(options.legacy); throw error; }
        ownMarker = await fingerprint(options.legacyPath);
      } finally { await rm(temporary, { force: true }); }
    };
    await guard();
    return await operation(guard);
  } finally {
    try { if (ownMarker) await removeSameFile(options.legacyPath, ownMarker); }
    finally { owner.close(); }
  }
}
