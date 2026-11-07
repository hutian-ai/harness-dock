import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertEndpoint, DEVICE_PROTOCOL_VERSION, id, parseInvitationLink } from '@harness-dock/protocol';
import { parseDevicePairing, prepareDeviceHome, readConfig, type DeviceConfig } from './config.ts';
import { deviceDiagnostics } from './doctor.ts';
import { installationLegacyRecovery, installationRoot, manageInstallation, readInstallation, startInstalled, type Installation } from './installation.ts';
import { control, type LocalStatus } from './local-control.ts';
import { stopIdleDaemon } from './process-management.ts';
import { readStoredActivity } from './device-store.ts';
import { verifyRelease } from './release-manifest.ts';
import { assertWindowsPrivatePath, discoverProviders, type ProviderKey, type ProviderDiscoveryOptions } from '@harness-dock/drivers';
import { setupDevice } from './setup.ts';
import { panelConfigurationPaths, panelExternalInstallation } from './panel-discovery.ts';
import { retireLegacyAutostart } from './legacy-autostart.ts';
import { claimInvitation, clearConnectionRecovery, readConnectionRecovery, saveConnectionRecovery } from './invitation.ts';
import { panelPreferences, panelPreferencesRoot, panelSelection, withPanelConnectionChange } from './panel-preferences.ts';
import type { PanelPreferenceOperation } from './panel-preferences.ts';
import { legacyOperationRecovery, type LegacyLockStatus } from './operation-owner.ts';

const localPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
const request = z.strictObject({
  operation: z.enum(['discover', 'install', 'status', 'provider-details', 'pairing', 'invitation', 'setup', 'recover-connection', 'prepare-admission-recovery', 'resume-admission', 'prepare-legacy-lock-recovery', 'recover-legacy-lock', 'start', 'stop', 'autostart', 'doctor', 'test', 'test-status', 'upgrade', 'rollback', 'logs', 'log-location', 'preferences', 'save-selection', 'save-test-receipt', 'clear-test-receipt', 'save-appearance', 'connect', 'disconnect', 'select-connection']),
  config: localPath, pairing: localPath.optional(), cwd: localPath.optional(), caFile: localPath.optional(),
  expectedPairingDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  id: z.string().uuid().optional(),
  scope: z.enum(['connection', 'installation']).optional(),
  invitation: z.string().min(1).max(4096).optional(),
  testId: z.string().uuid().optional(), provider: z.enum(['codex', 'dsh']).optional(),
  enabled: z.boolean().optional(), selectedOnly: z.boolean().optional(),
  appearance: z.enum(['system', 'light', 'dark']).optional(),
  refreshProviders: z.boolean().optional(),
  singleServer: z.literal(true).optional(),
});
export type PanelRequest = z.infer<typeof request>;

/** User-selected import: read a bounded regular file, without changing permissions on the original. */
async function pairingFile(path: string) {
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error('invalid_device_pairing');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || info.size > 16_384
      || process.platform !== 'win32' && info.uid !== process.getuid?.()) throw new Error('invalid_device_pairing');
    const data = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 16_384) throw new Error('invalid_device_pairing');
    let input: unknown;
    try { input = JSON.parse(data.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('invalid_device_pairing'); }
    if (input && typeof input === 'object' && 'mode' in input && input.mode === 'device')
      throw new Error('device_config_is_not_pairing');
    const pairing = parseDevicePairing(input);
    id.parse(pairing.nodeId); assertEndpoint(pairing.endpoint);
    if (pairing.token.length < 32) throw new Error('invalid_device_pairing');
    return pairing;
  } finally { await file.close(); }
}

const endpointLabel = (endpoint: string) => new URL(endpoint).host;
const pairingDigest = (pairing: ReturnType<typeof parseDevicePairing>) => createHash('sha256').update(JSON.stringify(pairing)).digest('hex');
async function confirmedPairing(options: PanelRequest) {
  if (!options.pairing || !options.expectedPairingDigest) throw new Error('pairing_changed');
  const pairing = await pairingFile(options.pairing);
  if (pairingDigest(pairing) !== options.expectedPairingDigest) throw new Error('pairing_changed');
  return pairing;
}
async function connectionRecovery(path: string) {
  const saved = await readConnectionRecovery(path);
  return saved ? { server: endpointLabel(saved.endpoint), nodeId: saved.nodeId, cwd: saved.cwd, ...(saved.caFile ? { caFile: saved.caFile } : {}) } : undefined;
}
async function legacyLocks(path: string, home?: string, hasConfig = true) {
  const result: (LegacyLockStatus & { scope: 'connection' | 'installation' })[] = [];
  const connection = await legacyOperationRecovery(join(panelPreferencesRoot(home), 'connection.lock'), 'status');
  if (connection) result.push({ scope: 'connection', ...connection });
  const installation = hasConfig ? await installationLegacyRecovery(path, 'status') : undefined;
  if (installation) result.push({ scope: 'installation', ...installation });
  return result;
}
async function privateConfig(path: string) {
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077)) throw new Error('invalid_config_file_permissions');
  return readConfig(path);
}

// Named test implementations belong to the device. The panel renders their metadata.
const selfTestProfiles = {
  codex: { displayName: 'Codex', experimental: false, selfTestKind: 'read-only-echo',
    acceptanceDescription: '在已构建的源码目录使用应用 client.json，核对两轮回显和同一会话续接。替换命令中的配置路径；会使用模型额度。需要验证审批时可在交互终端追加 --approval。' },
  dsh: { displayName: 'dsh', experimental: true, selfTestKind: 'native-echo',
    acceptanceDescription: '在已构建的源码目录运行隔离的 SDK / Server / DeviceHost 合成验收，检查真实审批、MCP 与 skills，会使用模型额度；不验证此设备现有应用身份或业务授权。' },
} satisfies Record<ProviderKey, { displayName: string; experimental: boolean; selfTestKind: string; acceptanceDescription: string }>;

async function panelProviders(overrides: ProviderDiscoveryOptions['overrides'], supported: readonly string[], nodeId?: string) {
  // An optional installation probe cannot hide owner state or durable test receipts.
  const found = await discoverProviders({ overrides, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  const installations = found ?? (Object.keys(selfTestProfiles) as ProviderKey[]).map(key => ({
    key, displayName: selfTestProfiles[key].displayName, status: 'unknown', version: null, source: null, executable: null, home: null,
  }));
  return installations.map(provider => ({ key: provider.key, displayName: provider.displayName, status: provider.status,
    experimental: selfTestProfiles[provider.key].experimental,
    version: provider.version, source: provider.source, executable: provider.executable, home: provider.home,
    desktopHost: 'desktopHost' in provider ? provider.desktopHost : undefined,
    selfTestSupported: provider.status === 'installed' && supported.includes(provider.key),
    selfTestKind: selfTestProfiles[provider.key].selfTestKind,
    acceptanceCommand: provider.key === 'dsh' ? 'pnpm accept:dsh' : nodeId ? `pnpm client test /private/client.json --node-id ${nodeId}` : undefined,
    acceptanceDescription: selfTestProfiles[provider.key].acceptanceDescription,
  }));
}

/** Presentation metadata only. Installation still verifies every file before activation. */
async function panelReleaseMetadata(directory?: string): Promise<{ id: string; version: string } | undefined> {
  if (!directory) return undefined;
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return undefined;
    const file = await open(join(directory, 'dock-release.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(), maxBytes = 8 * 1024 * 1024;
      if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined;
      const bytes = Buffer.alloc(info.size + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) return undefined;
      const text = bytes.subarray(0, bytesRead).toString('utf8'), manifest = JSON.parse(text) as Record<string, unknown>;
      if (manifest.format !== 1 || manifest.stateFormat !== 1 || manifest.protocol !== DEVICE_PROTOCOL_VERSION
        || manifest.platform !== process.platform || manifest.arch !== process.arch
        || !Array.isArray(manifest.entries) || !manifest.entries.length
        || typeof manifest.version !== 'string' || !manifest.version || manifest.version.length > 128 || /[\u0000-\u001f]/u.test(manifest.version)) return undefined;
      return { id: createHash('sha256').update(text).digest('hex'), version: manifest.version };
    } finally { await file.close(); }
  } catch { return undefined; }
}

async function panelReleases(bundle: string | undefined, root: string, installation?: Installation, status?: LocalStatus | null, external = false) {
  const installedReleaseId = installation?.current.id;
  const directory = await lstat(root).catch(() => undefined);
  const managed = installation && !external && directory?.isDirectory() && !directory.isSymbolicLink()
    && (process.platform === 'win32' || directory.uid === process.getuid?.() && !(directory.mode & 0o077));
  if (managed) await assertWindowsPrivatePath(root);
  const releases = managed ? await lstat(join(root, 'releases')).catch(() => undefined) : undefined;
  const [app, installed] = await Promise.all([
    panelReleaseMetadata(bundle),
    releases?.isDirectory() && !releases.isSymbolicLink() ? panelReleaseMetadata(join(root, 'releases', installedReleaseId!)) : undefined,
  ]);
  const canonicalRoot = managed ? await realpath(root).catch(() => undefined) : undefined;
  const runningReleaseId = canonicalRoot && status?.entrypoint && isAbsolute(status.entrypoint)
    ? /^([a-f0-9]{64})\/dist\/cli\.js$/u.exec(relative(join(canonicalRoot, 'releases'), status.entrypoint).split(sep).join('/'))?.[1] : undefined;
  const installedConfirmed = installed?.id === installedReleaseId && installed !== undefined;
  const selectedId = installedConfirmed ? status ? runningReleaseId : installedReleaseId : undefined;
  return {
    appVersion: app?.version, installedVersion: installedConfirmed ? installed.version : undefined,
    appReleaseId: app?.id, installedReleaseId, runningReleaseId,
    releaseMatchesApp: app && selectedId ? selectedId === app.id && (!status || runningReleaseId === installedReleaseId) : undefined,
    updateAvailable: !!(managed && app && installedConfirmed && app.id !== installedReleaseId
      && (!status || runningReleaseId === installedReleaseId)),
  };
}

type PanelStatusResult = Awaited<ReturnType<typeof panelReleases>> & {
  configured: boolean; managed?: boolean; running?: boolean; connected?: boolean; externalInstallation?: boolean;
  server?: string; cwd?: string; nodeId?: string; daemonId?: string;
  providerActivity?: LocalStatus['providerActivity'];
  overview?: LocalStatus['overview'];
  providerDetailsSupported?: boolean; providerDetails?: LocalStatus['providerDetails'];
  selfTest?: LocalStatus['selfTest']; selfTests: NonNullable<LocalStatus['selfTests']>; selfTestProviders: readonly string[];
  providers: Awaited<ReturnType<typeof panelProviders>>;
  providersRefreshed?: false;
  autostart?: boolean; canRollback?: boolean; active?: number; unresolved?: number;
  activityKnown: boolean; activitySource: 'live' | 'persisted' | 'unknown';
  connectionIssue?: 'configuration_mismatch' | 'connection_failed';
  connectionRecovery?: Awaited<ReturnType<typeof connectionRecovery>>;
  admissionRecovery?: LocalStatus['admissionRecovery'];
  legacyLocks?: Awaited<ReturnType<typeof legacyLocks>>;
};

async function panelActivity(config: DeviceConfig, status: LocalStatus | null): Promise<Pick<PanelStatusResult, 'activityKnown' | 'activitySource' | 'active' | 'unresolved' | 'overview'>> {
  const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
  if (status) {
    // Older owners may omit these fields. Missing evidence must not become idle.
    return validIds(status.activeRunIds) && validIds(status.unresolvedRunIds)
      ? { activityKnown: true, activitySource: 'live', active: status.activeRunIds.length, unresolved: status.unresolvedRunIds.length, overview: status.overview }
      : { activityKnown: false, activitySource: 'unknown' };
  }
  const stored = await readStoredActivity(config.nodeId, config.stateDir, true).catch(() => undefined);
  return stored
    ? { activityKnown: true, activitySource: 'persisted', active: 0, unresolved: stored.unresolved, overview: stored.overview }
    : { activityKnown: false, activitySource: 'unknown' };
}

export async function panelStatus(path: string, home?: string, bundle?: string, refreshProviders = true): Promise<PanelStatusResult> {
  let config;
  try { config = await privateConfig(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configured: false, activityKnown: false, activitySource: 'unknown', providers: refreshProviders ? await panelProviders(undefined, []) : [], selfTests: [], selfTestProviders: [],
      ...(refreshProviders ? {} : { providersRefreshed: false as const }),
      ...await panelReleases(bundle, installationRoot(path)), connectionRecovery: await connectionRecovery(path), legacyLocks: await legacyLocks(path, home, false) };
    throw error;
  }
  const status = await control(config, 'status');
  const activity = await panelActivity(config, status);
  const supported = status?.selfTestProviders ?? (status ? ['codex'] : []);
  const providers = refreshProviders ? await panelProviders(config.providers, supported, config.nodeId) : [];
  const installation = await readInstallation(installationRoot(path), path);
  const registration = await panelExternalInstallation(path, installationRoot(path), home);
  const endpointMatches = status?.endpoint === config.endpoint;
  const externalInstallation = registration.external || !installation && !!status?.entrypoint && /\/releases\/[a-f0-9]{64}\/dist\/cli\.js$/u.test(status.entrypoint.split(sep).join('/'));
  const releases = await panelReleases(bundle, installationRoot(path), installation?.nodeId === config.nodeId ? installation : undefined,
    status, externalInstallation || registration.incomplete);
  return { configured: true, managed: !!installation, running: !!status, connected: !!status?.connected && endpointMatches,
    externalInstallation, ...releases,
    server: endpointLabel(config.endpoint), cwd: config.cwd, nodeId: config.nodeId,
    providerActivity: status?.providerActivity,
    providerDetailsSupported: status?.providerDetailsSupported === true, providerDetails: status?.providerDetails,
    daemonId: status?.daemonId, selfTest: status?.selfTest,
    selfTests: status?.selfTests ?? (status?.selfTest ? [{ ...status.selfTest, provider: status.selfTest.provider ?? 'codex' }] : []),
    selfTestProviders: supported, providers, ...(refreshProviders ? {} : { providersRefreshed: false as const }),
    autostart: installation?.autostart ?? false, canRollback: !!installation?.previous,
    ...activity,
    connectionIssue: status && !endpointMatches ? 'configuration_mismatch' : status?.connectionError ? 'connection_failed' : undefined,
    connectionRecovery: await connectionRecovery(path),
    admissionRecovery: status?.admissionRecovery,
    legacyLocks: await legacyLocks(path, home),
  };
}

export async function discoverPanelDevices(config: string, selectedOnly = false, home?: string) {
  const found = await panelConfigurationPaths(config, selectedOnly, home);
  const devices: { configPath: string; server: string; folder: string; running: boolean; connected: boolean }[] = [];
  let incomplete = found.incomplete;
  for (const path of found.paths) {
    try {
      const state = await panelStatus(path, home);
      if (state.configured) devices.push({ configPath: path, server: state.server!, folder: state.cwd!,
        running: state.running!, connected: state.connected! });
    } catch { incomplete = true; }
  }
  return { devices, incomplete };
}

/** Local management and a fixed daemon-owned self-test. No arbitrary prompt or approval input. */
export async function runPanelOperation(input: unknown, bundle: string, home?: string) {
  const parsed = request.safeParse(input);
  if (!parsed.success) throw new Error('invalid_panel_request');
  const options = parsed.data;
  if (options.singleServer) return runSingleServerOperation(options, bundle, home);
  if (['prepare-legacy-lock-recovery', 'recover-legacy-lock'].includes(options.operation)) throw new Error('invalid_panel_request');
  if (['connect', 'disconnect', 'select-connection'].includes(options.operation)) throw new Error('invalid_panel_request');
  return runNativePanelOperation(options, bundle, home);
}

async function runNativePanelOperation(options: PanelRequest, bundle: string, home?: string,
  nativeDefaults?: Pick<DeviceConfig, 'providers' | 'resources'>) {
  const path = options.config;
  if (['preferences', 'save-selection', 'save-test-receipt', 'clear-test-receipt', 'save-appearance'].includes(options.operation))
    return panelPreferences(options.operation as PanelPreferenceOperation, path, options.provider, options.testId, home, options.appearance);
  if (options.operation === 'discover') return discoverPanelDevices(path, options.selectedOnly, home);
  if (options.operation === 'invitation') {
    const invitation = parseInvitationLink(options.invitation ?? '');
    return { server: invitation.server, nodeId: invitation.envelope.nodeId };
  }
  if (options.operation === 'pairing') {
    if (!options.pairing) throw new Error('pairing_required');
    const pairing = await pairingFile(options.pairing);
    return { server: endpointLabel(pairing.endpoint), nodeId: pairing.nodeId, pairingDigest: pairingDigest(pairing) };
  }
  if (options.operation === 'status') return panelStatus(path, home, bundle, options.refreshProviders ?? true);
  if (options.operation === 'prepare-legacy-lock-recovery' || options.operation === 'recover-legacy-lock') {
    if (!options.scope || options.operation === 'recover-legacy-lock' && !options.id) throw new Error('invalid_panel_request');
    const operation = options.operation === 'prepare-legacy-lock-recovery' ? 'prepare' : 'recover';
    if (options.scope === 'connection') await legacyOperationRecovery(join(panelPreferencesRoot(home), 'connection.lock'), operation, options.id);
    else await installationLegacyRecovery(path, operation, options.id);
    return panelStatus(path, home, bundle);
  }
  if (options.operation === 'prepare-admission-recovery' || options.operation === 'resume-admission') {
    if (options.operation === 'resume-admission' && !options.id) throw new Error('invalid_panel_request');
    const config = await privateConfig(path);
    let state;
    try { state = await control(config, options.operation, options.id ? { id: options.id } : undefined); }
    catch (error) {
      if (error instanceof Error && error.message === 'local_control_rejected:404:unknown') throw new Error('admission_recovery_unsupported');
      throw error;
    }
    if (!state) throw new Error('device_not_running');
    return panelStatus(path, home, bundle);
  }
  if (options.operation === 'test' || options.operation === 'test-status') {
    if (!options.testId) throw new Error('invalid_panel_request');
    const config = await privateConfig(path);
    let state;
    try { state = await control(config, options.operation === 'test' ? 'self-test' : 'self-test-status', { id: options.testId, ...(options.provider === 'dsh' ? { provider: options.provider } : {}) }); }
    catch (error) {
      if (error instanceof Error && error.message === 'local_control_rejected:404:unknown') throw new Error('self_test_unsupported');
      throw error;
    }
    if (!state) throw new Error('device_not_running');
    const latest = await panelStatus(path, home, bundle);
    return { ...latest, ...(options.operation === 'test' ? { acceptedSelfTestId: state.selfTest!.id, acceptedSelfTestProvider: state.selfTest!.provider ?? 'codex' } : { selfTestReceipt: state.selfTestReceipt }) };
  }
  if (options.operation === 'recover-connection') {
    if (join(dirname(path), 'config.json') !== path) throw new Error('invalid_panel_request');
    const saved = await readConnectionRecovery(path);
    if (!saved) throw new Error('connection_recovery_unavailable');
    await verifyRelease(bundle);
    await setupDevice({ home: dirname(path), ...saved, bundle,
      runtime: join(bundle, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node'), ...nativeDefaults });
    await clearConnectionRecovery(path);
    return panelStatus(path, home, bundle);
  }
  if (options.operation === 'setup') {
    if ((!options.pairing && !options.invitation) || options.pairing && options.invitation || !options.cwd
      || join(dirname(path), 'config.json') !== path) throw new Error('invalid_panel_request');
    // Reusing a saved identity must not install a second root behind its stopped user agent.
    try {
      await privateConfig(path);
      const registration = await panelExternalInstallation(path, installationRoot(path), home);
      if (registration.external) throw new Error('installation_config_mismatch');
      if (registration.incomplete) throw new Error('installation_inspection_unavailable');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Verify the application payload before creating a new device identity or starting anything.
    await verifyRelease(bundle);
    let pairing;
    if (options.invitation) {
      const invitation = parseInvitationLink(options.invitation);
      // A persisted claim survives installation failures; never claim the same invitation again.
      try {
        const existing = await privateConfig(path);
        if (existing.nodeId !== invitation.envelope.nodeId || existing.endpoint !== invitation.envelope.endpoint)
          throw new Error('setup_identity_conflict');
        pairing = { nodeId: existing.nodeId, token: existing.token, endpoint: existing.endpoint };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!pairing) {
        const saved = await readConnectionRecovery(path);
        if (saved) throw new Error('connection_recovery_pending');
        try { await prepareDeviceHome({ home: dirname(path), cwd: options.cwd, caFile: options.caFile }); }
        catch { throw new Error('connection_local_preflight_failed'); }
        pairing = await claimInvitation(options.invitation, options.caFile);
        // Preserve the returned credential before any config/installation step can fail.
        await saveConnectionRecovery(path, { version: 1, ...pairing, cwd: options.cwd, ...(options.caFile ? { caFile: options.caFile } : {}) });
      }
    } else {
      if (await readConnectionRecovery(path)) throw new Error('connection_recovery_pending');
      pairing = await confirmedPairing(options);
    }
    await setupDevice({ home: dirname(path), cwd: options.cwd, ...pairing, bundle,
      runtime: join(bundle, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node'), caFile: options.caFile, ...nativeDefaults });
    await clearConnectionRecovery(path);
    return panelStatus(path, home, bundle);
  }
  const config = await privateConfig(path), root = installationRoot(path);
  if (options.operation === 'install') {
    const registration = await panelExternalInstallation(path, root, home);
    if (registration.external) throw new Error('installation_config_mismatch');
    if (registration.incomplete) throw new Error('installation_inspection_unavailable');
    if (await readInstallation(root, path)) return panelStatus(path, home, bundle);
    await verifyRelease(bundle);
    const previousOwner = await control(config, 'status');
    if (previousOwner?.entrypoint && /\/releases\/[a-f0-9]{64}\/dist\/cli\.js$/u.test(previousOwner.entrypoint.split(sep).join('/')))
      throw new Error('installation_config_mismatch');
    await stopIdleDaemon(config);
    // The SQLite owner has closed its exclusive lock; preserve a consistent pre-migration database.
    const archive = join(dirname(path), 'retired-autostart');
    await mkdir(archive, { recursive: true, mode: 0o700 });
    const owner = await lstat(archive);
    if (!owner.isDirectory() || owner.isSymbolicLink() || process.platform !== 'win32' && (owner.uid !== process.getuid?.() || owner.mode & 0o077))
      throw new Error('legacy_service_unverified');
    await assertWindowsPrivatePath(archive);
    for (const [source, name] of [[path, 'config-before-panel.json'], [join(config.stateDir, 'runs.sqlite'), 'runs-before-panel.sqlite']] as const) {
      try { await copyFile(source, join(archive, name), constants.COPYFILE_EXCL); await chmod(join(archive, name), 0o600); }
      catch (error) { if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const legacy = process.platform === 'win32' ? { retired: false, autostart: false } : await retireLegacyAutostart(path, config);
    await manageInstallation('install', { config: path, root, bundle, runtime: join(bundle, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node') });
    if (legacy.autostart) await manageInstallation('autostart', { config: path, root });
    else await startInstalled(path, root);
    return panelStatus(path, home, bundle);
  }
  if (options.operation === 'provider-details') {
    const owner = await control(config, 'status');
    if (!owner) throw new Error('device_not_running');
    if (!owner.providerDetailsSupported) throw new Error('provider_details_unsupported');
    await control(config, 'provider-details');
    return panelStatus(path, home, bundle, false);
  }
  if (options.operation === 'doctor') {
    const checks = await deviceDiagnostics(path);
    // Proxy metadata contains only source/mode flags, never endpoints or credentials.
    return { checks: checks.map(({ check, state, proxy }) => ({ check, state, ...(proxy ? { proxy } : {}) })) };
  }
  if (options.operation === 'logs' || options.operation === 'log-location') {
    const location = join(config.stateDir, 'daemon.log');
    const reveal = options.operation === 'log-location';
    // A replaced log may be a FIFO. Path validation must not wait for a writer.
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (reveal ? constants.O_NONBLOCK : 0);
    const file = await open(location, flags).catch(error => {
      if (reveal && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('log_not_found');
      throw error;
    });
    try {
      const info = await file.stat();
      if (!info.isFile() || process.platform !== 'win32' && info.uid !== process.getuid?.()) throw new Error('invalid_log_file');
      if (reveal) return { path: location };
      const data = Buffer.alloc(Math.min(info.size, 32_768));
      await file.read(data, 0, data.length, Math.max(0, info.size - data.length));
      return { text: data.toString('utf8').replaceAll(config.token, '[redacted]') };
    } finally { await file.close(); }
  }
  // Source-run devices can be observed/diagnosed, but never silently converted to a managed installation.
  if (!await readInstallation(root, path)) throw new Error('device_not_installed');
  if (options.operation === 'start') await startInstalled(path, root);
  else if (options.operation === 'stop') await stopIdleDaemon(config);
  else if (options.operation === 'autostart') {
    if (options.enabled === undefined) throw new Error('invalid_panel_request');
    await manageInstallation('login-start', { config: path, root, disable: !options.enabled });
  } else if (options.operation === 'upgrade' || options.operation === 'rollback') {
    await manageInstallation(options.operation, { config: path, root,
      ...(options.operation === 'upgrade' ? { bundle: await realpath(bundle), runtime: join(bundle, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node') } : {}) });
  }
  return panelStatus(path, home, bundle);
}

async function configured(path: string): Promise<boolean> {
  try { await privateConfig(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function sameConfiguration(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  try { return await realpath(a) === await realpath(b); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** One selected binding for the normal desktop client. Independent CLI/device instances stay independent. */
async function runSingleServerOperation(options: PanelRequest, bundle: string, home?: string) {
  const path = options.config, operation = options.operation;
  if (operation === 'preferences') return panelSelection(home);
  const reads = ['status', 'provider-details', 'test-status', 'discover', 'invitation', 'pairing', 'doctor', 'logs', 'log-location'];
  if (reads.includes(operation)) {
    const selection = await panelSelection(home);
    if (!await sameConfiguration(path, selection.config)) throw new Error('panel_selection_changed');
    if (operation === 'discover') return discoverPanelDevices(path, await configured(path) || options.selectedOnly, home);
    return runNativePanelOperation(options, bundle, home);
  }
  return withPanelConnectionChange(home, async selection => {
    const same = await sameConfiguration(path, selection.config);
    const selecting = operation === 'select-connection' || operation === 'save-selection';
    if (!same && (!selecting || await configured(selection.config)))
      throw new Error(selecting ? 'server_change_requires_disconnect' : 'panel_selection_changed');
    // Login preference only changes future launch policy. It remains serialized and
    // bound to this selected identity, but does not require current execution to end.
    const maintenance = ['disconnect', 'connect', 'setup', 'recover-connection', 'prepare-admission-recovery', 'resume-admission', 'prepare-legacy-lock-recovery', 'recover-legacy-lock', 'select-connection', 'save-selection', 'stop', 'install', 'upgrade', 'rollback'];
    if (selection.pending && maintenance.includes(operation)) throw new Error('unresolved_execution');
    if (selection.pending && operation === 'start' && !await sameConfiguration(selection.pending.config, path)) throw new Error('panel_selection_changed');
    if (operation === 'test' && selection.pending && (selection.pending.id !== options.testId || selection.pending.provider !== (options.provider ?? 'codex')))
      throw new Error('self_test_id_conflict');
    let prior: DeviceConfig | undefined;
    if (selection.previousConfig && ['connect', 'setup', 'recover-connection', 'select-connection', 'save-selection', 'start', 'autostart', 'install', 'upgrade', 'rollback'].includes(operation)) {
      prior = await privateConfig(selection.previousConfig);
      if (!await sameConfiguration(path, selection.previousConfig)) {
        const previousInstallation = await readInstallation(installationRoot(selection.previousConfig), selection.previousConfig);
        if (!previousInstallation || previousInstallation.autostart || await control(prior, 'status')) throw new Error('server_change_requires_disconnect');
      }
    }
    if (operation === 'select-connection') {
      const state = await panelStatus(path, home, bundle);
      if (!state.configured) throw new Error('file_not_found');
      await panelPreferences('save-selection', path, options.provider, undefined, home);
      return state;
    }
    if (operation === 'disconnect') {
      const config = await privateConfig(path), root = installationRoot(path);
      const installation = await readInstallation(root, path);
      const registration = await panelExternalInstallation(path, root, home);
      if (!installation) throw new Error('device_not_installed');
      if (installation.nodeId !== config.nodeId || registration.external) throw new Error('installation_config_mismatch');
      if (registration.incomplete) throw new Error('installation_inspection_unavailable');
      // Establish the selected binding before shutdown, including first use of an existing default config.
      await panelPreferences('save-selection', selection.config, undefined, undefined, home);
      if (process.platform === 'darwin') await manageInstallation('autostart', { config: path, root, disable: true });
      else if (installation.autostart) throw new Error('installation_inspection_unavailable');
      await stopIdleDaemon(config);
      if (await control(config, 'status')) throw new Error('server_disconnect_unconfirmed');
      // The prior identity, native selection, database and logs stay at their original paths.
      // The next binding gets its own identity/state; no second owner is started here.
      const next = join(panelPreferencesRoot(home), 'device-replacements', randomUUID(), 'config.json');
      await panelPreferences('save-disconnection', next, undefined, undefined, home, undefined, selection.config);
      return { config: next, device: await panelStatus(next, home, bundle), disconnected: true };
    }
    if (operation === 'connect' || operation === 'setup') {
      if (await configured(path)) {
        const existing = await privateConfig(path);
        const target = options.invitation ? parseInvitationLink(options.invitation).envelope : options.pairing ? await confirmedPairing(options) : undefined;
        if (!target || target.nodeId !== existing.nodeId || target.endpoint !== existing.endpoint) throw new Error('server_change_requires_disconnect');
      }
      await panelPreferences('save-selection', path, undefined, undefined, home);
      return runNativePanelOperation({ ...options, operation: 'setup' }, bundle, home,
        prior ? { providers: prior.providers, resources: prior.resources } : undefined);
    }
    if (operation === 'recover-connection') return runNativePanelOperation(options, bundle, home,
      prior ? { providers: prior.providers, resources: prior.resources } : undefined);
    return runNativePanelOperation(options, bundle, home);
  }, operation === 'prepare-legacy-lock-recovery' || operation === 'recover-legacy-lock');
}

/** CLI migration entry; it retains the normal desktop selection fence and kernel owner. */
export async function managePanelLegacyLock(config: string, scope: 'connection' | 'installation', operation: 'prepare' | 'recover', checkpointId?: string, home?: string) {
  return runPanelOperation({ operation: operation === 'prepare' ? 'prepare-legacy-lock-recovery' : 'recover-legacy-lock',
    config, scope, ...(checkpointId ? { id: checkpointId } : {}), singleServer: true }, '', home);
}

/** Return stable codes, never arbitrary exception strings which may contain user material. */
export function panelError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const codes = ['setup_identity_conflict', 'device_not_installed', 'device_busy', 'unresolved_execution', 'installation_busy', 'installation_lock_legacy', 'installation_recovery_unavailable', 'installation_identity_conflict', 'invalid_panel_preferences',
    'server_change_requires_disconnect', 'panel_selection_changed', 'connection_change_busy', 'connection_lock_legacy', 'server_disconnect_unconfirmed',
    'pairing_changed', 'connection_recovery_pending', 'connection_recovery_unavailable', 'connection_local_preflight_failed',
    'admission_recovery_unsupported', 'admission_recovery_restart_required', 'admission_recovery_changed',
    'legacy_lock_recovery_unsupported', 'legacy_lock_restart_required', 'legacy_lock_changed',
    'invalid_device_pairing', 'device_config_is_not_pairing', 'invalid_invitation', 'invitation_expired', 'invitation_unavailable', 'invitation_claim_unconfirmed',
    'self_test_unsupported', 'self_test_storage_unavailable', 'self_test_id_conflict', 'device_not_running', 'log_not_found',
    'invalid_config_file_permissions', 'windows_private_path_unavailable', 'windows_pipe_acl_unavailable', 'pairing_required', 'invalid_panel_request', 'no_previous_release',
    'autostart_preference_unconfirmed', 'autostart_file_modified', 'autostart_registration_without_owned_file', 'autostart_requires_macos_user_login',
    'release_integrity_mismatch', 'release_platform_mismatch', 'incompatible_release_format', 'installation_config_mismatch', 'installation_inspection_unavailable', 'legacy_service_unverified', 'legacy_owner_still_running', 'legacy_service_changed'];
  if (message.startsWith('activation_failed_previous_restored:')) return 'activation_failed_previous_restored';
  if (message.startsWith('activation_failed_recovery_unconfirmed:')) return 'activation_failed_recovery_unconfirmed';
  if (message.startsWith('windows_autostart_not_available:')) return 'windows_autostart_not_available';
  if (message.includes('local_control_rejected:409:device_busy')) return 'device_busy';
  if (message.includes('local_control_rejected:409:unresolved_execution')) return 'unresolved_execution';
  for (const code of ['self_test_unsupported', 'self_test_storage_unavailable', 'self_test_id_conflict'])
    if (message === `local_control_rejected:409:${code}` || message === `local_control_rejected:500:${code}`) return code;
  for (const code of ['admission_recovery_unsupported', 'admission_recovery_restart_required', 'admission_recovery_changed'])
    if (message === `local_control_rejected:409:${code}` || message === `local_control_rejected:500:${code}`) return code;
  return codes.find(code => message === code) ?? ((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file_not_found' : 'management_failed');
}
