import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceConfig } from './config.ts';
import { control } from './local-control.ts';

const exec = promisify(execFile);
type ServiceCommand = (args: string[]) => Promise<unknown>;
const serviceCommand: ServiceCommand = args => exec('/bin/launchctl', args, { timeout: 15_000, maxBuffer: 32_768 });

/** Retire only the recognized legacy service, after its owning daemon has acknowledged idle shutdown. */
export async function retireLegacyAutostart(configPath: string, config: DeviceConfig, home = homedir(), run = serviceCommand) {
  const path = join(home, 'Library/LaunchAgents/dev.harness-dock.device.plist');
  const archive = join(dirname(configPath), 'retired-autostart'), marker = join(archive, 'migration.json');
  let data: Buffer;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 16_384) throw new Error('legacy_service_unverified');
    data = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8'));
      return { retired: false, autostart: saved.configPath === await realpath(configPath) && saved.autostart === true };
    } catch { return { retired: false, autostart: false }; }
  }
  const result = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { timeout: 2_000, maxBuffer: 32_768 });
  const value = JSON.parse(result.stdout) as { Label?: unknown; ProgramArguments?: unknown; RunAtLoad?: unknown };
  const args = value.ProgramArguments;
  if (value.Label !== 'dev.harness-dock.device' || !Array.isArray(args) || args[2] !== 'run' || typeof args[3] !== 'string')
    throw new Error('legacy_service_unverified');
  if (await realpath(args[3]) !== await realpath(configPath)) return { retired: false, autostart: false };
  if (await control(config, 'status')) throw new Error('legacy_owner_still_running');
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const owner = await lstat(archive);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.() || owner.mode & 0o077)
    throw new Error('legacy_service_unverified');
  const backup = join(archive, `${createHash('sha256').update(data).digest('hex')}.plist`);
  try { await writeFile(backup, data, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(backup)).equals(data)) throw error; }
  await writeFile(marker, JSON.stringify({ configPath: await realpath(configPath), autostart: value.RunAtLoad === true }), { mode: 0o600 });
  try { await run(['bootout', `gui/${process.getuid!()}/dev.harness-dock.device`]); }
  catch (error) { if (![3, 113].includes(Number((error as { code?: unknown }).code))) throw error; }
  if (!(await readFile(path)).equals(data)) throw new Error('legacy_service_changed');
  await rm(path);
  return { retired: true, autostart: value.RunAtLoad === true };
}
