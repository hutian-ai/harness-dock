import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DockClient } from '../packages/client/src/index.ts';
import { Engine } from '../apps/daemon/src/engine.ts';
import { DaemonConnection } from '../apps/daemon/src/connection.ts';
import { assertEndpoint, VERSION } from '../packages/protocol/src/index.ts';

test('TLS trust, node identity and plaintext boundaries; authenticated WSS reconnects', async (t) => {
  const token = randomBytes(32).toString('hex'), nodeId = randomUUID();
  assert.throws(() => new DockClient({ token, nodeId, host: '0.0.0.0' }), /tls_required/);
  for (const endpoint of ['ws://192.0.2.1/', 'ws://localhost/', 'wss://u:p@example.com/', 'wss://example.com/private'])
    assert.throws(() => assertEndpoint(endpoint), /verified wss/);
  assertEndpoint('wss://example.com/');
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/tls-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'), 'utf8');
  const client = new DockClient({ token, nodeId, port: 0, tls: { cert, key: await readFile(join(dir, 'key.pem'), 'utf8') } });
  await client.ready;
  t.after(() => client.close());
  async function rejected(headers: Record<string, string>, ca?: string, servername?: string) {
    const options = { headers, ca, servername };
    const ws = new WebSocket(client.endpoint, options);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected authentication success')); });
      ws.once('error', () => resolve());
    });
    assert.equal(client.connected, false);
  }
  const headers = { authorization: `Bearer ${token}`, 'x-dock-version': String(VERSION), 'x-dock-node': nodeId, 'x-dock-daemon': randomUUID() };
  await rejected(headers, cert, 'wrong-host.example');
  await rejected(headers); // Untrusted self-signed certificate.
  await rejected({ ...headers, 'x-dock-node': randomUUID() }, cert);
  await rejected({ ...headers, authorization: 'Bearer invalid' }, cert);
  const engine = new Engine({ inspect: async () => ({ models: [], config: { sandbox: 'workspace-write', approvalPolicy: 'on-request', nativeMemoryDisabled: true } }), execute: async () => { throw new Error('unused'); }, close: async () => { } }, { nodeId });
  const connection = new DaemonConnection(engine, client.endpoint, token, { ca: cert });
  t.after(async () => { connection.stop(); await engine.shutdown(); });
  connection.connect();
  await client.waitForConnection();
  assert.equal((await client.probe()).nodeId, nodeId);
  client.disconnect();
  while (client.connected) await delay(10);
  await client.waitForConnection();
  assert.equal((await client.probe()).daemonId, engine.daemonId);
});
