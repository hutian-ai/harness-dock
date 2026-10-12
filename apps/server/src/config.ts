import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DockError, id, isLoopback } from '@harness-dock/protocol';
import { record, SERVER_MAX_CLIENTS, SERVER_MAX_NODES } from '@harness-dock/client';

export interface ServerConfig {
  host: string;
  devicePort: number;
  clientPort: number;
  tls?: { keyFile: string; certFile: string };
  nodes: { nodeId: string; token: string; label?: string }[];
  clients: { clientId: string; token: string; nodeIds: string[] }[];
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DockError('unknown_config_field');
}
function text(value: unknown, max = 4_096): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new DockError('invalid_config');
  return value;
}
function port(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65_535) throw new DockError('invalid_port');
  return value as number;
}
export function parseServerConfig(input: unknown): ServerConfig {
  const config = record(input);
  keys(config, ['host', 'devicePort', 'clientPort', 'tls', 'nodes', 'clients']);
  const host = config.host === undefined ? '127.0.0.1' : text(config.host, 253);
  const devicePort = port(config.devicePort, 48518), clientPort = port(config.clientPort, 48519);
  if (devicePort !== 0 && devicePort === clientPort) throw new DockError('duplicate_listen_port');
  let tls: ServerConfig['tls'];
  if (config.tls !== undefined) {
    const files = record(config.tls); keys(files, ['keyFile', 'certFile']);
    tls = { keyFile: text(files.keyFile), certFile: text(files.certFile) };
  }
  if (!isLoopback(host) && !tls) throw new DockError('tls_required');
  if (!Array.isArray(config.nodes) || !config.nodes.length || config.nodes.length > SERVER_MAX_NODES
    || !Array.isArray(config.clients) || !config.clients.length || config.clients.length > SERVER_MAX_CLIENTS)
    throw new DockError('invalid_pairing_count');
  const nodeIds = new Set<string>(), clientIds = new Set<string>(), tokens = new Set<string>(), owners = new Set<string>();
  const token = (value: unknown) => {
    const result = text(value, 512);
    if (result.length < 32 || !/^[A-Za-z0-9_-]+$/.test(result)) throw new DockError('invalid_token');
    if (tokens.has(result)) throw new DockError('duplicate_token');
    tokens.add(result); return result;
  };
  const nodes = config.nodes.map(value => {
    const node = record(value); keys(node, ['nodeId', 'token', 'label']);
    const nodeId = id.parse(node.nodeId);
    if (nodeIds.has(nodeId)) throw new DockError('duplicate_node');
    nodeIds.add(nodeId);
    return { nodeId, token: token(node.token), ...(node.label !== undefined ? { label: text(node.label, 256) } : {}) };
  });
  const clients = config.clients.map(value => {
    const client = record(value); keys(client, ['clientId', 'token', 'nodeIds']);
    const clientId = id.parse(client.clientId);
    if (clientIds.has(clientId)) throw new DockError('duplicate_client');
    clientIds.add(clientId);
    if (!Array.isArray(client.nodeIds) || !client.nodeIds.length || client.nodeIds.length > SERVER_MAX_NODES)
      throw new DockError('invalid_node_grants');
    const grants = client.nodeIds.map(value => {
      const nodeId = id.parse(value);
      if (!nodeIds.has(nodeId)) throw new DockError('unknown_node_grant');
      if (owners.has(nodeId)) throw new DockError('duplicate_node_owner');
      owners.add(nodeId); return nodeId;
    });
    return { clientId, token: token(client.token), nodeIds: grants };
  });
  if (owners.size !== nodes.length) throw new DockError('unowned_node');
  return { host, devicePort, clientPort, tls, nodes, clients };
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
