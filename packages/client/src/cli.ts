#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { printDiagnostics } from '@harness-dock/protocol';
import { ServerClient } from './server-client.ts';
import { clientDoctor, loadClientOptions, promptNativePermission, runFirstTest } from './onboarding.ts';

process.umask(0o077);
const usage = `harness-dock-client nodes <client.json>
harness-dock-client doctor <client.json> [--node-id <UUID>] [--probe] [--json]
harness-dock-client test <client.json> [--node-id <UUID>] [--model <native-model>] [--approval]
harness-dock-client status <client.json> --node-id <UUID> --run-id <UUID>
harness-dock-client --version
test explicitly sends two synthetic model prompts and can use model quota. --approval requires a TTY and exposes only a synthetic test tool. It never auto-allows native permissions.
Use a dedicated application credential: one application identity supports one active connection. doctor never replaces an existing application or device connection.`;
try {
  const { positionals: [command, path, ...extra], values } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' }, probe: { type: 'boolean' },
    'node-id': { type: 'string' }, 'run-id': { type: 'string' }, model: { type: 'string' }, approval: { type: 'boolean' },
  } });
  if (values.version) console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (!command || command === 'help' || values.help) console.log(usage);
  else {
    if (!path || extra.length || !['nodes', 'doctor', 'test', 'status'].includes(command)) throw new Error(usage);
    const options = await loadClientOptions(path);
    if (command === 'doctor') printDiagnostics(await clientDoctor(options, values['node-id'], values.probe), values.json);
    else {
      if (command === 'test' && values.approval && !process.stdin.isTTY) throw new Error('approval_test_requires_interactive_terminal');
      const client = new ServerClient(options);
      try {
        await client.ready;
        if (command === 'nodes') console.log(JSON.stringify(client.listNodes(), null, 2));
        else {
          const nodes = client.listNodes(), nodeId = values['node-id'] ?? (nodes.length === 1 ? nodes[0]!.nodeId : undefined);
          const peer = nodeId ? client.node(nodeId) : undefined;
          if (!peer) throw new Error('select_granted_device: use nodes and --node-id');
          if (!peer.connected) throw new Error('device_offline: start its daemon and check its doctor');
          if (command === 'status') {
            if (!values['run-id']) throw new Error('status requires --run-id');
            console.log(JSON.stringify(await peer.request('getExecution', { runId: values['run-id'] }), null, 2));
          } else console.log(JSON.stringify(await runFirstTest(peer, { model: values.model, approval: values.approval,
            permission: promptNativePermission, progress: value => console.error(JSON.stringify(value)) }), null, 2));
        }
      } finally { await client.close(); }
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'client_command_failed'); process.exitCode = 1; }
