import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertEndpoint, DockError, isLoopback } from '@harness-dock/protocol';
import { parseServerConfig } from './config.ts';

export interface ServerSetupOptions {
  home: string;
  host?: string;
  publicHost?: string;
  publicEndpoint?: string;
  devicePort?: number;
  clientPort?: number;
  tls?: { keyFile: string; certFile: string };
}
/** Generate one device + one application grant. Transfer only the recipient's file. */
export async function initializeServer(options: ServerSetupOptions) {
  const home = resolve(options.home);
  const host = options.host ?? '127.0.0.1';
  const publicHost = options.publicHost ?? host;
  if (!isLoopback(host) && !options.publicHost && !options.publicEndpoint) throw new DockError('public_host_required');
  const tls = options.tls ? { keyFile: resolve(options.tls.keyFile), certFile: resolve(options.tls.certFile) } : undefined;
  const nodeId = randomUUID(), clientId = randomUUID();
  const nodeToken = randomBytes(32).toString('hex'), clientToken = randomBytes(32).toString('hex');
  const config = parseServerConfig({
    host, devicePort: options.devicePort, clientPort: options.clientPort, tls, publicEndpoint: options.publicEndpoint,
    nodes: [{ nodeId, token: nodeToken }], clients: [{ clientId, token: clientToken, nodeIds: [nodeId] }],
  });
  if (!config.devicePort || !config.clientPort) throw new DockError('setup_requires_fixed_ports');
  const endpointHost = publicHost.includes(':') && !publicHost.startsWith('[') ? `[${publicHost}]` : publicHost;
  const endpoint = (port: number) => {
    const url = `${tls ? 'wss' : 'ws'}://${endpointHost}:${port}/`;
    assertEndpoint(url); return url;
  };
  const deviceEndpoint = options.publicEndpoint ?? endpoint(config.devicePort);
  const clientEndpoint = options.publicEndpoint ?? endpoint(config.clientPort);
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 }); // Never overwrite credentials or silently re-pair an existing installation.
  const serverPath = join(home, 'server.json'), clientPath = join(home, 'client.json'), devicePairingPath = join(home, 'device-pairing.json');
  await writeFile(join(home, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' });
  await writeFile(serverPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(clientPath, JSON.stringify({ clientId, token: clientToken, endpoint: clientEndpoint }, null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(devicePairingPath, JSON.stringify({ nodeId, token: nodeToken, endpoint: deviceEndpoint }, null, 2), { mode: 0o600, flag: 'wx' });
  return { serverPath, clientPath, devicePairingPath };
}
