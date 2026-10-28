import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export interface Autostart {
  loaded(): Promise<boolean>;
  check(runtime: string): Promise<void>;
  enable(runtime: string, previousRuntime?: string): Promise<void>;
  unload(runtime: string, previousRuntime?: string): Promise<void>;
  disable(runtime: string): Promise<void>;
  start(): Promise<void>;
  path: string;
}

export const nativePathVariables = ['CODEX_HOME', 'CODEX_CLI_PATH'] as const;
export function launchAgent(root: string, config: string, runtime: string, searchPath: string, userHome: string, environment: Record<string, string> = {}) {
  const label = `org.harness-dock.device.${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  const args = [runtime, join(root, 'launch.cjs'), 'run', config, '--background-log'];
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string><key>HOME</key><string>${xml(userHome)}</string>${nativePathVariables.filter(key => environment[key]).map(key => `<key>${key}</key><string>${xml(environment[key]!)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
</dict></plist>
`;
  return { label, content, path: join(userHome, 'Library/LaunchAgents', `${label}.plist`) };
}

/** Only the selected device's own user agent is registered; no sudo, PID signalling or global environment. */
export function macAutostart(root: string, config: string, searchPath: string, environment: Record<string, string> = {}): Autostart {
  if (process.platform !== 'darwin' || !process.getuid?.()) throw new Error('autostart_requires_macos_user_login');
  const uid = process.getuid();
  const userHome = homedir();
  const plan = (runtime: string) => launchAgent(root, config, runtime, searchPath, userHome, environment);
  const { label, path } = plan(process.execPath), target = `gui/${uid}/${label}`;
  const run = (...args: string[]) => exec('/bin/launchctl', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
  const loaded = async () => {
    try { await run('print', target); return true; }
    catch (error) { if ((error as { code?: number }).code === 113) return false; throw error; }
  };
  async function assertOwned(runtime: string, previousRuntime?: string): Promise<boolean> {
    let actual: string;
    try { actual = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (actual !== plan(runtime).content && (!previousRuntime || actual !== plan(previousRuntime).content)) throw new Error('autostart_file_modified');
    return true;
  }
  const unload = async (runtime: string, previousRuntime?: string) => {
    if (!await assertOwned(runtime, previousRuntime) && await loaded()) throw new Error('autostart_registration_without_owned_file');
    if (await loaded()) await run('bootout', target);
  };
  return {
    path, loaded, unload,
    async check(runtime) {
      if (!await assertOwned(runtime) && await loaded()) throw new Error('autostart_registration_without_owned_file');
    },
    async enable(runtime, previousRuntime) {
      if (!await assertOwned(runtime, previousRuntime) && await loaded()) throw new Error('autostart_registration_without_owned_file');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const pending = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(pending, plan(runtime).content, { mode: 0o600, flag: 'wx' }); await rename(pending, path); }
      finally { await rm(pending, { force: true }); }
      await run('enable', target);
      if (!await loaded()) await run('bootstrap', `gui/${uid}`, path);
    },
    async disable(runtime) {
      if (!await assertOwned(runtime)) {
        if (await loaded()) throw new Error('autostart_registration_without_owned_file');
        return;
      }
      await unload(runtime);
      await rm(path);
    },
    async start() { await run('kickstart', target); },
  };
}
