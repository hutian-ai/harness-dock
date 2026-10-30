import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { invitationEnvelope, invitationOrigin, type InvitationEnvelope } from '@harness-dock/protocol';
import { pairingEndpoint } from './pairing.ts';
import type { ServerConfig } from './config.ts';

const signature = (value: Omit<InvitationEnvelope, 'signature'>, token: string) =>
  createHmac('sha256', token).update('harness-dock-invitation-v1\n' + JSON.stringify(value)).digest('hex');
function unsigned(value: InvitationEnvelope): Omit<InvitationEnvelope, 'signature'> {
  return { version: 1, nodeId: value.nodeId, nonce: value.nonce, expiresAt: value.expiresAt, origin: value.origin, endpoint: value.endpoint };
}

/** Owner-side generation; the URL contains a short-lived claim, never a native/device token. */
export function createDeviceInvitation(config: ServerConfig, options: { nodeId?: string; ttlSeconds?: number; endpoint?: string } = {}, now = Date.now()) {
  const node = options.nodeId ? config.nodes.find(value => value.nodeId === options.nodeId) : config.nodes.length === 1 ? config.nodes[0] : undefined;
  if (!node) throw new Error('choose_invitation_device: use --node-id from pair list');
  const ttl = options.ttlSeconds ?? 900;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new Error('invitation_ttl_must_be_60_to_3600_seconds');
  const endpoint = pairingEndpoint(config, 'device', options.endpoint);
  const url = new URL(endpoint); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // The application listener serves invitations; a public reverse proxy uses one origin for both roles.
  if (!config.publicEndpoint && !options.endpoint) url.port = String(config.clientPort);
  if (url.port === '0') throw new Error('invitation_requires_fixed_public_endpoint');
  const origin = invitationOrigin(url.href).origin;
  const value = { version: 1 as const, nodeId: node.nodeId, nonce: randomBytes(32).toString('hex'), expiresAt: now + ttl * 1000, origin, endpoint };
  const envelope = { ...value, signature: signature(value, node.token) };
  const link = new URL('/connect', origin); link.hash = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return { url: link.href, expiresAt: new Date(value.expiresAt).toISOString(), nodeId: node.nodeId };
}

/** Exclusive durable consumption prevents concurrent redemption and replay after server restart. */
export async function redeemDeviceInvitation(code: string, config: ServerConfig, stateDir: string, now = Date.now()) {
  let value: InvitationEnvelope;
  try {
    if (!/^[A-Za-z0-9_-]{100,2048}$/.test(code)) throw new Error();
    value = invitationEnvelope.parse(JSON.parse(Buffer.from(code, 'base64url').toString('utf8')));
  } catch { throw new Error('invitation_unavailable'); }
  const node = config.nodes.find(entry => entry.nodeId === value.nodeId);
  if (!node || value.expiresAt <= now || value.expiresAt > now + 3_600_000) throw new Error('invitation_unavailable');
  const actual = Buffer.from(value.signature, 'hex'), expected = Buffer.from(signature(unsigned(value), node.token), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invitation_unavailable');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const owner = await lstat(stateDir);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.() || owner.mode & 0o077)
    throw new Error('invitation_storage_unavailable');
  const name = createHash('sha256').update(`${value.nodeId}:${value.nonce}`).digest('hex');
  const marker = await open(join(stateDir, name), 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('invitation_unavailable');
    throw new Error('invitation_storage_unavailable');
  });
  try { await marker.writeFile(String(value.expiresAt)); await marker.sync(); } finally { await marker.close(); }
  // Persist the directory entry before releasing the device credential.
  const directory = await open(stateDir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { nodeId: node.nodeId, token: node.token, endpoint: value.endpoint };
}
