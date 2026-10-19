import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { readConfig, parseDevicePairing } from '../apps/daemon/src/config.ts';
import { daemonEnvironment, providerEnvironment, providerDependencyVariables } from '../apps/daemon/src/provider-environment.ts';
import { parseServerConfig, readServerConfig } from '../apps/server/src/config.ts';

const token = () => randomBytes(32).toString('hex');
function pairing() {
  const device = { nodeId: randomUUID(), token: token() };
  const client = { clientId: randomUUID(), token: token(), nodeIds: [device.nodeId] };
  return { nodes: [device], clients: [client] };
}
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local/config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('server config retains defaults, explicit ephemeral ports and field-specific rejection', () => {
  const input = pairing(), base = parseServerConfig(input);
  assert.equal(base.host, '127.0.0.1');
  assert.equal(base.devicePort, 48518); assert.equal(base.clientPort, 48519);
  assert.equal(base.tls, undefined);
  assert.deepEqual(parseServerConfig({ ...input, devicePort: 0, clientPort: 0 }).nodes, input.nodes);
  assert.ok(!Object.hasOwn(parseServerConfig({ ...input, nodes: [{ ...input.nodes[0], label: undefined }] }).nodes[0]!, 'label'));
  assert.equal(parseServerConfig({ ...input, host: '0.0.0.0', tls: { keyFile: 'key.pem', certFile: 'cert.pem' } }).tls?.keyFile, 'key.pem');
  const cases: [unknown, string][] = [
    [null, 'invalid_request'], [[], 'invalid_request'],
    [{ ...input, extra: true }, 'unknown_config_field'],
    [{ ...input, tls: { keyFile: 'key.pem', certFile: 'cert.pem', extra: true } }, 'unknown_config_field'],
    [{ ...input, nodes: [{ ...input.nodes[0], extra: true }] }, 'unknown_config_field'],
    [{ ...input, clients: [{ ...input.clients[0], extra: true }] }, 'unknown_config_field'],
    [{ ...input, host: '' }, 'invalid_config'],
    ...[-1, 65_536, 1.5, '48518', null].map(value => [{ ...input, devicePort: value }, 'invalid_port'] as [unknown, string]),
    [{ ...input, devicePort: 10, clientPort: 10 }, 'duplicate_listen_port'],
    [{ ...input, nodes: [] }, 'invalid_pairing_count'],
    [{ ...input, clients: [] }, 'invalid_pairing_count'],
    [{ ...input, nodes: [{ ...input.nodes[0], token: 'short' }] }, 'invalid_token'],
    [{ ...input, nodes: [{ ...input.nodes[0], token: 'a'.repeat(513) }] }, 'invalid_config'],
    [{ ...input, nodes: [{ ...input.nodes[0], label: '' }] }, 'invalid_config'],
    [{ ...input, clients: [{ ...input.clients[0], nodeIds: [] }] }, 'invalid_node_grants'],
  ];
  for (const [value, kind] of cases) assert.throws(() => parseServerConfig(value), { kind });
});

test('server config validates complete ownership and credential isolation before startup', () => {
  const input = pairing(), device = input.nodes[0]!, client = input.clients[0]!;
  for (const [value, kind] of [
    [{ ...input, host: '0.0.0.0' }, 'tls_required'],
    [{ ...input, nodes: [device, device] }, 'duplicate_node'],
    [{ ...input, clients: [client, client] }, 'duplicate_client'],
    [{ ...input, clients: [{ ...client, token: device.token }] }, 'duplicate_token'],
    [{ ...input, clients: [{ ...client, nodeIds: [device.nodeId, device.nodeId] }] }, 'duplicate_node_owner'],
    [{ ...input, clients: [{ ...client, nodeIds: [randomUUID()] }] }, 'unknown_node_grant'],
    [{ ...input, nodes: [device, { nodeId: randomUUID(), token: token() }] }, 'unowned_node'],
  ] as [unknown, string][]) assert.throws(() => parseServerConfig(value), { kind });
});

test('server config file checks remain separate from schema validation', async t => {
  const directory = await temporary(t), path = join(directory, 'server.json');
  await writeFile(path, JSON.stringify(pairing()), { mode: 0o600 });
  assert.equal((await readServerConfig(path)).config.nodes.length, 1);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(readServerConfig(path), /config_permissions_require_0600/);
    await chmod(path, 0o600);
  }
  await writeFile(path, '{');
  await assert.rejects(readServerConfig(path), /invalid_config_json/);
  await writeFile(path, Buffer.alloc(128 * 1024 + 1));
  await assert.rejects(readServerConfig(path), /invalid_config_file/);
  await assert.rejects(readServerConfig(directory), /invalid_config_file/);
});

test('device config keeps optional compatibility while rejecting unsafe directories and overrides', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json');
  const base = { mode: 'device', nodeId: randomUUID(), token: ' '.repeat(32), endpoint: 'ws://127.0.0.1:1/', cwd: directory, stateDir: join(directory, 'state') };
  const read = async (input: object) => { await writeFile(path, JSON.stringify(input), { mode: 0o600 }); return await readConfig(path); };
  const optional = { ...base, extra: 'retained', caFile: '', providers: { codex: { executable: '', disabled: false } } };
  assert.deepEqual(await read(optional), optional, 'daemon config permits extra top-level fields without dropping them');
  for (const providers of [null, false, 0, '', 1, [], { codex: [] }])
    assert.deepEqual(await read({ ...base, providers }), { ...base, providers }, 'optional legacy empty inputs are not rewritten');
  for (const [change, message] of [
    [{ token: 'short' }, 'weak_token'], [{ mode: 'other' }, 'unsupported_mode'],
    [{ cwd: 'relative' }, 'Node directories must be absolute'],
    [{ caFile: 'relative' }, 'Node directories must be absolute'],
    [{ resources: null }, 'invalid_resource_limit'],
    [{ resources: { idleTimeoutMs: 0 } }, 'invalid_resource_limit'],
    [{ resources: { maxEventBytes: 100, maxPageBytes: 99 } }, 'invalid_resource_limit'],
    [{ providers: { other: {} } }, 'invalid_provider_override'],
    [{ providers: { codex: { command: 'shell' } } }, 'invalid_provider_override'],
    [{ providers: { codex: { home: 'relative' } } }, 'invalid_provider_home'],
    [{ providers: { codex: { executable: false } } }, 'invalid_provider_executable'],
    [{ providers: { codex: { disabled: 'true' } } }, 'invalid_provider_disabled'],
  ] as [object, string][]) await assert.rejects(read({ ...base, ...change }), error => error instanceof Error && error.message === message);
  await assert.rejects(read({ ...base, endpoint: 'ws://192.0.2.1/' }), /Use verified wss/);
});

test('provider dependencies are local explicit selections and cannot replace execution identity or policy', () => {
  const inherited = {
    PATH: '/usr/bin', HOME: '/home/example', TMPDIR: '/tmp/example', TEMP: '/tmp/example',
    CODEX_HOME: '/home/example/.codex', DSH_HOME: '/home/example/.dsh',
    HTTPS_PROXY: 'http://inherited.example:8080', NODE_EXTRA_CA_CERTS: '/inherited/ca.pem',
    NODE_OPTIONS: '--require=untrusted.js', HARNESS_DOCK_TOKEN: 'synthetic-controller-secret',
  };
  const daemon = daemonEnvironment(inherited);
  assert.equal(daemon.CODEX_HOME, inherited.CODEX_HOME);
  assert.equal(daemon.DSH_HOME, inherited.DSH_HOME);
  assert.equal(daemon.HARNESS_DOCK_TOKEN, undefined);
  assert.equal(daemon.NODE_OPTIONS, undefined);
  assert.equal(daemon.HTTPS_PROXY, undefined, 'dependency inheritance requires an explicit local selection');
  const selected = { HTTPS_PROXY: 'http://selected.example:8080', NODE_EXTRA_CA_CERTS: '/local/ca.pem', NO_PROXY: '' };
  assert.deepEqual(providerEnvironment({ environment: selected }, inherited), {
    PATH: inherited.PATH, HOME: inherited.HOME, TMPDIR: inherited.TMPDIR, TEMP: inherited.TEMP, ...selected,
  });
  assert.equal(providerEnvironment(undefined, inherited).HTTPS_PROXY, undefined);
  assert.deepEqual(providerEnvironment({ environment: {} }, {}), {});
  assert.deepEqual(providerEnvironment({ environment: Object.fromEntries(providerDependencyVariables.map(key => [key, 'selected'])) }, {}),
    Object.fromEntries(providerDependencyVariables.map(key => [key, 'selected'])));
  for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'CODEX_PATH', 'CODEX_APP_TOOLS_PIPE_PATH', 'ZCODE_BIN', 'NODE_OPTIONS', 'HARNESS_DOCK_TOKEN', 'API_TOKEN'])
    assert.throws(() => providerEnvironment({ environment: { [key]: 'synthetic-private-value' } }, inherited), { message: 'invalid_provider_environment' });
  for (const environment of [null, [], 'all', { HTTPS_PROXY: 1 }, { HTTPS_PROXY: 'bad\0value' }, { HTTPS_PROXY: 'x'.repeat(16_385) }])
    assert.throws(() => providerEnvironment({ environment } as never, inherited), { message: 'invalid_provider_environment' });
});

test('device config protects selected dependency values and returns them without rewriting', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json');
  const base = { mode: 'device', nodeId: randomUUID(), token: token(), endpoint: 'ws://127.0.0.1:1/', cwd: directory, stateDir: join(directory, 'state') };
  const config = { ...base, providers: {
    codex: { environment: { HTTPS_PROXY: 'http://proxy.example:8080', NODE_EXTRA_CA_CERTS: '/local/ca.pem' } },
    zcode: { environment: { NO_PROXY: 'localhost' } },
  } };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await readConfig(path), config);
  assert.equal(providerEnvironment(config.providers.zcode, {}).HTTPS_PROXY, undefined, 'selections are scoped to one Provider');
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(readConfig(path), { message: 'provider_environment_config_requires_owner_only' });
    await chmod(path, 0o600);
  }
  for (const environment of [null, [], { NODE_OPTIONS: '--require=synthetic.js' }, { HTTPS_PROXY: false }]) {
    await writeFile(path, JSON.stringify({ ...base, providers: { codex: { environment } } }));
    await assert.rejects(readConfig(path), { message: 'invalid_provider_environment' });
  }
});

test('device pairing rejects extra identity fields and CLI keeps file and flag checks', async t => {
  const input = { nodeId: randomUUID(), token: token(), endpoint: 'ws://127.0.0.1:1/' };
  assert.deepEqual(parseDevicePairing(input), input);
  // UUID/token/endpoint semantic checks still belong to initializeDevice.
  assert.deepEqual(parseDevicePairing({ nodeId: '', token: '', endpoint: '' }), { nodeId: '', token: '', endpoint: '' });
  for (const value of [null, [], { ...input, caFile: 'ca.pem' }, { ...input, token: 1 }, { ...input, nodeId: undefined }])
    assert.throws(() => parseDevicePairing(value), /invalid_device_pairing/);
  const directory = await temporary(t), path = join(directory, 'pairing.json');
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  const cli = (...args: string[]) => promisify(execFile)(process.execPath,
    [resolve('apps/daemon/dist/cli.js'), 'init', '--cwd', directory, '--home', join(directory, 'node'), '--pairing', path, ...args], { timeout: 10_000 });
  await assert.rejects(cli('--node-id', randomUUID()), /pairing_conflicts_with_identity_flags/);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(cli(), /invalid_pairing_file_permissions/);
    await chmod(path, 0o600);
  }
  await writeFile(path, JSON.stringify({ ...input, extra: true }));
  await assert.rejects(cli(), /invalid_device_pairing/);
});
