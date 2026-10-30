import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { initializeServer } from '../apps/server/src/setup.ts';
import { readServerConfig, serverConfigRevision } from '../apps/server/src/config.ts';
import { managePairing, pairingEndpoint } from '../apps/server/src/pairing.ts';
import { generateDeployment } from '../apps/server/src/deployment.ts';
import { DockServer } from '../apps/server/src/index.ts';
import { ServerClient } from '../packages/client/src/server-client.ts';
import { loadClientOptions, runFirstTest } from '../packages/client/src/onboarding.ts';
import { queryServerHealth } from '../packages/protocol/src/index.ts';
import type { DeviceRequestHandler } from '../packages/client/src/device-controller.ts';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { serveControl } from '../apps/daemon/src/local-control.ts';
import { deviceDiagnostics } from '../apps/daemon/src/doctor.ts';

async function root() { await mkdir('.local', { recursive: true }); return mkdtemp(resolve('.local/p0-test-')); }

test('proxy setup exports the public endpoint; deployment generation never overwrites or embeds credentials', async t => {
  const dir = await root(); t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await initializeServer({ home: join(dir, 'control'), publicEndpoint: 'wss://dock.example.com/' });
  const { config } = await readServerConfig(files.serverPath);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.tls, undefined);
  const legacy = { ...config, host: '0.0.0.0', publicEndpoint: undefined };
  assert.throws(() => pairingEndpoint(legacy, 'device'), /pairing_endpoint_required/);
  assert.equal(pairingEndpoint(legacy, 'device', 'wss://dock.example.com:48518/'), 'wss://dock.example.com:48518/');
  for (const file of [files.clientPath, files.devicePairingPath]) assert.equal(JSON.parse(await readFile(file, 'utf8')).endpoint, config.publicEndpoint);
  const output = join(dir, 'deployment');
  await generateDeployment(files.serverPath, output, { image: 'harness-dock-server:0.1.0' });
  const compose = await readFile(join(output, 'compose.yaml'), 'utf8');
  assert.match(compose, /create_host_path: false/);
  assert.match(compose, /source: \$\{DOCK_INVITATION_STATE:\?Set DOCK_INVITATION_STATE\}/);
  assert.match(compose, /HARNESS_DOCK_INVITATION_STATE: \/var\/lib\/harness-dock\/invitations/);
  const stateDirectory = join(output, 'invitation-state');
  assert.ok((await stat(stateDirectory)).isDirectory());
  if (process.platform !== 'win32') assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  const environment = await readFile(join(output, '.env'), 'utf8');
  assert.ok(environment.includes(`DOCK_INVITATION_STATE=${JSON.stringify(stateDirectory)}`));
  const instructions = await readFile(join(output, 'README.txt'), 'utf8');
  assert.match(instructions, /DOCK_INVITATION_STATE.*absolute persistent directory/);
  assert.match(instructions, /preserve or privately transfer the entire invitation-state directory/);
  assert.match(instructions, /state directory at 0700/);
  assert.match(await readFile(join(output, 'nginx.conf'), 'utf8'), /location = \/healthz/);
  for (const name of ['compose.yaml', '.env', 'nginx.conf', 'README.txt']) {
    const content = await readFile(join(output, name), 'utf8');
    assert.ok(!content.includes(config.nodes[0]!.token)); assert.ok(!content.includes(config.clients[0]!.token));
  }
  await assert.rejects(generateDeployment(files.serverPath, output, { image: 'harness-dock-server:next' }), /EEXIST/);
  assert.equal(await readFile(join(output, 'compose.yaml'), 'utf8'), compose);
  await assert.rejects(generateDeployment(files.serverPath, join(dir, 'invalid'), { image: 'bad\nimage' }), /invalid_image_reference/);
});

test('pairing transactions preserve existing exports, serialize changes and keep grants explicit', async t => {
  const dir = await root(); t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await initializeServer({ home: join(dir, 'control'), publicEndpoint: 'wss://dock.example.com/' });
  const initial = (await readServerConfig(files.serverPath)).config, owner = initial.clients[0]!;
  const original = await readFile(files.serverPath, 'utf8');
  await assert.rejects(managePairing(files.serverPath, 'device-add', { clientId: owner.clientId, output: files.devicePairingPath }), /EEXIST/);
  assert.equal(await readFile(files.serverPath, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(files.devicePairingPath, 'utf8')).token, initial.nodes[0]!.token);
  const newClient = await managePairing(files.serverPath, 'client-add', { output: join(dir, 'app.json') });
  const added = await managePairing(files.serverPath, 'device-add', { clientId: owner.clientId, label: 'Test device', output: join(dir, 'device.json') });
  assert.equal(added.applied, 'pending_restart'); assert.ok(!JSON.stringify(added).includes('Bearer'));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'device.json'))).mode & 0o777, 0o600);
  await assert.rejects(managePairing(files.serverPath, 'grant', { nodeId: added.identity, clientId: newClient.identity }), /explicit_transfer_required/);
  await managePairing(files.serverPath, 'grant', { nodeId: added.identity, clientId: newClient.identity, fromClientId: owner.clientId });
  await assert.rejects(managePairing(files.serverPath, 'client-remove', { clientId: newClient.identity }), /client_has_devices/);
  const after = (await readServerConfig(files.serverPath)).config;
  assert.deepEqual(after.clients.find(client => client.clientId === newClient.identity)!.nodeIds, [added.identity]);
  const edits = await Promise.allSettled([0, 1].map(index => managePairing(files.serverPath, 'client-add', { output: join(dir, `concurrent-${index}.json`) })));
  assert.ok(edits.some(edit => edit.status === 'fulfilled'));
  for (const edit of edits) if (edit.status === 'rejected') assert.match(String(edit.reason), /pairing_busy/);
  const list = await managePairing(files.serverPath, 'list');
  for (const secret of [initial.nodes[0]!.token, owner.token]) assert.ok(!JSON.stringify(list).includes(secret));
  await managePairing(files.serverPath, 'device-remove', { nodeId: added.identity });
  await managePairing(files.serverPath, 'client-remove', { clientId: newClient.identity });
});

test('deployment preserves explicit isolated ports and literal dollar signs in configuration paths', async t => {
  const dir = await root(); t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await initializeServer({ home: join(dir, "control $tenant 'quoted'"), publicEndpoint: 'wss://dock.example.com:49443/', devicePort: 49518, clientPort: 49519 });
  const output = join(dir, 'deployment');
  await generateDeployment(files.serverPath, output, { image: 'harness-dock-server:candidate' });
  assert.ok((await readFile(join(output, '.env'), 'utf8')).includes('$$tenant'));
  const proxy = await readFile(join(output, 'nginx.conf'), 'utf8');
  assert.match(proxy, /listen 49443 ssl/); assert.match(proxy, /127\.0\.0\.1:49518/); assert.match(proxy, /127\.0\.0\.1:49519/);
  assert.match(await readFile(join(output, 'compose.yaml'), 'utf8'), /127\.0\.0\.1:49519\/healthz/);
  assert.match(await readFile(join(output, 'README.txt'), 'utf8'), /https:\/\/dock\.example\.com:49443\/healthz/);
});

test('device doctor refuses to combine a stale daemon endpoint with a different healthy server', async t => {
  const dir = await root(); t.after(() => rm(dir, { recursive: true, force: true }));
  const health = createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', deviceProtocol: 3 })));
  await new Promise<void>(done => health.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => health.close(() => done())));
  const address = health.address(); assert.ok(address && typeof address !== 'string');
  const files = await initializeDevice({ home: join(dir, 'device'), cwd: dir, endpoint: `ws://127.0.0.1:${address.port}/` });
  const config = await readConfig(files.configPath);
  await writeFile(files.configPath, JSON.stringify({ ...config, providers: { codex: { disabled: true }, dsh: { disabled: true } } }));
  const daemonId = randomUUID();
  const close = await serveControl(config, () => ({ nodeId: config.nodeId, daemonId, pid: process.pid, connected: true, endpoint: 'ws://127.0.0.1:1/' }), async () => {});
  t.after(close);
  const checks = await deviceDiagnostics(files.configPath);
  assert.equal(checks.find(check => check.check === 'server_transport')?.state, 'pass');
  assert.equal(checks.find(check => check.check === 'daemon_configuration')?.state, 'fail');
  assert.equal(checks.find(check => check.check === 'device_authentication')?.state, 'fail');
});

test('rotation is pending until loaded; old credentials fail after an explicit isolated restart', async t => {
  const dir = await root(); t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await initializeServer({ home: join(dir, 'control') });
  const old = (await readServerConfig(files.serverPath)).config;
  old.devicePort = 0; old.clientPort = 0;
  await writeFile(files.serverPath, JSON.stringify(old));
  let server = new DockServer({ ...old, tls: undefined }); await server.ready;
  t.after(() => server.close());
  const oldRevision = (await queryServerHealth(server.clientEndpoint)).configRevision;
  const rotation = await managePairing(files.serverPath, 'client-rotate', { clientId: old.clients[0]!.clientId, output: join(dir, 'rotated.json') });
  const next = (await readServerConfig(files.serverPath)).config;
  assert.equal(rotation.applied, 'pending_restart'); assert.notEqual(oldRevision, serverConfigRevision(next));
  assert.equal((await queryServerHealth(server.clientEndpoint)).configRevision, oldRevision);
  const previousClient = new ServerClient({ endpoint: server.clientEndpoint, ...old.clients[0]! });
  try { await previousClient.ready; } finally { await previousClient.close(); }
  await server.close(); server = new DockServer({ ...next, tls: undefined }); await server.ready;
  assert.equal((await queryServerHealth(server.clientEndpoint)).configRevision, rotation.revision);
  const stale = new ServerClient({ endpoint: server.clientEndpoint, ...old.clients[0]!, connectTimeoutMs: 150 });
  await assert.rejects(stale.ready); await stale.close();
  const accepted = new ServerClient({ endpoint: server.clientEndpoint, ...next.clients[0]! });
  try { await accepted.ready; assert.equal(accepted.listNodes().length, 1); } finally { await accepted.close(); }
  await assert.rejects(loadClientOptions(files.devicePairingPath), /invalid_client_file/);
});

test('health parsing rejects HTML without exposing its body or following redirects', async t => {
  const server = createServer((_req, res) => res.end('<html>PRIVATE_RESPONSE</html>'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(queryServerHealth(`ws://127.0.0.1:${address.port}/`), error => !String(error).includes('PRIVATE_RESPONSE') && /invalid_server_health/.test(String(error)));
});

test('first-run verification fences callbacks and never retries an uncertain execution', async () => {
  const nodeId = randomUUID(), daemonId = randomUUID();
  let handler: DeviceRequestHandler | undefined, executions = 0, releases = 0;
  const peer = { nodeId, daemonId, connected: true,
    onRequest(_method: string, next: DeviceRequestHandler) { handler = next; return () => { handler = undefined; }; },
    async request<T>(method: string): Promise<T> {
      if (method === 'inventory') return { nodeId, daemonId, providers: [{ key: 'codex', status: 'ready', capabilities: { exactFinalAnswer: true }, models: ['synthetic'] }] } as T;
      if (method === 'execute') { executions++; throw new Error('response_lost_after_admission'); }
      if (method === 'release' || method === 'forgetSession') releases++;
      return {} as T;
    },
  };
  await assert.rejects(runFirstTest(peer), /response_lost_after_admission.*original runs/);
  assert.equal(executions, 1); assert.equal(releases, 0); assert.equal(handler, undefined);
});

test('native approval response arriving after connection abort is never accepted', async () => {
  const nodeId = randomUUID(), daemonId = randomUUID(), signal = new AbortController();
  let handler: DeviceRequestHandler | undefined, secondTurn = 0;
  const peer = { nodeId, daemonId, connected: true,
    onRequest(_method: string, next: DeviceRequestHandler) { handler = next; return () => { handler = undefined; }; },
    async request<T>(method: string, params: object = {}): Promise<T> {
      if (method === 'inventory') return { nodeId, daemonId, providers: [{ key: 'codex', status: 'ready', capabilities: { exactFinalAnswer: true }, models: ['synthetic'] }] } as T;
      if (method === 'execute') {
        secondTurn++;
        await handler!({ ...params, kind: 'permission', payload: { options: [{ optionId: 'native-once', name: 'once' }] } }, { nodeId, daemonId, signal: signal.signal });
        throw new Error('late_permission_was_accepted');
      }
      return {} as T;
    },
  };
  await assert.rejects(runFirstTest(peer, { permission: async () => { signal.abort(); return { optionId: 'native-once' }; } }), error => !String(error).includes('late_permission_was_accepted'));
  assert.equal(secondTurn, 1);
});

test('first-run verification uses declared answer capability and native final messages, never an invented result flag', async () => {
  const nodeId = randomUUID(), daemonId = randomUUID(), threadId = randomUUID();
  let exact = false, executions = 0, releases = 0, forgotten = 0, marker = '';
  const peer = { nodeId, daemonId, connected: true,
    onRequest() { return () => {}; },
    async request<T>(method: string, params: object = {}): Promise<T> {
      if (method === 'inventory') return { nodeId, daemonId, providers: [{ key: 'codex', status: 'ready', capabilities: { exactFinalAnswer: exact }, models: ['synthetic'] }] } as T;
      if (method === 'execute') {
        const input = params as { prompt: string; resumeSessionId?: string };
        executions++;
        if (executions === 1) marker = input.prompt.match(/DOCK_TEST_[a-f0-9]+/)![0];
        else assert.equal(input.resumeSessionId, threadId);
        return { result: { state: 'completed', threadId, messages: [{ phase: 'final_answer', text: marker }] } } as T;
      }
      if (method === 'release') releases++;
      if (method === 'forgetSession') forgotten++;
      return {} as T;
    },
  };
  await assert.rejects(runFirstTest(peer), /test_exact_answer_unsupported/);
  assert.equal(executions, 0);
  exact = true;
  const result = await runFirstTest(peer);
  assert.equal(result.sameSessionVerified, true);
  assert.equal(result.modelExecutionVerified, true);
  assert.equal(executions, 2); assert.equal(releases, 2); assert.equal(forgotten, 1);
});
