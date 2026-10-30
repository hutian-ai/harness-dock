import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** Keep executable modes and relative links, without the builder's UID/GID in ZIP headers. */
export function createAppArchive(app: string, destination: string): void {
  const source = resolve(app), archive = resolve(destination);
  try { lstatSync(archive); throw new Error('archive_destination_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  execFileSync('/usr/bin/zip', ['-q', '-X', '-y', '-r', archive, basename(source)], {
    cwd: dirname(source), stdio: 'inherit',
  });
}
