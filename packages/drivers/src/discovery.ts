import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { installedVersion, pathCandidates, usableFile } from './installation-lookup.ts';
import { discoverCodexInstallation } from './codex-environment.ts';

export type ProviderKey = 'codex' | 'lobi' | 'deepseek-harness';
export interface ProviderOverride {
  executable?: string;
  home?: string;
  disabled?: boolean;
  /** Local-owner-selected proxy/certificate dependencies; never remote execution input. */
  environment?: Record<string, string>;
}
export interface ProviderDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  overrides?: Partial<Record<ProviderKey, ProviderOverride>>;
  signal?: AbortSignal;
}
export interface DiscoveredProvider {
  key: ProviderKey;
  displayName: string;
  /** Installation evidence only; authentication and protocol readiness require a separate probe. */
  status: 'installed' | 'not_found' | 'disabled';
  executable: string | null;
  home: string | null;
  version: string | null;
  source: 'bundled' | 'managed' | 'path' | 'app' | 'configured' | null;
  candidates: string[];
  reason?: string;
}
type Candidate = { path: string; source: NonNullable<DiscoveredProvider['source']> };
const providers: { key: ProviderKey; displayName: string; command: string; home: string; homeEnv?: string }[] = [
  { key: 'codex', displayName: 'Codex', command: 'codex', home: '.codex', homeEnv: 'CODEX_HOME' },
  { key: 'lobi', displayName: 'Lobi', command: 'codewiz', home: '.codewiz' },
  { key: 'deepseek-harness', displayName: 'DeepSeek Harness', command: 'dsh', home: '.dsh', homeEnv: 'DSH_HOME' },
];

async function managedLobi(home: string): Promise<Candidate[]> {
  const root = join(home, '.codewiz', 'acp-servers', 'codewiz-cli');
  try {
    const versions = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+/u.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map(version => ({ path: join(root, version, 'node_modules', '@xhs', 'codewiz', 'bin', 'codewiz'), source: 'managed' }));
  } catch { return []; }
}

/** Discover supported installations without reading credentials, opening login, or sending model prompts. */
export async function discoverProviders(options: ProviderDiscoveryOptions = {}): Promise<DiscoveredProvider[]> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  return Promise.all(providers.map(async provider => {
    options.signal?.throwIfAborted();
    const override = options.overrides?.[provider.key];
    if (provider.key === 'codex') return discoverCodexInstallation({ environment, homeDirectory: home, override, signal: options.signal });
    const executableOverride = override?.executable;
    const descriptor: DiscoveredProvider = {
      key: provider.key, displayName: provider.displayName, status: 'not_found', executable: null,
      home: resolve(override?.home ?? (provider.homeEnv ? environment[provider.homeEnv] : undefined) ?? join(home, provider.home)),
      version: null, source: null, candidates: [],
    };
    if (override?.disabled) return { ...descriptor, status: 'disabled' as const };
    let candidates: Candidate[] = [];
    if (executableOverride) {
      if (executableOverride.includes('/') || executableOverride.includes('\\')) {
        candidates = [{ path: resolve(executableOverride), source: 'configured' }];
      } else {
        candidates = (await pathCandidates(executableOverride, environment, options.signal)).map(candidate => ({ ...candidate, source: 'configured' }));
      }
    } else {
      if (provider.key === 'lobi') candidates.push(...await managedLobi(home));
      const localInstallation = (await Promise.all(candidates.map(candidate => usableFile(candidate.path, /\.[cm]?js$/u.test(candidate.path))))).some(Boolean);
      candidates.push(...await pathCandidates(provider.command, environment, options.signal, !localInstallation));

    }
    const available: Candidate[] = [];
    for (const candidate of candidates) {
      options.signal?.throwIfAborted();
      if (!available.some(value => value.path === candidate.path) && await usableFile(candidate.path, /\.[cm]?js$/u.test(candidate.path))) available.push(candidate);
    }
    const selected = available[0];
    if (!selected) return { ...descriptor, reason: executableOverride ? 'Configured executable not found' : 'Supported installation not found' };
    return { ...descriptor, status: 'installed' as const,
      executable: selected.path,
      home: descriptor.home, source: selected.source,
      candidates: available.map(candidate => candidate.path), version: await installedVersion(selected.path, provider.key) };
  }));
}
