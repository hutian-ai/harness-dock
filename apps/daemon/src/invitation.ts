import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { assertEndpoint, id, parseInvitationLink } from '@harness-dock/protocol';
import { parseDevicePairing } from './config.ts';

/** One explicit claim. No redirects or retries; trust is always checked by the native TLS stack. */
export async function claimInvitation(link: string, caFile?: string) {
  const invitation = parseInvitationLink(link), url = new URL(invitation.redeemUrl);
  const ca = caFile ? await readFile(caFile, 'utf8') : undefined;
  const body = JSON.stringify({ invitation: invitation.code });
  return new Promise<ReturnType<typeof parseDevicePairing>>((done, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', agent: false, ...(ca ? { ca } : {}), headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, response => {
      let text = '';
      response.on('error', () => reject(new Error('invitation_claim_unconfirmed')));
      response.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 16_384) request.destroy(); });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(response.statusCode === 410 ? 'invitation_unavailable' : 'invitation_claim_unconfirmed')); return; }
        try {
          const pairing = parseDevicePairing(JSON.parse(text));
          id.parse(pairing.nodeId); assertEndpoint(pairing.endpoint);
          if (pairing.token.length < 32 || pairing.nodeId !== invitation.envelope.nodeId || pairing.endpoint !== invitation.envelope.endpoint)
            throw new Error('invalid_invitation');
          done(pairing);
        } catch { reject(new Error('invitation_claim_unconfirmed')); }
      });
    });
    request.setTimeout(15_000, () => request.destroy());
    request.on('error', () => reject(new Error('invitation_claim_unconfirmed')));
    request.end(body);
  });
}
