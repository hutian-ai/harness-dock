import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEVICE_PROTOCOL_VERSION } from '@harness-dock/protocol';

const manifestName = 'dock-release.json';
type ReleaseEntry = { path: string; mode: number; sha256: string } | { path: string; link: string };
export interface ReleaseManifest {
  format: 1; stateFormat: 1; protocol: number; platform: string; arch: string;
  version: string; revision?: string; entries: ReleaseEntry[];
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Include every file and preserve relative links; installed releases cannot depend on a checkout. */
async function entries(directory: string): Promise<ReleaseEntry[]> {
  const root = await realpath(directory), result: ReleaseEntry[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name), key = relative(root, file);
      if (key === manifestName) continue;
      const info = await lstat(file);
      if (info.isDirectory()) await visit(file);
      else if (info.isSymbolicLink()) {
        const link = await readlink(file);
        if (isAbsolute(link) || !inside(root, await realpath(file))) throw new Error(`release_external_symlink:${key}`);
        result.push({ path: key, link });
      } else if (info.isFile()) result.push({ path: key, mode: info.mode & 0o777, sha256: await fileDigest(file) });
      else throw new Error(`release_special_file:${key}`);
    }
  }
  await visit(root);
  return result;
}

export async function writeReleaseManifest(directory: string, revision?: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@harness-dock/daemon' || typeof pkg.version !== 'string') throw new Error('invalid_daemon_bundle');
  const manifest: ReleaseManifest = { format: 1, stateFormat: 1, protocol: DEVICE_PROTOCOL_VERSION,
    platform: process.platform, arch: process.arch, version: pkg.version,
    ...(revision ? { revision } : {}), entries: await entries(directory) };
  await writeFile(join(directory, manifestName), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
}

export async function verifyRelease(directory: string): Promise<{ id: string; manifest: ReleaseManifest }> {
  const path = resolve(directory), text = await readFile(join(path, manifestName), 'utf8');
  const manifest = JSON.parse(text) as ReleaseManifest;
  // State/protocol changes require an explicit migration, rather than an unsafe binary rollback.
  if (manifest.format !== 1 || manifest.stateFormat !== 1 || manifest.protocol !== DEVICE_PROTOCOL_VERSION) throw new Error('incompatible_release_format');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('release_platform_mismatch');
  if (!Array.isArray(manifest.entries) || !manifest.entries.length || typeof manifest.version !== 'string') throw new Error('invalid_release_manifest');
  if (JSON.stringify(await entries(path)) !== JSON.stringify(manifest.entries)) throw new Error('release_integrity_mismatch');
  if (!(await lstat(join(path, 'dist/cli.js'))).isFile()) throw new Error('invalid_daemon_entrypoint');
  return { id: digest(text), manifest };
}
