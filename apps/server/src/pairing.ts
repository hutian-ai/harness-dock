import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertEndpoint, isLoopback } from '@harness-dock/protocol';
import { parseServerConfig, readServerConfig, serverConfigRevision, type ServerConfig } from './config.ts';

export type PairingCommand = 'list' | 'device-add' | 'device-export' | 'device-rotate' | 'device-remove'
  | 'client-add' | 'client-export' | 'client-rotate' | 'client-remove' | 'grant';
export interface PairingOptions { nodeId?: string; clientId?: string; fromClientId?: string; label?: string; output?: string; endpoint?: string; }
const secret = () => randomBytes(32).toString('hex');

export function pairingEndpoint(config: ServerConfig, role: 'device' | 'client', override?: string): string {
  if (!override && !config.publicEndpoint && !isLoopback(config.host)) throw new Error('pairing_endpoint_required: supply --endpoint with this recipient public WSS address');
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const endpoint = override ?? config.publicEndpoint ?? `${config.tls ? 'wss' : 'ws'}://${host}:${role === 'device' ? config.devicePort : config.clientPort}/`;
  assertEndpoint(endpoint);
  return endpoint;
}

/** Local-owner administration only. File edits never imply that a running server loaded them. */
export async function managePairing(path: string, command: PairingCommand, options: PairingOptions = {}) {
  const file = await realpath(path), info = await lstat(file);
  if (process.getuid && info.uid !== process.getuid()) throw new Error('run_pairing_as_config_owner');
  const lock = join(dirname(file), `.${basename(file)}.lock`);
  const lease = await open(lock, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('pairing_busy: another edit or stale lock; inspect before removing it');
    throw error;
  });
  let exported: string | undefined;
  let committed = false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const original = await readFile(file);
    const { config } = await readServerConfig(file);
    if (command === 'list') return { identity: undefined, output: undefined, revision: serverConfigRevision(config),
      devices: config.nodes.map(({ nodeId, label }) => ({ nodeId, label, clientId: config.clients.find(client => client.nodeIds.includes(nodeId))!.clientId })),
      clients: config.clients.map(({ clientId, nodeIds }) => ({ clientId, nodeIds })),
      applied: 'unknown', next: 'Run server doctor against the running endpoint to compare the loaded configuration.' };
    const device = () => {
      const entry = config.nodes.find(node => node.nodeId === options.nodeId);
      if (!entry) throw new Error('unknown_device: use pair list to choose a nodeId');
      return entry;
    };
    const client = () => {
      const entry = config.clients.find(value => value.clientId === options.clientId);
      if (!entry) throw new Error('unknown_client: use pair list to choose a clientId');
      return entry;
    };
    let credential: object | undefined;
    let identity: string | undefined;
    if (command === 'device-add') {
      const owner = client();
      const entry = { nodeId: randomUUID(), token: secret(), ...(options.label ? { label: options.label } : {}) };
      config.nodes.push(entry); owner.nodeIds.push(entry.nodeId); identity = entry.nodeId;
      credential = { nodeId: entry.nodeId, token: entry.token, endpoint: pairingEndpoint(config, 'device', options.endpoint) };
    } else if (command === 'client-add') {
      const entry = { clientId: randomUUID(), token: secret(), nodeIds: [] as string[] };
      config.clients.push(entry); identity = entry.clientId;
      credential = { clientId: entry.clientId, token: entry.token, endpoint: pairingEndpoint(config, 'client', options.endpoint) };
    } else if (command === 'device-export' || command === 'device-rotate') {
      const entry = device();
      if (command === 'device-rotate') entry.token = secret();
      identity = entry.nodeId;
      credential = { nodeId: entry.nodeId, token: entry.token, endpoint: pairingEndpoint(config, 'device', options.endpoint) };
    } else if (command === 'client-export' || command === 'client-rotate') {
      const entry = client();
      if (command === 'client-rotate') entry.token = secret();
      identity = entry.clientId;
      credential = { clientId: entry.clientId, token: entry.token, endpoint: pairingEndpoint(config, 'client', options.endpoint) };
    } else if (command === 'device-remove') {
      const entry = device(); identity = entry.nodeId;
      config.nodes = config.nodes.filter(node => node !== entry);
      for (const owner of config.clients) owner.nodeIds = owner.nodeIds.filter(nodeId => nodeId !== entry.nodeId);
    } else if (command === 'client-remove') {
      const entry = client(); identity = entry.clientId;
      if (entry.nodeIds.length) throw new Error('client_has_devices: explicitly transfer or remove its devices first');
      config.clients = config.clients.filter(value => value !== entry);
    } else if (command === 'grant') {
      const entry = device(), target = client(); identity = entry.nodeId;
      const previous = config.clients.find(owner => owner.nodeIds.includes(entry.nodeId))!;
      if (previous !== target) {
        if (options.fromClientId !== previous.clientId) throw new Error('explicit_transfer_required: supply --from with the current clientId');
        previous.nodeIds = previous.nodeIds.filter(nodeId => nodeId !== entry.nodeId);
        target.nodeIds.push(entry.nodeId);
      }
    } else throw new Error('unsupported_pairing_command');
    const next = parseServerConfig(config);
    if (credential) {
      if (!options.output) throw new Error('credential_output_required: use --output; credentials are never printed');
      const outputPath = resolve(options.output);
      if (outputPath === file || outputPath === lock || outputPath === temporary) throw new Error('invalid_credential_output');
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      // A failed exclusive creation must never remove an existing recipient file.
      const target = await open(outputPath, 'wx', 0o600);
      exported = outputPath;
      try { await target.writeFile(JSON.stringify(credential, null, 2) + '\n'); await target.sync(); }
      catch (error) { await target.close(); await rm(exported, { force: true }); exported = undefined; throw error; }
      await target.close();
    }
    const changed = !['device-export', 'client-export'].includes(command);
    if (changed) {
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      if (!(await readFile(file)).equals(original)) throw new Error('configuration_changed_during_edit');
      await rename(temporary, file);
    }
    committed = true;
    return { identity, ...(exported ? { output: exported } : {}), revision: serverConfigRevision(next),
      applied: changed ? 'pending_restart' : 'unknown',
      next: changed ? 'Configuration saved only. In a maintenance window restart your isolated/self-hosted server, then run server doctor. Revocation is NOT confirmed until the loaded revision matches.' : 'Transfer only this recipient file over a private channel.' };
  } finally {
    if (exported && !committed) await rm(exported, { force: true });
    await rm(temporary, { force: true });
    await lease.close(); await rm(lock, { force: true });
  }
}
