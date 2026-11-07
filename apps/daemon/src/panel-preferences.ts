import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assertWindowsPrivatePath, protectWindowsDirectory } from '@harness-dock/drivers';
import { id } from '@harness-dock/protocol';
import { withOperationOwner } from './operation-owner.ts';

export interface PendingTest { config: string; provider: 'codex' | 'dsh'; id: string }
export type PanelAppearance = 'system' | 'light' | 'dark';
export type PanelPreferenceOperation = 'preferences' | 'save-selection' | 'save-test-receipt' | 'clear-test-receipt' | 'save-appearance' | 'save-disconnection';
export function panelPreferencesRoot(home = homedir()): string {
  return process.platform === 'win32'
    ? join(home === homedir() ? process.env.LOCALAPPDATA ?? join(home, 'AppData/Local') : join(home, 'AppData/Local'), 'HarnessDock/.local')
    : join(home, '.harness-dock/.local');
}
async function privateDirectory(root: string): Promise<void> {
  let created = false;
  try { await mkdir(root, { recursive: false, mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (created) await protectWindowsDirectory(root);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077)) throw new Error('invalid_panel_preferences');
  await assertWindowsPrivatePath(root);
}
async function read(root: string, name: string): Promise<unknown> {
  const file = join(root, name);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384
      || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077)) throw new Error('invalid_panel_preferences');
    await assertWindowsPrivatePath(file);
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function pending(value: unknown): PendingTest | undefined {
  if (value === undefined) return undefined;
  const item = value as PendingTest;
  if (!item || typeof item !== 'object' || !isAbsolute(item.config ?? '') || item.config.includes('\0')
    || !id.safeParse(item.id).success || !['codex', 'dsh'].includes(item.provider)
    || Object.keys(item).some(key => !['config', 'provider', 'id'].includes(key))) throw new Error('invalid_panel_preferences');
  return item;
}
/** GUI selection and a pre-dispatch receipt only. Execution evidence continues to belong to the daemon. */
export async function panelPreferences(operation: PanelPreferenceOperation,
  config: string, provider?: 'codex' | 'dsh', testId?: string, home = homedir(), appearance?: PanelAppearance, previousConfig?: string) {
  const root = panelPreferencesRoot(home);
  // Only the product's own parent is created. Existing ownership/ACLs are never silently rewritten.
  const parent = join(root, '..');
  try { await lstat(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  await privateDirectory(root);
  const current = await read(root, 'panel.json') as { config?: unknown; provider?: unknown; appearance?: unknown; previousConfig?: unknown } | undefined;
  if (current && (typeof current.config !== 'string' || !isAbsolute(current.config) || current.config.includes('\0')
    || current.provider !== undefined && typeof current.provider !== 'string'
    || current.appearance !== undefined && (typeof current.appearance !== 'string' || !['system', 'light', 'dark'].includes(current.appearance))
    || current.previousConfig !== undefined && (typeof current.previousConfig !== 'string' || !isAbsolute(current.previousConfig) || current.previousConfig.includes('\0')))) throw new Error('invalid_panel_preferences');
  let selectedConfig = typeof current?.config === 'string' ? current.config : config;
  let selectedProvider = typeof current?.provider === 'string' ? current.provider : '';
  let selectedAppearance = (current?.appearance ?? 'system') as PanelAppearance;
  let archivedConfig = typeof current?.previousConfig === 'string' ? current.previousConfig : undefined;
  const receipt = pending(await read(root, 'gpui-pending-test.json'));
  const save = async (name: string, value: unknown) => {
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(root, name));
      if (process.platform !== 'win32') {
        const directory = await open(root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  };
  if (operation === 'save-selection') {
    if (receipt && receipt.config !== config) throw new Error('device_busy');
    selectedConfig = config; selectedProvider = provider ?? selectedProvider;
    await save('panel.json', { config: selectedConfig, provider: selectedProvider, appearance: selectedAppearance, previousConfig: archivedConfig });
  }
  if (operation === 'save-appearance') {
    if (!appearance) throw new Error('invalid_panel_request');
    selectedAppearance = appearance;
    await save('panel.json', { config: selectedConfig, provider: selectedProvider, appearance, previousConfig: archivedConfig });
  }
  if (operation === 'save-disconnection') {
    if (receipt) throw new Error('unresolved_execution');
    if (!previousConfig || !isAbsolute(previousConfig) || previousConfig.includes('\0') || selectedConfig !== previousConfig || config === previousConfig)
      throw new Error('panel_selection_changed');
    selectedConfig = config; archivedConfig = previousConfig;
    await save('panel.json', { config, provider: selectedProvider, appearance: selectedAppearance, previousConfig });
  }
  if (operation === 'save-test-receipt') {
    if (!provider || !testId || !id.safeParse(testId).success) throw new Error('invalid_panel_request');
    // Exclusive publication prevents a second UI from replacing an unconfirmed dispatch identity.
    const next = { config, provider, id: testId };
    if (receipt && JSON.stringify(receipt) !== JSON.stringify(next)) throw new Error('self_test_id_conflict');
    if (!receipt) {
      const file = await open(join(root, 'gpui-pending-test.json'), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      if (process.platform !== 'win32') {
        const directory = await open(root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
  }
  if (operation === 'clear-test-receipt') {
    if (receipt && (receipt.config !== config || receipt.provider !== provider || receipt.id !== testId)) throw new Error('self_test_id_conflict');
    await rm(join(root, 'gpui-pending-test.json'), { force: true });
  }
  return { config: selectedConfig, provider: selectedProvider, appearance: selectedAppearance, pending: receipt, previousConfig: archivedConfig };
}

export function panelSelection(home = homedir()) {
  return panelPreferences('preferences', join(panelPreferencesRoot(home), 'device/config.json'), undefined, undefined, home);
}

/** Serialize only this client's connection/selection writes, including across UI processes. */
export async function withPanelConnectionChange<T>(home: string | undefined,
  change: (selection: Awaited<ReturnType<typeof panelSelection>>) => Promise<T>, recoverLegacy = false): Promise<T> {
  await panelSelection(home);
  const root = panelPreferencesRoot(home);
  return withOperationOwner({ path: join(root, 'connection-owner.sqlite'), legacyPath: join(root, 'connection.lock'),
    busy: 'connection_change_busy', legacy: 'connection_lock_legacy', invalid: 'invalid_panel_preferences', recoverLegacy },
  async () => change(await panelSelection(home)));
}
