import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { assertEndpoint } from './index.ts';

export interface ServerHealth {
  status: 'ok' | 'stopping'; version?: string; deviceProtocol?: number; serverProtocol?: number; configRevision?: string;
}
export interface DiagnosticCheck { check: string; state: 'pass' | 'fail' | 'unknown'; detail: string; next?: string; }

/** Public, bounded health metadata only. Never follows redirects or sends credentials. */
export async function queryServerHealth(endpoint: string, ca?: string, timeoutMs = 5_000): Promise<ServerHealth> {
  assertEndpoint(endpoint);
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = '/healthz';
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { ca, rejectUnauthorized: true, signal: AbortSignal.timeout(timeoutMs) }, res => {
      let body = '';
      res.on('error', reject);
      res.on('data', chunk => { body += String(chunk); if (body.length > 16_384) req.destroy(new Error('invalid_server_health')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('server_health_http_error');
          const value: unknown = JSON.parse(body);
          if (!value || typeof value !== 'object' || !('status' in value) || !['ok', 'stopping'].includes(String(value.status)))
            throw new Error('invalid_server_health');
          const input = value as Record<string, unknown>;
          resolve({ status: input.status as ServerHealth['status'],
            ...(typeof input.version === 'string' && /^[a-zA-Z0-9.+-]{1,80}$/.test(input.version) ? { version: input.version } : {}),
            ...(Number.isSafeInteger(input.deviceProtocol) ? { deviceProtocol: input.deviceProtocol as number } : {}),
            ...(Number.isSafeInteger(input.serverProtocol) ? { serverProtocol: input.serverProtocol as number } : {}),
            ...(typeof input.configRevision === 'string' && /^[a-f0-9]{64}$/.test(input.configRevision) ? { configRevision: input.configRevision } : {}),
          });
        } catch { reject(new Error('invalid_server_health: check the healthz proxy route and server version')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('server_health_timeout')));
    req.on('error', reject); req.end();
  });
}

/** Error summaries are deliberately allowlisted; raw errors can contain private paths or payloads. */
export function diagnosticError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const candidate = typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message.split(':')[0]! : '';
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(candidate) ? candidate : 'check_failed';
}

export function printDiagnostics(checks: DiagnosticCheck[], json = false): void {
  const report = { ok: !checks.some(check => check.state === 'fail'), modelExecutionVerified: false, checks };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of checks) console.log(`[${check.state.toUpperCase()}] ${check.check}: ${check.detail}${check.next ? `\n  Next: ${check.next}` : ''}`);
    console.log('No model prompt was sent. Protocol/installation checks do not verify model, browser or plugin execution.');
  }
  if (!report.ok) process.exitCode = 1;
}
