import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { DEVICE_PROTOCOL_VERSION, diagnosticError, printDiagnostics, queryServerHealth, type DiagnosticCheck } from '@harness-dock/protocol';
import { readConfig } from './config.ts';
import { control } from './local-control.ts';

export async function deviceDiagnostics(path: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  try {
    const config = await readConfig(path), file = await stat(path);
    checks.push({ check: 'configuration', state: process.platform !== 'win32' && (file.mode & 0o077) ? 'fail' : 'pass', detail: 'Device configuration parsed; it must be readable by its owner only.', next: 'Use chmod 600 on this private config; never paste its contents into support reports.' });
    const [major, minor] = process.versions.node.split('.').map(Number);
    checks.push({ check: 'runtime', state: major! > 22 || major === 22 && minor! >= 19 ? 'pass' : 'fail', detail: `Node ${process.versions.node}; requires 22.19+.` });
    checks.push({ check: 'supported_device', state: process.platform === 'darwin' && process.arch === 'arm64' ? 'pass' : 'fail', detail: `${process.platform}/${process.arch}; this release supports macOS arm64 + Codex.` });
    checks.push({ check: 'workdir', state: (await stat(config.cwd)).isDirectory() ? 'pass' : 'fail', detail: 'Configured work directory exists.' });
    const status = await control(config, 'status');
    checks.push({ check: 'daemon', state: status ? 'pass' : 'fail', detail: status ? 'Owning daemon answered through its authenticated local socket.' : 'No owning daemon answered.', next: 'Start the installed entrypoint; status/start never imply model execution.' });
    const sameEndpoint = status?.endpoint === config.endpoint;
    checks.push({ check: 'daemon_configuration', state: status ? sameEndpoint ? 'pass' : 'fail' : 'unknown',
      detail: sameEndpoint ? 'Owning daemon uses the saved server endpoint.' : 'The saved endpoint is not confirmed by the owning daemon.',
      next: 'If the endpoint changed, reconcile active/unknown executions before restarting this device in a maintenance window.' });
    checks.push({ check: 'device_authentication', state: status?.connected && sameEndpoint ? 'pass' : status ? 'fail' : 'unknown',
      detail: status && !sameEndpoint ? 'The daemon connection belongs to a different endpoint; it does not verify this saved configuration.'
        : status?.connected ? 'Existing device connection was accepted by the configured server.' : status?.connectionError ?? 'No accepted device connection was observed.',
      next: 'Check the intended server, device pairing and protocol. Doctor never opens a second connection with this device identity.' });
    try {
      const health = await queryServerHealth(config.endpoint, config.caFile ? await readFile(config.caFile, 'utf8') : undefined);
      checks.push({ check: 'server_transport', state: health.status === 'ok' ? 'pass' : 'fail', detail: 'Health endpoint reached with normal certificate verification.' });
      checks.push({ check: 'device_protocol', state: health.deviceProtocol === undefined ? 'unknown' : health.deviceProtocol === DEVICE_PROTOCOL_VERSION ? 'pass' : 'fail', detail: `Server=${health.deviceProtocol ?? 'unknown'}; device=${DEVICE_PROTOCOL_VERSION}.`, next: 'If healthz is absent on a separate device port, check the public application/health endpoint with server doctor.' });
    } catch (error) {
      checks.push({ check: 'server_health', state: status?.connected ? 'unknown' : 'fail', detail: diagnosticError(error), next: 'Check DNS, trusted CA, server and healthz proxy routing. Separate device ports may not serve healthz.' });
    }
    const { discoverCodexInstallation } = await import('@harness-dock/drivers');
    const provider = await discoverCodexInstallation({ environment: process.env, homeDirectory: homedir(), override: config.providers?.codex, signal: AbortSignal.timeout(20_000) });
    checks.push({ check: 'codex_installation', state: provider.status === 'installed' ? 'pass' : 'fail', detail: `Codex ${provider.status}${provider.version ? ` (${provider.version})` : ''}.`, next: 'Install/log in using native Codex. Set providers.codex.executable/home locally if discovery is ambiguous.' });
    checks.push({ check: 'native_auth_and_protocol', state: 'unknown', detail: 'Installation discovery does not verify native login, ACP, model access, desktop tools or plugins.', next: 'Use the authorized application client doctor for explicit protocol probing; run client test separately for real execution.' });
    if (status?.unresolvedRunIds?.length) checks.push({ check: 'unresolved_execution', state: 'fail', detail: `${status.unresolvedRunIds.length} execution(s) need reconciliation.`, next: 'Query original run IDs; do not clear state or resend prompts to bypass unknown results.' });
  } catch (error) {
    checks.push({ check: 'device', state: 'fail', detail: diagnosticError(error), next: 'Check private config, workdir and native installation. No configuration was rewritten.' });
  }
  return checks;
}

export async function deviceDoctor(path: string, json = false) {
  const checks = await deviceDiagnostics(path);
  printDiagnostics(checks, json); return checks;
}
