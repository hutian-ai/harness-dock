#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DockServer, initializeServer, readServerConfig } from './index.ts';

const usage = 'harness-dock-server init <private-directory> [--host 127.0.0.1] [--public-host server.example] [--device-port 48518] [--client-port 48519] [--tls-key <key.pem> --tls-cert <cert.pem>]\nharness-dock-server run <server.json>';

async function main(): Promise<void> {
  process.umask(0o077);
  const { positionals: [command, file, ...extra], values } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, 'public-host': { type: 'string' },
    'device-port': { type: 'string' }, 'client-port': { type: 'string' },
    'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!command || command === 'help' || values.help) { console.log(usage); return; }
  if (!file || extra.length || !['init', 'run'].includes(command)) throw new Error(usage);
  if (command === 'init') {
    if (Boolean(values['tls-key']) !== Boolean(values['tls-cert'])) throw new Error('TLS requires both --tls-key and --tls-cert');
    const files = await initializeServer({ home: file, host: values.host, publicHost: values['public-host'],
      devicePort: values['device-port'] === undefined ? undefined : Number(values['device-port']),
      clientPort: values['client-port'] === undefined ? undefined : Number(values['client-port']),
      tls: values['tls-key'] ? { keyFile: values['tls-key'], certFile: values['tls-cert']! } : undefined,
    });
    console.log(JSON.stringify(files, null, 2)); return;
  }
  if (Object.keys(values).length) throw new Error('run reads configuration only from server.json');
  const { config, tls } = await readServerConfig(file);
  const server = new DockServer({ ...config, tls });
  await server.ready;
  console.log(`harness-dock server ready: devices ${server.deviceEndpoint}; clients ${server.clientEndpoint}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => process.exit(0), () => process.exit(1));
  });
}
void main().catch(error => {
  // Configuration contains credentials; never print raw input or object dumps.
  console.error(error instanceof Error ? error.message : 'server_start_failed');
  process.exitCode = 1;
});
