import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Preserve a startup failure category before the isolated test deletes its state. */
export async function withStartupEvidence<T>(stateDir: string, start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    const log = await readFile(join(stateDir, 'daemon.log'), 'utf8').catch(() => undefined);
    const category = log?.match(/^windows_security_detail:(?:assert|protect|pipe):[\w.,+]{1,100}$/mu)?.[0]
      ?? log?.match(/^(?:windows_(?:pipe_acl|private_path)_unavailable|unsafe_log_file|invalid_state_file_permissions|unable to open database file|Working directory must be a directory|database is locked)$/mu)?.[0];
    throw new Error(`Fixture daemon startup failed (${category ?? (log === undefined ? 'no startup log' : 'unclassified startup log')})`, { cause: error });
  }
}
