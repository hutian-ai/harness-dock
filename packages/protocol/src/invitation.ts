import { z } from 'zod';

export const invitationEnvelope = z.strictObject({
  version: z.literal(1), nodeId: z.uuid(), nonce: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(), origin: z.string().max(512), endpoint: z.string().max(512),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type InvitationEnvelope = z.infer<typeof invitationEnvelope>;

/** No credentials, query parameters or remote plaintext in an invitation's web origin. */
export function invitationOrigin(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid_invitation'); }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_invitation');
  return url;
}

/** Local preview only: opening a link never redeems it or installs a device. */
export function parseInvitationLink(input: string, now = Date.now()) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('invalid_invitation');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid_invitation'); }
  if (url.protocol === 'harness-dock:') {
    if (url.hostname !== 'connect' || url.port || url.pathname || url.hash || url.username || url.password
      || [...url.searchParams.keys()].join() !== 'invite') throw new Error('invalid_invitation');
    try { url = new URL(url.searchParams.get('invite')!); } catch { throw new Error('invalid_invitation'); }
  }
  const origin = invitationOrigin(`${url.origin}/`);
  if (url.username || url.password || url.pathname !== '/connect' || url.search
    || !/^#[A-Za-z0-9_-]{100,2048}$/.test(url.hash)) throw new Error('invalid_invitation');
  const code = url.hash.slice(1);
  let envelope: InvitationEnvelope;
  try { envelope = invitationEnvelope.parse(JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))); }
  catch { throw new Error('invalid_invitation'); }
  if (envelope.origin !== origin.origin) throw new Error('invalid_invitation');
  let endpoint: URL;
  try { endpoint = new URL(envelope.endpoint); } catch { throw new Error('invalid_invitation'); }
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || endpoint.hostname !== origin.hostname || endpoint.protocol !== (origin.protocol === 'https:' ? 'wss:' : 'ws:')
    || origin.protocol === 'https:' && endpoint.port !== origin.port) throw new Error('invalid_invitation');
  if (envelope.expiresAt <= now) throw new Error('invitation_expired');
  if (envelope.expiresAt > now + 3_600_000) throw new Error('invalid_invitation');
  return { code, envelope, url: url.href, redeemUrl: new URL('/invitations/redeem', origin).href, server: origin.host };
}
