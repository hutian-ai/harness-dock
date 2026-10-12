import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from './process-command.ts';

export type ProviderKey = 'codex' | 'lobi' | 'deepseek-harness' | 'zcode';
export interface ProviderOverride {
  executable?: string;
  home?: string;
  disabled?: boolean;
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
  { key: 'zcode', displayName: 'ZCode', command: 'zcode', home: '.zcode', homeEnv: 'ZCODE_HOME' },
];

async function usableFile(path: string, nodeScript = false): Promise<boolean> {
  try {
    await access(path, nodeScript ? constants.R_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}

async function installedVersion(path: string, provider: ProviderKey): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    const appRoot = canonical.match(/^(.*\.app\/Contents)\//u)?.[1];
    if (provider === 'zcode' && appRoot) {
      const plist = await readFile(join(appRoot, 'Info.plist'), 'utf8');
      return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u)?.[1] ?? null;
    }
    let directory = dirname(canonical);
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
        const expected = provider === 'codex' ? /^@openai\/codex$/u : provider === 'lobi' ? /^@xhs\/codewiz$/u : provider === 'zcode' ? /zcode/iu : /deepseek|dsh/iu;
        if (typeof pkg.name === 'string' && expected.test(pkg.name) && typeof pkg.version === 'string') return pkg.version;
      } catch { /* A CLI can be a native executable with no package metadata. */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Missing metadata does not imply a missing installation. */ }
  return null;
}

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

async function pathCandidates(command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal, loginShell = true): Promise<Candidate[]> {
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

/** Discover supported installations without reading credentials, opening login, or sending model prompts. */
export async function discoverProviders(options: ProviderDiscoveryOptions = {}): Promise<DiscoveredProvider[]> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  return Promise.all(providers.map(async provider => {
    options.signal?.throwIfAborted();
    const override = options.overrides?.[provider.key];
    const executableOverride = override?.executable ?? (provider.key === 'zcode' ? environment.ZCODE_BIN : undefined);
    const descriptor: DiscoveredProvider = {
      key: provider.key, displayName: provider.displayName, status: 'not_found', executable: null,
      home: resolve(override?.home ?? (provider.homeEnv ? environment[provider.homeEnv] : undefined) ?? join(home, provider.home)),
      version: null, source: null, candidates: [],
    };
    if (override?.disabled) return { ...descriptor, status: 'disabled' as const };
    let candidates: Candidate[] = [];
    if (provider.key === 'codex') {
      if (executableOverride) return { ...descriptor, reason: 'Codex uses the bundled adapter dependency; executable overrides are unsupported' };
      try {
        const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp');
        candidates.push({ path: createRequire(adapter).resolve('@openai/codex/bin/codex.js'), source: 'bundled' });
      } catch { return { ...descriptor, reason: 'Bundled Codex dependency is unavailable' }; }
    } else if (executableOverride) {
      if (executableOverride.includes('/') || executableOverride.includes('\\')) {
        candidates = [{ path: resolve(executableOverride), source: 'configured' }];
      } else {
        candidates = (await pathCandidates(executableOverride, environment, options.signal)).map(candidate => ({ ...candidate, source: 'configured' }));
      }
    } else {
      if (provider.key === 'lobi') candidates.push(...await managedLobi(home));
      if (provider.key === 'zcode') {
        if (process.platform === 'darwin') {
          for (const applications of [join(home, 'Applications'), '/Applications'])
            candidates.push({ path: join(applications, 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'), source: 'app' });
        }
      }
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
    return { ...descriptor, status: 'installed' as const, executable: selected.path, source: selected.source,
      candidates: available.map(candidate => candidate.path), version: await installedVersion(selected.path, provider.key) };
  }));
}
