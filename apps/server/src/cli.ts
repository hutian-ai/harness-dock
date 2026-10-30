#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const usage = `harness-dock-server init <new-private-directory> [--public-endpoint wss://dock.example.com/] [--host 127.0.0.1] [--public-host server.example] [--device-port 48518] [--client-port 48519] [--tls-key <key.pem> --tls-cert <cert.pem>]
harness-dock-server run <server.json>
harness-dock-server invite <server.json> [--node-id <UUID>] [--endpoint <recipient-WSS>] [--expires-in 900]
harness-dock-server deploy <server.json> --output <new-directory> --image <fixed-image-tag-or-digest> [--tls-cert <fullchain.pem> --tls-key <privkey.pem>]
harness-dock-server pair <server.json> <list|device-add|device-export|device-rotate|device-remove|client-add|client-export|client-rotate|client-remove|grant>
  [--node-id <UUID>] [--client <UUID>] [--from <previous-client-UUID>] [--label <name>] [--output <new-private-file>] [--endpoint <recipient-WSS>]
harness-dock-server doctor <server.json> [--endpoint <public-WSS>] [--ca-file <CA.pem>] [--json]
harness-dock-server --version
Pairing edits only save configuration. They NEVER restart or reload a running service; doctor confirms the loaded revision.`;

async function main(): Promise<void> {
  process.umask(0o077);
  const { positionals: [command, file, action, ...extra], values } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, 'public-host': { type: 'string' },
    'device-port': { type: 'string' }, 'client-port': { type: 'string' },
    'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    'public-endpoint': { type: 'string' }, output: { type: 'string' }, image: { type: 'string' },
    'node-id': { type: 'string' }, client: { type: 'string' }, from: { type: 'string' }, label: { type: 'string' },
    endpoint: { type: 'string' }, 'expires-in': { type: 'string' }, 'ca-file': { type: 'string' }, json: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  if (values.version) { console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  if (!command || command === 'help' || values.help) { console.log(usage); return; }
  if (!file || extra.length || command !== 'pair' && action || !['init', 'run', 'invite', 'pair', 'deploy', 'doctor'].includes(command)) throw new Error(usage);
  if (command === 'invite') {
    const { readServerConfig } = await import('./config.ts');
    const { createDeviceInvitation } = await import('./invitations.ts');
    const { config } = await readServerConfig(file);
    const invitation = createDeviceInvitation(config, { nodeId: values['node-id'], endpoint: values.endpoint,
      ttlSeconds: values['expires-in'] === undefined ? undefined : Number(values['expires-in']) });
    // Deliberate owner-side issuance. Normal server logs and pairing listings never contain claims.
    console.log(`连接邀请（有效至 ${invitation.expiresAt}，仅可领取一次）：\n${invitation.url}`);
    return;
  }
  if (command === 'pair') {
    const { managePairing } = await import('./pairing.ts');
    const commands = ['list', 'device-add', 'device-export', 'device-rotate', 'device-remove', 'client-add', 'client-export', 'client-rotate', 'client-remove', 'grant'] as const;
    if (!commands.includes(action as typeof commands[number])) throw new Error(usage);
    console.log(JSON.stringify(await managePairing(file, action as typeof commands[number], { nodeId: values['node-id'], clientId: values.client,
      fromClientId: values.from, label: values.label, output: values.output, endpoint: values.endpoint }), null, 2)); return;
  }
  if (command === 'deploy') {
    if (!values.output || !values.image) throw new Error('deploy requires --output and --image');
    const { generateDeployment } = await import('./deployment.ts');
    console.log(JSON.stringify(await generateDeployment(file, values.output, { image: values.image, certFile: values['tls-cert'], keyFile: values['tls-key'] }), null, 2)); return;
  }
  if (command === 'doctor') {
    const { serverDoctor } = await import('./doctor.ts');
    await serverDoctor(file, { endpoint: values.endpoint, ca: values['ca-file'] ? await readFile(values['ca-file'], 'utf8') : undefined, json: values.json }); return;
  }
  const { DockServer, initializeServer, readServerConfig } = await import('./index.ts');
  if (command === 'init') {
    if (Boolean(values['tls-key']) !== Boolean(values['tls-cert'])) throw new Error('TLS requires both --tls-key and --tls-cert');
    const files = await initializeServer({ home: file, host: values.host, publicHost: values['public-host'], publicEndpoint: values['public-endpoint'],
      devicePort: values['device-port'] === undefined ? undefined : Number(values['device-port']),
      clientPort: values['client-port'] === undefined ? undefined : Number(values['client-port']),
      tls: values['tls-key'] ? { keyFile: values['tls-key'], certFile: values['tls-cert']! } : undefined,
    });
    console.log(JSON.stringify(files, null, 2)); return;
  }
  if (Object.keys(values).length) throw new Error('run reads configuration only from server.json');
  const { config, tls } = await readServerConfig(file);
  const server = new DockServer({ ...config, tls,
    invitationStateDir: resolve(process.env.HARNESS_DOCK_INVITATION_STATE ?? join(dirname(file), 'invitation-state')) });
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
