import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';

// An existing destination is rejected by pnpm; no recursive deletion of user files.
const root = resolve(process.argv[2] ?? '.local/bundle');
await mkdir(root, { recursive: true, mode: 0o700 });
for (const [name, target] of [['@harness-dock/daemon', 'daemon'], ['@harness-dock/client', 'controller'], ['@harness-dock/server', 'server']]) {
  execFileSync('pnpm', ['--filter', name!, 'deploy', '--prod', join(root, target!)], { stdio: 'inherit' });
}
// Workspace packages may be hard-linked by pnpm deploy. Detach them so later builds cannot mutate an installed release.
async function detach(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await detach(file);
    else if (entry.isFile() && (await lstat(file)).nlink > 1) {
      const copy = `${file}.dock-copy-${process.pid}`;
      await copyFile(file, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await rename(copy, file);
    }
  }
}
await detach(root);
let revision: string | undefined;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) revision += '+dirty';
} catch { /* Source archives have no Git metadata. */ }
await writeReleaseManifest(join(root, 'daemon'), revision);
console.log(`Local bundles ready: ${root}. Use node <daemon>/dist/cli.js help or node <server>/dist/cli.js run <server.json>, or node <controller>/dist/device-console.js <client.json>.`);
