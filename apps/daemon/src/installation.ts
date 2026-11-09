import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertWindowsPrivatePath, protectWindowsDirectory } from '@harness-dock/drivers';
import { DEVICE_PROTOCOL_VERSION } from '@harness-dock/protocol';
import { macAutostart, nativePathVariables, type Autostart } from './autostart.ts';
import { readConfig } from './config.ts';
import { control, type LocalStatus } from './local-control.ts';
import { startBackground, stopIdleDaemon, waitForDaemon } from './process-management.ts';
import { verifyRelease } from './release-manifest.ts';
import { legacyOperationRecovery, withOperationOwner } from './operation-owner.ts';

const exec = promisify(execFile);
interface Release { id: string; runtime: string; }
export interface Installation {
  format: 1; stateFormat: 1; protocol: number; configPath: string; nodeId: string; current: Release; previous?: Release;
  autostart: boolean; searchPath: string; environment?: Record<string, string>;
}
export const installationRoot = (config: string, override?: string) => resolve(override ?? join(dirname(resolve(config)), 'installation'));
const entrypoint = (root: string, release: Release) => join(root, 'releases', release.id, 'dist/cli.js');
const sameRelease = (a: Release, b: Release) => a.id === b.id && a.runtime === b.runtime;
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);

async function atomicWrite(path: string, value: string, mode = 0o600): Promise<void> {
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(pending, 'wx', mode);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(pending, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  finally { await rm(pending, { force: true }); }
}

function withInstallationOwner<T>(root: string, operation: (ensureCompatibilityGuard: () => Promise<void>) => Promise<T>, recoverLegacy = false): Promise<T> {
  return withOperationOwner({ path: join(dirname(root), `.${basename(root)}.operation-owner.sqlite`),
    legacyPath: join(root, 'operation.lock'), busy: 'installation_busy', legacy: 'installation_lock_legacy',
    invalid: 'invalid_installation_directory', recoverLegacy }, operation);
}

/** Only the selected device's standard private installation root can enter legacy lock migration. */
export async function installationLegacyRecovery(configPath: string, operation: 'status' | 'prepare' | 'recover', id?: string) {
  const config = await readConfig(configPath), root = installationRoot(configPath);
  try { await lstat(join(root, 'operation.lock')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const info = await lstat(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
    throw new Error('installation_recovery_unavailable');
  await assertWindowsPrivatePath(root);
  const record = await readInstallation(root, configPath), intent = await installIntent(root);
  if ((!record || record.nodeId !== config.nodeId) && (!intent || intent.configPath !== await realpath(configPath) || intent.nodeId !== config.nodeId))
    throw new Error('installation_recovery_unavailable');
  const path = join(root, 'operation.lock');
  if (operation === 'status') return legacyOperationRecovery(path, operation);
  return withInstallationOwner(root, () => legacyOperationRecovery(path, operation, id), true);
}

interface InstallIntent { format: 1; configPath: string; nodeId: string; releaseId: string; runtime: string }
const intentPath = (root: string) => join(dirname(root), `.${basename(root)}.install-intent.json`);
async function installIntent(root: string): Promise<InstallIntent | undefined> {
  let file;
  try { file = await open(intentPath(root), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('installation_recovery_unavailable'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('installation_recovery_unavailable');
    await assertWindowsPrivatePath(intentPath(root));
    const value = JSON.parse(await file.readFile('utf8')) as InstallIntent;
    if (value.format !== 1 || typeof value.configPath !== 'string' || !isAbsolute(value.configPath)
      || typeof value.nodeId !== 'string' || typeof value.runtime !== 'string' || !isAbsolute(value.runtime)
      || !/^[a-f0-9]{64}$/u.test(value.releaseId)
      || Object.keys(value).some(key => !['format', 'configPath', 'nodeId', 'releaseId', 'runtime'].includes(key)))
      throw new Error('installation_recovery_unavailable');
    return value;
  } finally { await file.close(); }
}
function validateRef(value: Release) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.runtime !== 'string' || !isAbsolute(value.runtime)) throw new Error('invalid_installation_record');
}
export async function readInstallation(root: string, config: string): Promise<Installation | undefined> {
  let text: string;
  try { text = await readFile(join(root, 'installation.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const value = JSON.parse(text) as Installation;
  if (value.stateFormat !== 1 || value.protocol !== DEVICE_PROTOCOL_VERSION) throw new Error('incompatible_installation_format');
  if (value.format !== 1 || value.configPath !== await realpath(config) || typeof value.autostart !== 'boolean' || typeof value.searchPath !== 'string') throw new Error('installation_config_mismatch');
  if (value.environment && Object.entries(value.environment).some(([key, item]) => !nativePathVariables.includes(key as typeof nativePathVariables[number]) || typeof item !== 'string')) throw new Error('invalid_installation_environment');
  validateRef(value.current); if (value.previous) validateRef(value.previous);
  return value;
}

async function preflight(root: string, release: Release): Promise<void> {
  const verified = await verifyRelease(join(root, 'releases', release.id));
  if (verified.id !== release.id) throw new Error('installed_release_integrity_mismatch');
  await access(release.runtime, constants.X_OK);
  const module = pathToFileURL(join(dirname(entrypoint(root, release)), 'device-main.js')).href;
  await exec(release.runtime, ['--input-type=module', '-e',
    `const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || major===22&&minor<19) throw Error('Node.js 22.19+ required'); await import(${JSON.stringify(module)});`], { timeout: 20_000, maxBuffer: 64 * 1024 });
  await exec(release.runtime, [entrypoint(root, release), 'help'], { timeout: 10_000, maxBuffer: 64 * 1024 });
}

async function stage(root: string, bundle: string, runtime: string): Promise<Release> {
  const source = await realpath(bundle);
  if (within(source, root) || within(root, source)) throw new Error('bundle_installation_overlap');
  const { id } = await verifyRelease(source);
  const selectedRuntime = await realpath(runtime), target = join(root, 'releases', id);
  // A packaged runtime moves into the immutable release with the daemon, independent of the app's location.
  const installedRuntime = within(source, selectedRuntime) ? join(target, relative(source, selectedRuntime)) : selectedRuntime;
  // CreateProcess cannot resolve a long unprefixed executable path. Keep this
  // exact spelling in the owner record because Node also reports it as execPath.
  const release = { id, runtime: process.platform === 'win32' && installedRuntime.length >= 248
    ? toNamespacedPath(installedRuntime) : installedRuntime };
  await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 });
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pending = join(root, 'releases', `.staging-${randomUUID()}`);
    try {
      await cp(source, pending, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      if ((await verifyRelease(pending)).id !== id) throw new Error('release_changed_during_copy');
      await rename(pending, target);
    } finally { await rm(pending, { recursive: true, force: true }); }
  }
  await preflight(root, release);
  return release;
}

const launcher = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), url = require('node:url');
const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'installation.json'), 'utf8'));
if (record.format !== 1 || !/^[a-f0-9]{64}$/.test(record.current.id)) throw Error('invalid_installation_record');
process.env.HARNESS_DOCK_INSTALL_DIR = __dirname;
process.env.HARNESS_DOCK_INSTALLED_CONFIG = record.configPath;
const entry = path.join(__dirname, 'releases', record.current.id, 'dist/cli.js');
process.argv[1] = entry;
import(url.pathToFileURL(entry).href).catch(error => { console.error(error.message); process.exitCode = 1; });
`;

export type InstallationCommand = 'install' | 'upgrade' | 'rollback' | 'autostart' | 'login-start';
export interface InstallationOptions {
  config: string; root?: string; bundle?: string; runtime?: string; disable?: boolean;
}
/** Injection is limited to the OS service boundary; all file checks and socket controls remain real. */
export async function manageInstallation(command: InstallationCommand, options: InstallationOptions,
  serviceFactory: (root: string, config: string, searchPath: string, environment?: Record<string, string>) => Autostart = macAutostart) {
  if (process.platform === 'win32' && (command === 'autostart' || command === 'login-start')) throw new Error('windows_autostart_not_available: use start after login');
  const configPath = await realpath(options.config), config = await readConfig(configPath);
  let root = installationRoot(configPath, options.root);
  if (within(root, configPath) || within(root, config.stateDir) || within(root, config.cwd)) throw new Error('installation_overlaps_device_data');
  const configInfo = await lstat(configPath);
  if (process.platform !== 'win32' && (configInfo.mode & 0o077)) throw new Error('invalid_config_file_permissions');
  if (command === 'install') await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  root = join(await realpath(dirname(root)), basename(root));
  return withInstallationOwner(root, async ensureCompatibilityGuard => {
    let intended: InstallIntent | undefined;
    if (command === 'install') {
      if (!options.bundle) throw new Error('install_requires_bundle');
      const source = await realpath(options.bundle), payload = await verifyRelease(source);
      intended = { format: 1, configPath, nodeId: config.nodeId, releaseId: payload.id, runtime: await realpath(options.runtime ?? process.execPath) };
      const saved = await installIntent(root), existing = await lstat(root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (saved && (saved.configPath !== intended.configPath || saved.nodeId !== intended.nodeId || saved.releaseId !== intended.releaseId || saved.runtime !== intended.runtime))
        throw new Error('installation_identity_conflict');
      // A private durable reservation precedes directory creation; an arbitrary pre-existing root is never adopted.
      if (!saved && existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink() || process.platform !== 'win32' && (existing.uid !== process.getuid?.() || existing.mode & 0o077))
          throw new Error('installation_recovery_unavailable');
        await assertWindowsPrivatePath(root);
        const record = await readInstallation(root, configPath);
        if (!record || record.nodeId !== config.nodeId) throw new Error('installation_recovery_unavailable');
        const runtime = within(source, intended.runtime) ? join(root, 'releases', payload.id, relative(source, intended.runtime)) : intended.runtime;
        if (!sameRelease(record.current, { id: payload.id, runtime })) throw new Error('installation_identity_conflict');
        await preflight(root, record.current);
        return { root, unchanged: true, ...record };
      }
      if (!saved) await atomicWrite(intentPath(root), JSON.stringify(intended));
      if (!existing) { await mkdir(root, { mode: 0o700 }); await protectWindowsDirectory(root); }
    }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('invalid_installation_directory');
    await assertWindowsPrivatePath(root);
    root = await realpath(root);
    await ensureCompatibilityGuard();
    const previous = await readInstallation(root, configPath);
    if (previous && previous.nodeId !== config.nodeId) throw new Error('installation_node_mismatch');
    const save = (value: Installation) => atomicWrite(join(root, 'installation.json'), JSON.stringify(value, null, 2));
    if (command === 'install') {
      if (previous) {
        if (previous.current.id !== intended!.releaseId) throw new Error('installation_identity_conflict');
        await preflight(root, previous.current);
        await rm(intentPath(root), { force: true });
        return { root, unchanged: true, ...previous };
      }
      if (await control(config, 'status')) throw new Error('daemon_running: stop the existing owner before first installation');
      await stopIdleDaemon(config); // Also checks persisted unknown/running records when no owner is reachable.
      const current = await stage(root, options.bundle!, options.runtime ?? process.execPath);
      const record: Installation = { format: 1, stateFormat: 1, protocol: DEVICE_PROTOCOL_VERSION, configPath, nodeId: config.nodeId, current, autostart: false, searchPath: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        environment: Object.fromEntries(nativePathVariables.filter(key => process.env[key]).map(key => [key, process.env[key]!])) };
      await atomicWrite(join(root, 'launch.cjs'), launcher, 0o700);
      await save(record);
      await rm(intentPath(root), { force: true });
      return { root, launcher: join(root, 'launch.cjs'), ...record, running: false };
    }
    if (!previous) throw new Error('device_not_installed');
    // A disabled login preference can still have a running job in this session.
    // Its owned registration must participate in later explicit maintenance.
    const service = process.platform === 'darwin' || previous.autostart || command === 'autostart' || command === 'login-start'
      ? serviceFactory(root, configPath, previous.searchPath, previous.environment) : undefined;
    await service?.check(previous.current.runtime);
    if (command === 'login-start') {
      const enabled = !options.disable;
      if (enabled) await preflight(root, previous.current);
      try {
        await service!.configure(previous.current.runtime, enabled);
        await save({ ...previous, autostart: enabled });
      }
      catch (error) {
        try { await service!.configure(previous.current.runtime, previous.autostart); }
        catch { throw new Error('autostart_preference_unconfirmed'); }
        throw error;
      }
      return { root, autostart: enabled };
    }
    if (command === 'autostart') {
      if (options.disable) {
        await stopIdleDaemon(config);
        await service!.disable(previous.current.runtime);
        await save({ ...previous, autostart: false });
        return { root, autostart: false, running: false };
      }
      await preflight(root, previous.current);
      const existing = await control(config, 'status');
      if (previous.autostart && await service!.loaded() && existing) return { root, autostart: true, status: await waitForDaemon(config, entrypoint(root, previous.current), previous.current.runtime) };
      const wasRunning = await stopIdleDaemon(config);
      try {
        await service!.enable(previous.current.runtime);
        await service!.start();
        const status = await waitForDaemon(config, entrypoint(root, previous.current), previous.current.runtime);
        await save({ ...previous, autostart: true });
        return { root, autostart: true, serviceFile: service!.path, status };
      } catch (error) {
        await stopIdleDaemon(config);
        await service!.disable(previous.current.runtime);
        if (wasRunning) await startBackground(config, configPath, entrypoint(root, previous.current), previous.current.runtime);
        throw error;
      }
    }
    const next = command === 'rollback' ? previous.previous : options.bundle
      ? await stage(root, options.bundle, options.runtime ?? previous.current.runtime) : undefined;
    if (!next) throw new Error(command === 'rollback' ? 'no_previous_release' : 'upgrade_requires_bundle');
    await preflight(root, next);
    if (sameRelease(next, previous.current)) return { root, unchanged: true, current: next };
    const wasRunning = await stopIdleDaemon(config);
    try {
      if (service) await service.unload(previous.current.runtime);
      const record = { ...previous, current: next, previous: previous.current };
      await save(record);
      let status: LocalStatus | undefined;
      await service?.configure(next.runtime, previous.autostart, previous.current.runtime);
      if (wasRunning) {
        if (service && previous.autostart) {
          await service.enable(next.runtime); await service.start();
          status = await waitForDaemon(config, entrypoint(root, next), next.runtime);
        } else {
          status = await startBackground(config, configPath, entrypoint(root, next), next.runtime);
        }
      }
      return { root, current: next, previous: previous.current, autostart: previous.autostart, ...(status ? { status } : { running: false }) };
    } catch (error) {
      try {
        await stopIdleDaemon(config);
        if (service) await service.unload(next.runtime, previous.current.runtime);
        await save(previous);
        await service?.configure(previous.current.runtime, previous.autostart, next.runtime);
        if (wasRunning) {
          if (service && previous.autostart) {
            await service.enable(previous.current.runtime); await service.start();
            await waitForDaemon(config, entrypoint(root, previous.current), previous.current.runtime);
          } else {
            await startBackground(config, configPath, entrypoint(root, previous.current), previous.current.runtime);
          }
        }
      } catch (recovery) {
        throw new Error(`activation_failed_recovery_unconfirmed:${String(error)}; ${String(recovery)}; inspect status and logs, no prompt was replayed`);
      }
      throw new Error(`activation_failed_previous_restored:${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export async function startInstalled(configPath: string, root: string) {
  if (!await readInstallation(root, configPath)) return undefined;
  root = await realpath(root);
  return withInstallationOwner(root, async () => {
    const record = await readInstallation(root, configPath);
    if (!record) throw new Error('installation_recovery_unavailable');
    const config = await readConfig(configPath);
    if (record.nodeId !== config.nodeId) throw new Error('installation_node_mismatch');
    const existing = await control(config, 'status');
    if (existing) return { ...await waitForDaemon(config, entrypoint(root, record.current), record.current.runtime), alreadyRunning: true };
    const service = process.platform === 'darwin' ? macAutostart(root, configPath, record.searchPath, record.environment) : undefined;
    await service?.check(record.current.runtime);
    if (record.autostart && service) {
      await service.enable(record.current.runtime); await service.start();
      return waitForDaemon(config, entrypoint(root, record.current), record.current.runtime);
    }
    if (service && await service.loaded()) {
      // launchctl can explicitly start a loaded job while its future-login
      // policy stays disabled. Reuse it instead of creating a second owner.
      await service.start();
      return waitForDaemon(config, entrypoint(root, record.current), record.current.runtime);
    }
    return startBackground(config, configPath, entrypoint(root, record.current), record.current.runtime);
  });
}
