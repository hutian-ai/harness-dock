import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DeviceController } from '../packages/client/src/index.ts';
import { DeviceHost } from '../apps/daemon/src/device-host.ts';
import { DeviceConnection } from '../apps/daemon/src/device-main.ts';
import { assertEndpoint, DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_HEADER } from '../packages/protocol/src/index.ts';

test('TLS trust, node identity and plaintext boundaries; authenticated WSS reconnects', async (t) => {
  const token = randomBytes(32).toString('hex'), nodeId = randomUUID();
  assert.throws(() => new DeviceController({ nodes: [{ token, nodeId }], host: '0.0.0.0' }), /tls_required/);
  for (const endpoint of ['ws://192.0.2.1/', 'ws://localhost/', 'wss://u:p@example.com/', 'wss://example.com/private'])
    assert.throws(() => assertEndpoint(endpoint), /verified wss/);
  assertEndpoint('wss://example.com/');
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/tls-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'), 'utf8');
  const client = new DeviceController({ nodes: [{ token, nodeId }], port: 0, tls: { cert, key: await readFile(join(dir, 'key.pem'), 'utf8') } });
  await client.ready;
  t.after(() => client.close());
  async function rejected(headers: Record<string, string>, ca?: string, servername?: string) {
    const options = { headers, ca, servername };
    const ws = new WebSocket(client.endpoint, options);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected authentication success')); });
      ws.once('error', () => resolve());
    });
    assert.equal(client.node(nodeId)!.connected, false);
  }
  const headers = { authorization: `Bearer ${token}`, [DEVICE_PROTOCOL_HEADER]: String(DEVICE_PROTOCOL_VERSION), 'x-dock-node': nodeId, 'x-dock-daemon': randomUUID() };
  await rejected(headers, cert, 'wrong-host.example');
  await rejected(headers); // Untrusted self-signed certificate.
  await rejected({ ...headers, 'x-dock-node': randomUUID() }, cert);
  await rejected({ ...headers, authorization: 'Bearer invalid' }, cert);
  const config = { mode: 'device' as const, nodeId, token, endpoint: client.endpoint, cwd: dir, stateDir: join(dir, 'state'),
    providers: { codex: { disabled: true }, lobi: { disabled: true }, zcode: { disabled: true }, 'deepseek-harness': { disabled: true } } };
  const host = new DeviceHost(config);
  const connection = new DeviceConnection(host, config, cert);
  t.after(async () => { connection.stop(); await host.close(); });
  const peer = client.node(nodeId)!;
  async function connected() {
    for (let n = 0; n < 200 && !peer.connected; n++) await delay(10);
    assert.equal(peer.connected, true);
  }
  connection.connect(); await connected();
  assert.equal((await peer.request<{ nodeId: string }>('inventory')).nodeId, nodeId);
  peer.disconnect();
  for (let n = 0; n < 100 && peer.connected; n++) await delay(5);
  await connected();
  assert.equal((await peer.request<{ daemonId: string }>('inventory')).daemonId, host.daemonId);
});
