import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Inspect only this product's bounded user registrations, including stopped installations. */
export async function panelExternalInstallation(configPath: string, expectedRoot: string, home = homedir()) {
  const agents = join(home, 'Library/LaunchAgents');
  let names: string[];
  try { names = (await readdir(agents)).filter(name => /^org\.harness-dock\.device\.[a-f0-9]{16}\.plist$/u.test(name)).sort(); }
  catch (error) { return { external: false, incomplete: (error as NodeJS.ErrnoException).code !== 'ENOENT' }; }
  const selected = await realpath(configPath);
  const canonicalRoot = async (path: string) => {
    try { return await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return join(await realpath(dirname(path)), basename(path));
    }
  };
  const expected = await canonicalRoot(resolve(expectedRoot));
  let incomplete = names.length > 16;
  for (const name of names.slice(0, 16)) {
    try {
      const file = join(agents, name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 16_384) { incomplete = true; continue; }
      const result = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 2_000, maxBuffer: 32_768 });
      const value = JSON.parse(result.stdout) as { ProgramArguments?: unknown };
      const args = value.ProgramArguments;
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || args[2] !== 'run'
        || typeof args[3] !== 'string' || !isAbsolute(args[3]) || args[3].includes('\0')) { incomplete = true; continue; }
      let registeredConfig: string;
      try { registeredConfig = await realpath(args[3]); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; continue; }
      if (registeredConfig !== selected) continue;
      if (typeof args[1] !== 'string' || !isAbsolute(args[1]) || args[1].includes('\0') || basename(args[1]) !== 'launch.cjs') {
        incomplete = true; continue;
      }
      if (await canonicalRoot(dirname(args[1])) !== expected) return { external: true, incomplete };
    } catch { incomplete = true; }
  }
  return { external: false, incomplete };
}

/** Only known device locations and our own LaunchAgents; never search home directories for credentials. */
export async function panelConfigurationPaths(selected: string, selectedOnly = false, home = homedir()) {
  const paths = new Set([selected]);
  let incomplete = false;
  if (!selectedOnly) {
    paths.add(join(home, '.harness-dock/.local/device/config.json'));
    const agents = join(home, 'Library/LaunchAgents');
    try {
      const names = (await readdir(agents)).filter(name => name === 'dev.harness-dock.device.plist'
        || /^org\.harness-dock\.device\.[a-f0-9]{16}\.plist$/u.test(name)).sort();
      if (names.length > 16) incomplete = true;
      for (const name of names.slice(0, 16)) {
        try {
          const file = join(agents, name), info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 16_384) { incomplete = true; continue; }
          const result = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 2_000, maxBuffer: 32_768 });
          const value = JSON.parse(result.stdout) as { ProgramArguments?: unknown };
          const args = value.ProgramArguments;
          if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || args[2] !== 'run'
            || typeof args[3] !== 'string' || !isAbsolute(args[3]) || args[3].includes('\0')) { incomplete = true; continue; }
          paths.add(args[3]);
        } catch { incomplete = true; }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; }
  }
  const existing = new Set<string>();
  for (const path of paths) {
    try { existing.add(await realpath(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; }
  }
  return { paths: [...existing], incomplete };
}
