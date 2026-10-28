import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from './process-command.ts';
import type { DiscoveredProvider } from './discovery.ts';

type Candidate = { path: string; source: NonNullable<DiscoveredProvider['source']> };

export async function usableFile(path: string, nodeScript = false): Promise<boolean> {
  try {
    await access(path, nodeScript ? constants.R_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}

export async function installedVersion(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    let directory = dirname(canonical);
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
        const expected = /^@openai\/codex$/u;
        if (typeof pkg.name === 'string' && expected.test(pkg.name) && typeof pkg.version === 'string') return pkg.version;
      } catch { /* A CLI can be a native executable with no package metadata. */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Missing metadata does not imply a missing installation. */ }
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'].includes(key.toUpperCase())));
    const result = await runBoundedCommand(path, ['--version'], { env, timeoutMs: 5_000, maxOutputCharacters: 4_096 });
    return result.exitCode === 0 ? result.stdout.trim().replace(/^codex-cli\s+/u, '') : null;
  } catch { /* Installation discovery is not protocol readiness. */ }
  return null;
}

export async function pathCandidates(command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal, loginShell = true): Promise<Candidate[]> {
  const names = process.platform === 'win32'
    ? [command, ...(environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(extension => `${command}${extension.toLowerCase()}`)]
    : [command];
  const found: Candidate[] = [];
  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const path = resolve(directory, name);
      if (await usableFile(path)) found.push({ path, source: 'path' });
    }
  }
  // Desktop-launched daemons may not inherit the user's login PATH. Resolve a name only;
  // never run the provider, its login command, or an interactive setup during discovery.
  if (loginShell && !found.length && environment.SHELL && process.platform !== 'win32') {
    try {
      const result = await runBoundedCommand(environment.SHELL, ['-lic', 'command -v -- "$1"', 'harness-dock-resolve', command],
        { env: environment, signal, timeoutMs: 5_000, maxOutputCharacters: 4_096 });
      for (const line of result.stdout.trim().split(/\r?\n/u).reverse()) {
        if (result.exitCode === 0 && isAbsolute(line) && await usableFile(line)) {
          found.push({ path: line, source: 'path' });
          break;
        }
      }
    } catch { signal?.throwIfAborted(); }
  }
  return found;
}
