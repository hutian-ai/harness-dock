import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertEndpoint, DockError, id, isLoopback } from '@harness-dock/protocol';
import { SERVER_MAX_CLIENTS, SERVER_MAX_NODES } from '@harness-dock/client';
import { z } from 'zod';

export interface ServerConfig {
  host: string;
  devicePort: number;
  clientPort: number;
  publicEndpoint?: string;
  tls?: { keyFile: string; certFile: string };
  nodes: { nodeId: string; token: string; label?: string }[];
  clients: { clientId: string; token: string; nodeIds: string[] }[];
}
const text = (max = 4_096) => z.string({ error: 'invalid_config' }).min(1, { error: 'invalid_config' }).max(max, { error: 'invalid_config' });
const objectError = { error: (issue: { code: string }) => issue.code === 'unrecognized_keys' ? 'unknown_config_field' : 'invalid_request' };
const port = z.number({ error: 'invalid_port' }).int({ error: 'invalid_port' }).min(0, { error: 'invalid_port' }).max(65_535, { error: 'invalid_port' });
const token = text(512).refine(value => value.length >= 32 && /^[A-Za-z0-9_-]+$/.test(value), { error: 'invalid_token' });
const configSchema = z.strictObject({
  host: text(253).default('127.0.0.1'), devicePort: port.default(48518), clientPort: port.default(48519),
  publicEndpoint: text().optional(),
  tls: z.strictObject({ keyFile: text(), certFile: text() }, objectError).optional(),
  nodes: z.array(z.strictObject({ nodeId: id, token, label: text(256).optional() }, objectError)
    .transform(node => ({ nodeId: node.nodeId, token: node.token, ...(node.label !== undefined ? { label: node.label } : {}) })), { error: 'invalid_pairing_count' })
    .max(SERVER_MAX_NODES, { error: 'invalid_pairing_count' }),
  clients: z.array(z.strictObject({ clientId: id, token,
    nodeIds: z.array(id, { error: 'invalid_node_grants' }).max(SERVER_MAX_NODES, { error: 'invalid_node_grants' }),
  }, objectError), { error: 'invalid_pairing_count' }).max(SERVER_MAX_CLIENTS, { error: 'invalid_pairing_count' }),
}, objectError);
export function parseServerConfig(input: unknown): ServerConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (/^[a-z_]+$/.test(issue.message)) throw new DockError(issue.message);
    throw parsed.error;
  }
  const { host, devicePort, clientPort, publicEndpoint, tls, nodes, clients } = parsed.data;
  if (publicEndpoint) assertEndpoint(publicEndpoint);
  if (devicePort !== 0 && devicePort === clientPort) throw new DockError('duplicate_listen_port');
  if (!isLoopback(host) && !tls) throw new DockError('tls_required');
  const nodeIds = new Set<string>(), clientIds = new Set<string>(), tokens = new Set<string>(), owners = new Set<string>();
  const claimToken = (value: string) => {
    if (tokens.has(value)) throw new DockError('duplicate_token');
    tokens.add(value);
  };
  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) throw new DockError('duplicate_node');
    nodeIds.add(node.nodeId); claimToken(node.token);
  }
  for (const client of clients) {
    if (clientIds.has(client.clientId)) throw new DockError('duplicate_client');
    clientIds.add(client.clientId);
    for (const nodeId of client.nodeIds) {
      if (!nodeIds.has(nodeId)) throw new DockError('unknown_node_grant');
      if (owners.has(nodeId)) throw new DockError('duplicate_node_owner');
      owners.add(nodeId);
    }
    claimToken(client.token);
  }
  if (owners.size !== nodes.length) throw new DockError('unowned_node');
  return { host, devicePort, clientPort, ...(publicEndpoint ? { publicEndpoint } : {}), tls, nodes, clients };
}

/** Fingerprint of loaded pairing/routing settings, never a substitute for TLS verification. */
export function serverConfigRevision(config: ServerConfig): string {
  return createHash('sha256').update(JSON.stringify({ ...parseServerConfig(config), tls: Boolean(config.tls) })).digest('hex');
}

export async function readServerConfig(path: string): Promise<{ config: ServerConfig; tls?: { key: string; cert: string } }> {
  const file = await stat(path);
  if (!file.isFile() || file.size > 128 * 1024) throw new DockError('invalid_config_file');
  if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) throw new DockError('config_permissions_require_0600');
  let input: unknown;
  try { input = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new DockError('invalid_config_json'); }
  const config = parseServerConfig(input);
  const tls = config.tls ? {
    key: await readFile(resolve(dirname(path), config.tls.keyFile), 'utf8'),
    cert: await readFile(resolve(dirname(path), config.tls.certFile), 'utf8'),
  } : undefined;
  return { config, tls };
}
