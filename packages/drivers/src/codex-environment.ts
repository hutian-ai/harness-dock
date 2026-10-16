import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { DiscoveredProvider, ProviderOverride } from './discovery.ts';
import type { CodexExecutionConfig } from './codex.ts';
import { installedVersion, pathCandidates, usableFile } from './installation-lookup.ts';
import { runBoundedCommand } from './process-command.ts';

const bundleIds = ['com.openai.codex', 'com.openai.codex.alpha', 'com.openai.codex.beta', 'com.openai.codex.nightly'];
const vendorTeam = '2DC432GLL2';
type Process = { pid: number; parent: number; uid: number; executable: string };
type Application = { executable: string; node: string; main: string };
type DesktopHost = NonNullable<CodexExecutionConfig['desktopHost']>;
const applicationCache = new Map<string, { stamp: string; value: Application }>();
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'].includes(key.toUpperCase())));
const command = (path: string, args: string[], signal?: AbortSignal, maxOutputCharacters = 65536) =>
  runBoundedCommand(path, args, { env: baseEnv(), signal, timeoutMs: 5000, maxOutputCharacters });

/** Only process metadata is enumerated. Other processes' arguments/environment are not read. */
export function parseCodexProcesses(text: string): Process[] {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), executable: match[4]! }] : [];
  });
}
async function processes(signal?: AbortSignal): Promise<Process[]> {
  const result = await command('/bin/ps', ['-A', '-o', 'pid=,ppid=,uid=,comm='], signal, 1024 * 1024);
  if (result.exitCode !== 0) throw new Error('codex_process_discovery_failed');
  return parseCodexProcesses(result.stdout).filter(process => process.uid === globalThis.process.getuid!());
}
function descendant(process: Process, ancestor: number, snapshot: Process[]): boolean {
  let parent = process.parent;
  for (let depth = 0; depth < 16 && parent; depth++) {
    if (parent === ancestor) return true;
    parent = snapshot.find(row => row.pid === parent)?.parent ?? 0;
  }
  return false;
}

/** Extract only named non-credential fields; never return, log or persist raw process output. */
export function codexHostFields(text: string): { pipe?: string; home?: string } {
  const pipes = [...text.matchAll(/(?:^|\s)CODEX_APP_TOOLS_PIPE_PATH=(\/tmp\/codex-browser-use\/[0-9a-f-]{36}\.sock)(?=\s|$)/gu)];
  const homes = [...text.matchAll(/(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/gu)];
  if (pipes.length > 1 || homes.length > 1) throw new Error('codex_desktop_environment_ambiguous');
  return { pipe: pipes[0]?.[1], home: homes[0]?.[1] };
}
async function samePath(a: string, b: string): Promise<boolean> {
  return (await realpath(a).catch(() => resolve(a))) === (await realpath(b).catch(() => resolve(b)));
}
async function signature(path: string, signal?: AbortSignal) {
  const [verify, identity] = await Promise.all([
    command('/usr/bin/codesign', ['--verify', '--strict', path], signal),
    command('/usr/bin/codesign', ['-dv', '--verbose=2', path], signal),
  ]);
  const metadata = identity.stderr;
  if (verify.exitCode !== 0 || identity.exitCode !== 0 || !metadata.includes(`TeamIdentifier=${vendorTeam}\n`))
    throw new Error('codex_native_signature_untrusted');
  return /^Identifier=(.+)$/mu.exec(metadata)?.[1];
}
function applicationRoot(executable: string): string | undefined {
  return /^(.*?\.app)\/Contents\//u.exec(executable)?.[1];
}
async function application(root: string, signal?: AbortSignal): Promise<Application | undefined> {
  const plist = join(root, 'Contents', 'Info.plist');
  try {
    const metadata = await command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], signal);
    if (metadata.exitCode !== 0 || !bundleIds.includes(metadata.stdout.trim())) return;
    const resources = join(root, 'Contents', 'Resources');
    const cli = [join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'), join(resources, 'codex-cli', 'bin', 'codex'), join(resources, 'codex')];
    const executable = (await Promise.all(cli.map(async path => await usableFile(path) ? path : null))).find(Boolean);
    const node = join(resources, 'cua_node', 'bin', 'node');
    const mainName = await command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], signal);
    if (!executable || !await usableFile(node) || mainName.exitCode !== 0 || basename(mainName.stdout.trim()) !== mainName.stdout.trim())
      throw new Error('codex_native_runtime_unavailable');
    const main = join(root, 'Contents', 'MacOS', mainName.stdout.trim());
    const stamp = JSON.stringify(await Promise.all([plist, main, executable, node].map(async path => { const file = await stat(path); return [file.dev, file.ino, file.size, file.mtimeMs]; })));
    const cached = applicationCache.get(root);
    if (cached?.stamp === stamp) return cached.value;
    const [appId, nodeId] = await Promise.all([signature(root, signal), signature(node, signal), signature(executable, signal)]);
    if (!bundleIds.includes(appId ?? '') || !['node', 'com.openai.codex.runtime'].includes(nodeId ?? '')) throw new Error('codex_native_signature_untrusted');
    const value = { executable: await realpath(executable), node: await realpath(node), main: await realpath(main) };
    if (applicationCache.size >= 8) applicationCache.clear();
    applicationCache.set(root, { stamp, value });
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
async function host(application: Application, home: string, snapshot: Process[], signal?: AbortSignal): Promise<DesktopHost | undefined> {
  const owners = snapshot.filter(row => row.executable === application.main);
  const matches: DesktopHost[] = [];
  for (const owner of owners) {
    const peers = snapshot.filter(row => row.executable === application.executable && descendant(row, owner.pid, snapshot));
    for (const peer of peers) {
      // ps reads only the selected installation's native app-server child. Its raw output is private and transient.
      const response = await command('/bin/ps', ['eww', '-p', String(peer.pid), '-o', 'command='], signal, 512 * 1024);
      if (response.exitCode !== 0 || !/\sapp-server(?:\s|$)/u.test(response.stdout)) continue;
      const fields = codexHostFields(response.stdout);
      if (!fields.pipe || !await samePath(fields.home ?? join(homedir(), '.codex'), home)) continue;
      const file = await lstat(fields.pipe).catch(() => null);
      if (!file?.isSocket() || file.uid !== process.getuid!() || (file.mode & 0o077) !== 0) continue;
      const owned = await command('/usr/sbin/lsof', ['-a', '-p', String(owner.pid), '-U', '-Fn'], signal, 512 * 1024);
      if (owned.exitCode !== 0 || !owned.stdout.split('\n').includes(`n${fields.pipe}`)) continue;
      const current = await command('/bin/ps', ['-p', String(peer.pid), '-o', 'pid=,ppid=,uid=,comm='], signal);
      if (!parseCodexProcesses(current.stdout).some(row => row.pid === peer.pid && row.parent === peer.parent && row.uid === peer.uid && row.executable === peer.executable)) continue;
      if (!matches.some(match => match.pipePath === fields.pipe)) matches.push({ pipePath: fields.pipe, nodePath: application.node });
    }
  }
  if (matches.length > 1) throw new Error('codex_desktop_host_ambiguous');
  return matches[0];
}
async function applicationCandidates(home: string, snapshot: Process[], signal?: AbortSignal): Promise<string[]> {
  const running = snapshot.filter(row => /\/Contents\/MacOS\/(?:ChatGPT|Codex)$/u.test(row.executable)).map(row => applicationRoot(row.executable)!);
  const defaults = [join(home, 'Applications', 'Codex.app'), join(home, 'Applications', 'ChatGPT.app'), '/Applications/Codex.app', '/Applications/ChatGPT.app'];
  // Spotlight supports renamed or relocated installations without a user-supplied runtime path.
  const search = await command('/usr/bin/mdfind', [bundleIds.map(id => `kMDItemCFBundleIdentifier == "${id}"`).join(' || ')], signal).catch(() => { signal?.throwIfAborted(); return null; });
  return [...new Set([...running, ...defaults, ...search?.stdout.split('\n').filter(Boolean) ?? []])];
}
export async function discoverCodexInstallation(options: { environment: NodeJS.ProcessEnv; homeDirectory: string; override?: ProviderOverride; signal?: AbortSignal }): Promise<DiscoveredProvider> {
  const { environment, homeDirectory, override, signal } = options;
  const home = await realpath(resolve(override?.home ?? environment.CODEX_HOME ?? join(homeDirectory, '.codex'))).catch(() => resolve(override?.home ?? environment.CODEX_HOME ?? join(homeDirectory, '.codex')));
  const descriptor: DiscoveredProvider = { key: 'codex', displayName: 'Codex', status: 'not_found', executable: null, home, version: null, source: null, candidates: [] };
  if (override?.disabled) return { ...descriptor, status: 'disabled' };
  const explicit = override?.executable ?? environment.CODEX_CLI_PATH;
  let candidates: { path: string; source: DiscoveredProvider['source'] }[] = [];
  if (explicit) candidates = explicit.includes('/') || explicit.includes('\\') ? [{ path: resolve(explicit), source: 'configured' }] : (await pathCandidates(explicit, environment, signal)).map(candidate => ({ ...candidate, source: 'configured' }));
  else {
    // A synthetic/other user's home must not discover this user's running desktop or environment.
    if (process.platform === 'darwin' && await samePath(homeDirectory, homedir())) {
      const snapshot = await processes(signal);
      const applications: { app: Application; running: boolean }[] = [];
      for (const root of await applicationCandidates(homeDirectory, snapshot, signal)) {
        if (!await stat(root).catch(() => null)) continue;
        const app = await application(root, signal);
        if (app) applications.push({ app, running: !!await host(app, home, snapshot, signal) });
      }
      const running = applications.filter(value => value.running);
      if (running.length > 1) return { ...descriptor, reason: 'codex_installation_ambiguous', candidates: running.map(value => value.app.executable) };
      const selected = running[0] ?? (applications.length === 1 ? applications[0] : undefined);
      if (!selected && applications.length > 1) return { ...descriptor, reason: 'codex_installation_ambiguous', candidates: applications.map(value => value.app.executable) };
      if (selected) candidates.push({ path: selected.app.executable, source: 'app' });
    }
    const shell = environment.SHELL ?? (process.platform !== 'win32' && await samePath(homeDirectory, homedir()) ? userInfo().shell : undefined);
    candidates.push(...await pathCandidates('codex', { ...environment, ...(shell ? { SHELL: shell } : {}) }, signal));
  }
  const available = candidates.filter((candidate, index) => candidates.findIndex(other => other.path === candidate.path) === index);
  for (const candidate of available) {
    if (!await usableFile(candidate.path)) continue;
    return { ...descriptor, status: 'installed', executable: await realpath(candidate.path), source: candidate.source, candidates: available.map(value => value.path), version: await installedVersion(candidate.path, 'codex') };
  }
  return { ...descriptor, reason: explicit ? 'Configured executable not found' : 'Supported installation not found' };
}

/** Re-resolve at explicit execution boundaries. Host transport generation never changes native storage identity. */
export async function resolveCodexEnvironment<T extends CodexExecutionConfig>(input: T, signal: AbortSignal): Promise<T & { nativeEnvironment: { id: string; kind: 'native'; contextScope: 'device_user'; discovery: 'harness'; desktopHost: string } }> {
  let desktopHost = input.desktopHost;
  let desktopState = desktopHost ? 'provided' : 'not_attached';
  let nativeNode: string | undefined;
  if (process.platform === 'darwin' && input.codexBin) {
    const root = applicationRoot(await realpath(input.codexBin).catch(() => input.codexBin!));
    const app = root ? await application(root, signal) : undefined;
    if (app) {
      if (!await samePath(input.codexBin, app.executable)) throw new Error('codex_desktop_installation_mismatch');
      nativeNode = app.node;
      desktopHost = await host(app, input.codexHome, await processes(signal), signal);
      desktopState = desktopHost ? 'discovered' : 'not_running';
    }
  }
  return { ...input, desktopHost, nativeNode, nativeEnvironment: {
    id: createHash('sha256').update(JSON.stringify([input.codexBin ?? null, input.codexHome])).digest('hex'),
    kind: 'native', contextScope: 'device_user', discovery: 'harness', desktopHost: desktopState,
  } };
}
