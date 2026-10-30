import { resolve } from 'node:path';
import { initializeDevice, readConfig } from './config.ts';
import { installationRoot, manageInstallation, readInstallation, startInstalled } from './installation.ts';

export interface DeviceSetupOptions {
  home: string; cwd: string; nodeId: string; token: string; endpoint: string;
  bundle: string; runtime?: string; root?: string; caFile?: string; autostart?: boolean;
}

/** Shared by the CLI and local device panel. Existing identities are never overwritten. */
export async function setupDevice(options: DeviceSetupOptions): Promise<{ configPath: string; installation: string; result: unknown }> {
  const path = resolve(options.home, 'config.json');
  try {
    const existing = await readConfig(path);
    if (existing.nodeId !== options.nodeId || existing.token !== options.token || existing.endpoint !== options.endpoint
      || existing.cwd !== resolve(options.cwd) || existing.caFile !== (options.caFile ? resolve(options.caFile) : undefined))
      throw new Error('setup_identity_conflict');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await initializeDevice(options);
  }
  const root = installationRoot(path, options.root);
  if (!await readInstallation(root, path))
    await manageInstallation('install', { config: path, root, bundle: options.bundle, runtime: options.runtime });
  const result = options.autostart ? await manageInstallation('autostart', { config: path, root }) : await startInstalled(path, root);
  return { configPath: path, installation: root, result };
}
