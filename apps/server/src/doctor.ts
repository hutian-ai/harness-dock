import { DEVICE_PROTOCOL_VERSION, diagnosticError, printDiagnostics, queryServerHealth, type DiagnosticCheck } from '@harness-dock/protocol';
import { SERVER_PROTOCOL_VERSION } from '@harness-dock/client';
import { readServerConfig, serverConfigRevision } from './config.ts';
import { pairingEndpoint } from './pairing.ts';

export async function serverDoctor(path: string, options: { endpoint?: string; ca?: string; json?: boolean } = {}) {
  const checks: DiagnosticCheck[] = [];
  try {
    const { config } = await readServerConfig(path);
    checks.push({ check: 'configuration', state: 'pass', detail: `Valid private configuration; ${config.nodes.length} devices, ${config.clients.length} applications.` });
    const health = await queryServerHealth(options.endpoint ?? pairingEndpoint(config, 'client'), options.ca);
    checks.push({ check: 'server_transport', state: health.status === 'ok' ? 'pass' : 'fail', detail: `Verified health response: ${health.status}. TLS verification stays enabled.` });
    checks.push({ check: 'protocol', state: health.deviceProtocol === undefined || health.serverProtocol === undefined ? 'unknown'
      : health.deviceProtocol === DEVICE_PROTOCOL_VERSION && health.serverProtocol === SERVER_PROTOCOL_VERSION ? 'pass' : 'fail',
      detail: `Server device=${health.deviceProtocol ?? 'unknown'}, application=${health.serverProtocol ?? 'unknown'}; expected ${DEVICE_PROTOCOL_VERSION}/${SERVER_PROTOCOL_VERSION}.`,
      next: 'Use compatible server/device/SDK artifacts; a healthy HTTP endpoint alone is insufficient.' });
    checks.push({ check: 'loaded_configuration', state: !health.configRevision ? 'unknown' : health.configRevision === serverConfigRevision(config) ? 'pass' : 'fail',
      detail: !health.configRevision ? 'This server does not report a loaded revision.' : health.configRevision === serverConfigRevision(config) ? 'Running server loaded this pairing/routing revision.' : 'Pending changes: running server has a different revision. Revocation is not confirmed.',
      next: 'Only the owner should restart the intended server in a maintenance window, then repeat this check.' });
  } catch (error) {
    checks.push({ check: 'server', state: 'fail', detail: diagnosticError(error), next: 'Check config permissions, DNS, TLS/CA, healthz proxy routing and the intended server logs. Never disable certificate checks.' });
  }
  printDiagnostics(checks, options.json);
  return checks;
}
