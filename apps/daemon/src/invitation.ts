import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { assertEndpoint, id, parseInvitationLink } from '@harness-dock/protocol';
import { assertWindowsPrivatePath } from '@harness-dock/drivers';
import { parseDevicePairing } from './config.ts';

export interface ConnectionRecovery {
  version: 1; nodeId: string; token: string; endpoint: string; cwd: string; caFile?: string;
}
const recoveryPath = (config: string) => join(dirname(config), 'invitation-claim.json');
function recovery(value: unknown): ConnectionRecovery {
  const item = value as ConnectionRecovery;
  if (!item || typeof item !== 'object' || item.version !== 1
    || Object.keys(item).some(key => !['version', 'nodeId', 'token', 'endpoint', 'cwd', 'caFile'].includes(key))
    || typeof item.cwd !== 'string' || !isAbsolute(item.cwd) || item.cwd.includes('\0')
    || item.caFile !== undefined && (typeof item.caFile !== 'string' || !isAbsolute(item.caFile) || item.caFile.includes('\0')))
    throw new Error('connection_recovery_unavailable');
  id.parse(item.nodeId); assertEndpoint(item.endpoint);
  if (typeof item.token !== 'string' || item.token.length < 32) throw new Error('connection_recovery_unavailable');
  return item;
}
/** Local recovery material contains a claimed credential, never an instruction to redeem again. */
export async function readConnectionRecovery(config: string): Promise<ConnectionRecovery | undefined> {
  let file;
  try { file = await open(recoveryPath(config), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('connection_recovery_unavailable'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32_768 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('connection_recovery_unavailable');
    await assertWindowsPrivatePath(recoveryPath(config));
    return recovery(JSON.parse(await file.readFile('utf8')));
  } catch { throw new Error('connection_recovery_unavailable'); }
  finally { await file.close(); }
}
export async function saveConnectionRecovery(config: string, value: ConnectionRecovery): Promise<void> {
  const encoded = JSON.stringify(recovery(value)), path = recoveryPath(config);
  if (Buffer.byteLength(encoded) > 32_768) throw new Error('connection_recovery_unavailable');
  if (await readConnectionRecovery(config)) throw new Error('connection_recovery_pending');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    // Exclusive publication cannot replace an earlier claim from another source-run caller.
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('connection_recovery_pending'); throw error; }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
export async function clearConnectionRecovery(config: string): Promise<void> {
  await rm(recoveryPath(config), { force: true });
}

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
