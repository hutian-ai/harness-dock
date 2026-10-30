import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { assertEndpoint, id, parseInvitationLink } from '@harness-dock/protocol';
import { parseDevicePairing, readConfig } from './config.ts';
import { deviceDiagnostics } from './doctor.ts';
import { installationRoot, manageInstallation, readInstallation, startInstalled } from './installation.ts';
import { control } from './local-control.ts';
import { stopIdleDaemon } from './process-management.ts';
import { verifyRelease } from './release-manifest.ts';
import { discoverProviders, type ProviderKey, type ProviderDiscoveryOptions } from '@harness-dock/drivers';
import { setupDevice } from './setup.ts';
import { panelConfigurationPaths, panelExternalInstallation } from './panel-discovery.ts';
import { retireLegacyAutostart } from './legacy-autostart.ts';
import { claimInvitation } from './invitation.ts';

const localPath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'));
const request = z.strictObject({
  operation: z.enum(['discover', 'install', 'status', 'pairing', 'invitation', 'setup', 'start', 'stop', 'autostart', 'doctor', 'test', 'test-status', 'upgrade', 'rollback', 'logs']),
  config: localPath, pairing: localPath.optional(), cwd: localPath.optional(), caFile: localPath.optional(),
  invitation: z.string().min(1).max(4096).optional(),
  testId: z.string().uuid().optional(), provider: z.enum(['codex', 'dsh']).optional(),
  enabled: z.boolean().optional(), selectedOnly: z.boolean().optional(),
});
export type PanelRequest = z.infer<typeof request>;

/** User-selected import: read a bounded regular file, without changing permissions on the original. */
async function pairingFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384 || info.uid !== process.getuid?.()) throw new Error('invalid_device_pairing');
    const data = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 16_384) throw new Error('invalid_device_pairing');
    const pairing = parseDevicePairing(JSON.parse(data.subarray(0, bytesRead).toString('utf8')));
    id.parse(pairing.nodeId); assertEndpoint(pairing.endpoint);
    if (pairing.token.length < 32) throw new Error('invalid_device_pairing');
    return pairing;
  } finally { await file.close(); }
}

const endpointLabel = (endpoint: string) => new URL(endpoint).host;
async function privateConfig(path: string) {
  const info = await stat(path);
  if (info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('invalid_config_file_permissions');
  return readConfig(path);
}

// Named test implementations belong to the device. The panel renders their metadata.
const selfTestProfiles = {
  codex: { displayName: 'Codex', selfTestKind: 'read-only-echo',
    acceptanceDescription: '在已构建的源码目录使用应用 client.json，核对两轮回显和同一会话续接。替换命令中的配置路径；会使用模型额度。需要验证审批时可在交互终端追加 --approval。' },
  dsh: { displayName: 'dsh', selfTestKind: 'native-echo',
    acceptanceDescription: '在已构建的源码目录运行隔离的 SDK / Server / DeviceHost 合成验收，检查真实审批、MCP 与 skills，会使用模型额度；不验证此设备现有应用身份或业务授权。' },
} satisfies Record<ProviderKey, { displayName: string; selfTestKind: string; acceptanceDescription: string }>;

async function panelProviders(overrides: ProviderDiscoveryOptions['overrides'], supported: readonly string[], nodeId?: string) {
  // An optional installation probe cannot hide owner state or durable test receipts.
  const found = await discoverProviders({ overrides, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  const installations = found ?? (Object.keys(selfTestProfiles) as ProviderKey[]).map(key => ({
    key, displayName: selfTestProfiles[key].displayName, status: 'unknown', version: null, source: null, executable: null, home: null,
  }));
  return installations.map(provider => ({ key: provider.key, displayName: provider.displayName, status: provider.status,
    version: provider.version, source: provider.source, executable: provider.executable, home: provider.home,
    selfTestSupported: provider.status === 'installed' && supported.includes(provider.key),
    selfTestKind: selfTestProfiles[provider.key].selfTestKind,
    acceptanceCommand: provider.key === 'dsh' ? 'pnpm accept:dsh' : nodeId ? `pnpm client test /private/client.json --node-id ${nodeId}` : undefined,
    acceptanceDescription: selfTestProfiles[provider.key].acceptanceDescription,
  }));
}

export async function panelStatus(path: string, home?: string) {
  let config;
  try { config = await privateConfig(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configured: false, providers: await panelProviders(undefined, []), selfTests: [], selfTestProviders: [] };
    throw error;
  }
  const status = await control(config, 'status');
  const supported = status?.selfTestProviders ?? (status ? ['codex'] : []);
  const providers = await panelProviders(config.providers, supported, config.nodeId);
  const installation = await readInstallation(installationRoot(path), path);
  const registration = await panelExternalInstallation(path, installationRoot(path), home);
  const endpointMatches = status?.endpoint === config.endpoint;
  return { configured: true, managed: !!installation, running: !!status, connected: !!status?.connected && endpointMatches,
    externalInstallation: registration.external || !installation && !!status?.entrypoint && /\/releases\/[a-f0-9]{64}\/dist\/cli\.js$/u.test(status.entrypoint),
    server: endpointLabel(config.endpoint), cwd: config.cwd, nodeId: config.nodeId,
    daemonId: status?.daemonId, selfTest: status?.selfTest,
    selfTests: status?.selfTests ?? (status?.selfTest ? [{ ...status.selfTest, provider: status.selfTest.provider ?? 'codex' }] : []),
    selfTestProviders: supported, providers,
    autostart: installation?.autostart ?? false, canRollback: !!installation?.previous,
    active: status?.activeRunIds?.length ?? 0, unresolved: status?.unresolvedRunIds?.length ?? 0,
    connectionIssue: status && !endpointMatches ? 'configuration_mismatch' : status?.connectionError ? 'connection_failed' : undefined,
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
  const options = parsed.data, path = options.config;
  if (options.operation === 'discover') return discoverPanelDevices(path, options.selectedOnly, home);
  if (options.operation === 'invitation') {
    const invitation = parseInvitationLink(options.invitation ?? '');
    return { server: invitation.server, nodeId: invitation.envelope.nodeId };
  }
  if (options.operation === 'pairing') {
    if (!options.pairing) throw new Error('pairing_required');
    const pairing = await pairingFile(options.pairing);
    return { server: endpointLabel(pairing.endpoint), nodeId: pairing.nodeId };
  }
  if (options.operation === 'status') return panelStatus(path, home);
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
    const latest = await panelStatus(path, home);
    return { ...latest, ...(options.operation === 'test' ? { acceptedSelfTestId: state.selfTest!.id, acceptedSelfTestProvider: state.selfTest!.provider ?? 'codex' } : { selfTestReceipt: state.selfTestReceipt }) };
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
      pairing ??= await claimInvitation(options.invitation, options.caFile);
    } else pairing = await pairingFile(options.pairing!);
    await setupDevice({ home: dirname(path), cwd: options.cwd, ...pairing, bundle,
      runtime: join(bundle, 'runtime/node'), caFile: options.caFile });
    return panelStatus(path, home);
  }
  const config = await privateConfig(path), root = installationRoot(path);
  if (options.operation === 'install') {
    const registration = await panelExternalInstallation(path, root, home);
    if (registration.external) throw new Error('installation_config_mismatch');
    if (registration.incomplete) throw new Error('installation_inspection_unavailable');
    if (await readInstallation(root, path)) return panelStatus(path, home);
    await verifyRelease(bundle);
    const previousOwner = await control(config, 'status');
    if (previousOwner?.entrypoint && /\/releases\/[a-f0-9]{64}\/dist\/cli\.js$/u.test(previousOwner.entrypoint))
      throw new Error('installation_config_mismatch');
    await stopIdleDaemon(config);
    // The SQLite owner has closed its exclusive lock; preserve a consistent pre-migration database.
    const archive = join(dirname(path), 'retired-autostart');
    await mkdir(archive, { recursive: true, mode: 0o700 });
    const owner = await lstat(archive);
    if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.() || owner.mode & 0o077)
      throw new Error('legacy_service_unverified');
    for (const [source, name] of [[path, 'config-before-panel.json'], [join(config.stateDir, 'runs.sqlite'), 'runs-before-panel.sqlite']] as const) {
      try { await copyFile(source, join(archive, name), constants.COPYFILE_EXCL); await chmod(join(archive, name), 0o600); }
      catch (error) { if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const legacy = await retireLegacyAutostart(path, config);
    await manageInstallation('install', { config: path, root, bundle, runtime: join(bundle, 'runtime/node') });
    if (legacy.autostart) await manageInstallation('autostart', { config: path, root });
    else await startInstalled(path, root);
    return panelStatus(path, home);
  }
  if (options.operation === 'doctor') {
    const checks = await deviceDiagnostics(path);
    // Only codes/states leave the helper; native errors, credentials and inventories stay local.
    return { checks: checks.map(({ check, state }) => ({ check, state })) };
  }
  if (options.operation === 'logs') {
    const file = await open(join(config.stateDir, 'daemon.log'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error('invalid_log_file');
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
    await manageInstallation('autostart', { config: path, root, disable: !options.enabled });
  } else if (options.operation === 'upgrade' || options.operation === 'rollback') {
    await manageInstallation(options.operation, { config: path, root,
      ...(options.operation === 'upgrade' ? { bundle: await realpath(bundle), runtime: join(bundle, 'runtime/node') } : {}) });
  }
  return panelStatus(path, home);
}

/** Return stable codes, never arbitrary exception strings which may contain user material. */
export function panelError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const codes = ['setup_identity_conflict', 'device_not_installed', 'device_busy', 'unresolved_execution', 'installation_busy',
    'invalid_device_pairing', 'invalid_invitation', 'invitation_expired', 'invitation_unavailable', 'invitation_claim_unconfirmed',
    'self_test_unsupported', 'self_test_storage_unavailable', 'self_test_id_conflict', 'device_not_running',
    'invalid_config_file_permissions', 'pairing_required', 'invalid_panel_request', 'no_previous_release',
    'release_integrity_mismatch', 'release_platform_mismatch', 'incompatible_release_format', 'installation_config_mismatch', 'installation_inspection_unavailable', 'legacy_service_unverified', 'legacy_owner_still_running', 'legacy_service_changed'];
  if (message.startsWith('activation_failed_previous_restored:')) return 'activation_failed_previous_restored';
  if (message.startsWith('activation_failed_recovery_unconfirmed:')) return 'activation_failed_recovery_unconfirmed';
  if (message.includes('local_control_rejected:409:device_busy')) return 'device_busy';
  if (message.includes('local_control_rejected:409:unresolved_execution')) return 'unresolved_execution';
  for (const code of ['self_test_unsupported', 'self_test_storage_unavailable', 'self_test_id_conflict'])
    if (message === `local_control_rejected:409:${code}` || message === `local_control_rejected:500:${code}`) return code;
  return codes.find(code => message === code) ?? ((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file_not_found' : 'management_failed');
}
