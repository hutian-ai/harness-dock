import { readdir, realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { DiscoveredProvider, ProviderOverride } from './discovery.ts';
import { installedVersion, pathCandidates, usableFile } from './installation-lookup.ts';

/** Installation evidence only: never read native config, credentials, or start an ACP session. */
export async function discoverDshInstallation(options: {
  environment: NodeJS.ProcessEnv; homeDirectory: string; override?: ProviderOverride; signal?: AbortSignal;
}): Promise<DiscoveredProvider> {
  const { environment, homeDirectory, override, signal } = options;
  signal?.throwIfAborted();
  const selectedHome = resolve(override?.home ?? environment.DSH_HOME ?? join(homeDirectory, '.dsh'));
  const home = await realpath(selectedHome).catch(() => selectedHome);
  const descriptor: DiscoveredProvider = { key: 'dsh', displayName: 'dsh', status: 'not_found', executable: null, home, version: null, source: null, candidates: [] };
  if (override?.disabled) return { ...descriptor, status: 'disabled' };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { ...descriptor, reason: 'dsh_unsupported_platform' };
  const explicit = override?.executable;
  let candidates: { path: string; source: DiscoveredProvider['source'] }[];
  if (explicit) candidates = explicit.includes('/') || explicit.includes('\\')
    ? [{ path: resolve(explicit), source: 'configured' }]
    : (await pathCandidates(explicit, environment, signal)).map(candidate => ({ ...candidate, source: 'configured' }));
  else {
    const ownerHome = await realpath(homeDirectory).catch(() => resolve(homeDirectory));
    const actualHome = await realpath(homedir()).catch(() => homedir());
    const shell = environment.SHELL ?? (ownerHome === actualHome ? userInfo().shell : undefined);
    candidates = await pathCandidates('dsh', { ...environment, ...(shell ? { SHELL: shell } : {}) }, signal);
    if (!candidates.length) {
      const versions = join(environment.NVM_DIR ?? join(homeDirectory, '.nvm'), 'versions', 'node');
      const entries = await readdir(versions, { withFileTypes: true }).catch(() => []);
      signal?.throwIfAborted();
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+$/u.test(entry.name)) continue;
        const path = join(versions, entry.name, 'bin', 'dsh');
        if (await usableFile(path)) candidates.push({ path, source: 'path' });
      }
      const installations = new Set(await Promise.all(candidates.map(candidate => realpath(candidate.path))));
      if (installations.size > 1) return { ...descriptor, reason: 'dsh_installation_ambiguous', candidates: candidates.map(candidate => candidate.path) };
    }
  }
  const available = candidates.filter((candidate, index) => candidates.findIndex(other => other.path === candidate.path) === index);
  for (const candidate of available) {
    signal?.throwIfAborted();
    if (!await usableFile(candidate.path)) continue;
    return { ...descriptor, status: 'installed', executable: await realpath(candidate.path), source: candidate.source,
      candidates: available.map(value => value.path), version: await installedVersion(candidate.path, '@deepseek-ai/dsh', signal) };
  }
  return { ...descriptor, reason: explicit ? 'Configured executable not found' : 'Supported installation not found' };
}
