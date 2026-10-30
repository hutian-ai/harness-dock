import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseInvitationLink } from '../packages/protocol/src/invitation.ts';
import { createDeviceInvitation, redeemDeviceInvitation } from '../apps/server/src/invitations.ts';
import { DockServer } from '../apps/server/src/index.ts';
import type { ServerConfig } from '../apps/server/src/config.ts';
import { claimInvitation } from '../apps/daemon/src/invitation.ts';
import { panelError, panelStatus, runPanelOperation } from '../apps/daemon/src/panel-management.ts';

function config(): ServerConfig {
  const nodeId = randomUUID();
  return { host: '127.0.0.1', devicePort: 0, clientPort: 0, nodes: [{ nodeId, token: 'synthetic-device-token-never-in-an-invitation-link' }],
    clients: [{ clientId: randomUUID(), token: 'synthetic-application-token-never-exported', nodeIds: [nodeId] }] };
}
async function directory() { await mkdir('.local', { recursive: true }); return mkdtemp(resolve('.local/invitation-test-')); }

test('invitation links preview locally, bind the server, expire, and never contain permanent credentials', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...config(), publicEndpoint: 'wss://dock.example.com/' };
  const invitation = createDeviceInvitation(settings);
  const parsed = parseInvitationLink(invitation.url);
  assert.equal(parsed.server, 'dock.example.com');
  assert.equal(parsed.envelope.endpoint, settings.publicEndpoint);
  for (const credential of [settings.nodes[0]!.token, settings.clients[0]!.token]) {
    assert.ok(!invitation.url.includes(credential));
    assert.ok(!JSON.stringify(parsed.envelope).includes(credential));
  }
  const appLink = 'harness-dock://connect?invite=' + encodeURIComponent(invitation.url);
  assert.deepEqual(parseInvitationLink(appLink), parsed);
  const file = join(root, 'device/config.json');
  assert.deepEqual(await runPanelOperation({ operation: 'invitation', config: file, invitation: appLink }, root),
    { server: 'dock.example.com', nodeId: settings.nodes[0]!.nodeId });
  const unconfigured = await panelStatus(file);
  assert.equal(unconfigured.configured, false);
  assert.ok(!('nodeId' in unconfigured), 'installation discovery cannot create a device identity');
  assert.deepEqual(await readdir(root), []);
  for (const link of [invitation.url.replace('dock.example.com', 'other.example.com'), invitation.url.replace('https:', 'http:'),
    invitation.url.replace('/connect#', '/connect?claim=bad#'), 'file:///private/invitation', 'harness-dock://connect?invite=bad&invite=bad'])
    assert.throws(() => parseInvitationLink(link), /invalid_invitation/);
  assert.throws(() => parseInvitationLink(invitation.url, parsed.envelope.expiresAt), /invitation_expired/);
  assert.throws(() => createDeviceInvitation(settings, { ttlSeconds: 0 }), /invitation_ttl/);
});

test('HTTP claim delivers only the assigned device, is one-use under concurrency and survives restart', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = config(), stateDir = join(root, 'consumed');
  const server = new DockServer({ ...settings, tls: undefined, invitationStateDir: stateDir }); await server.ready;
  t.after(() => server.close());
  const live = { ...settings, devicePort: Number(new URL(server.deviceEndpoint).port), clientPort: Number(new URL(server.clientEndpoint).port) };
  const link = createDeviceInvitation(live), preview = parseInvitationLink(link.url);
  const page = await fetch(new URL('/connect', preview.redeemUrl));
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.match(html, /在 Harness Dock 中打开/); assert.ok(!html.includes(preview.code));
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const response = await fetch(preview.redeemUrl, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
    body: JSON.stringify({ invitation: preview.code }) });
  assert.equal(response.status, 403);
  const pairing = await claimInvitation(link.url);
  assert.deepEqual(pairing, { nodeId: live.nodes[0]!.nodeId, token: live.nodes[0]!.token, endpoint: server.deviceEndpoint });
  if (process.platform !== 'win32') assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  await assert.rejects(claimInvitation(link.url), /invitation_unavailable/);
  const next = createDeviceInvitation(live), code = parseInvitationLink(next.url).code;
  const claims = await Promise.allSettled([0, 1].map(() => redeemDeviceInvitation(code, live, stateDir)));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  await server.close();
  const restarted = new DockServer({ ...live, tls: undefined, invitationStateDir: stateDir }); await restarted.ready;
  t.after(() => restarted.close());
  await assert.rejects(claimInvitation(link.url), /invitation_unavailable/);
  const content = await Promise.all((await readdir(stateDir)).map(name => readFile(join(stateDir, name), 'utf8')));
  assert.ok(content.every(value => !value.includes(live.nodes[0]!.token)));
});

test('tampering, expired claims and rotated device tokens cannot release credentials', async t => {
  const root = await directory(); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...config(), publicEndpoint: 'wss://dock.example.com/' }, now = Date.now();
  const link = createDeviceInvitation(settings, {}, now), { code, envelope } = parseInvitationLink(link.url);
  const tampered = Buffer.from(JSON.stringify({ ...envelope, endpoint: 'wss://other.example.com/' })).toString('base64url');
  await assert.rejects(redeemDeviceInvitation(tampered, settings, join(root, 'claims'), now), /invitation_unavailable/);
  await assert.rejects(redeemDeviceInvitation(code, settings, join(root, 'claims'), envelope.expiresAt), /invitation_unavailable/);
  const rotated = { ...settings, nodes: [{ ...settings.nodes[0]!, token: 'rotated-device-token-must-invalidate-invitations' }] };
  await assert.rejects(redeemDeviceInvitation(code, rotated, join(root, 'claims'), now), /invitation_unavailable/);
  assert.deepEqual(await readdir(root), []);
  for (const reason of ['invalid_invitation', 'invitation_expired', 'invitation_unavailable', 'invitation_claim_unconfirmed'])
    assert.equal(panelError(new Error(reason)), reason);
});

test('an interrupted claim is not retried, and redirects never forward the invitation', async t => {
  let attempts = 0;
  const listener = createServer((request, response) => { attempts++; request.resume(); response.writeHead(307, { location: 'http://127.0.0.1:1/' }).end(); });
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => listener.close(() => done())));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const settings = { ...config(), devicePort: address.port, clientPort: address.port };
  const link = createDeviceInvitation(settings);
  await assert.rejects(claimInvitation(link.url), /invitation_claim_unconfirmed/);
  assert.equal(attempts, 1);
});
