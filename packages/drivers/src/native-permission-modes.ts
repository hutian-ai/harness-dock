import type { AcpRuntimeHandle, createAcpRuntime } from 'acpx/runtime';

export interface NativePermissionMode {
  value: string;
  name: string;
  description?: string;
}

/** ACP select metadata only; never infer modes from a product or version name. */
export function nativePermissionModes(configOptions: unknown): {
  permissionModes: NativePermissionMode[];
  defaultPermissionMode: string | null;
  permissionModeConfigId: string | null;
} {
  const options = Array.isArray(configOptions) ? configOptions : [];
  const mode = options.find(option => option?.type === 'select' && (option.category === 'mode' || option.id === 'mode'));
  const entries = Array.isArray(mode?.options) ? mode.options.flatMap((entry: { options?: unknown[] }) => entry.options ?? [entry]) : [];
  const permissionModes: NativePermissionMode[] = entries.flatMap((entry: { value?: unknown; name?: unknown; description?: unknown }) =>
    typeof entry.value === 'string' && entry.value.trim() && typeof entry.name === 'string'
      ? [{ value: entry.value, name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }] : []);
  return { permissionModes, defaultPermissionMode: permissionModes.some(option => option.value === mode?.currentValue) ? mode.currentValue : null,
    permissionModeConfigId: typeof mode?.id === 'string' ? mode.id : null };
}

/** Each adapter selects its verified native transport; failures never try another API. */
export async function applyNativePermissionMode(runtime: Pick<ReturnType<typeof createAcpRuntime>, 'getStatus' | 'setConfigOption' | 'setMode'>, handle: AcpRuntimeHandle, selected: string, signal: AbortSignal, transport: 'config-option' | 'session-mode' = 'config-option'): Promise<void> {
  const options = nativePermissionModes((await runtime.getStatus({ handle, signal })).details?.configOptions);
  if (!options.permissionModeConfigId || !options.permissionModes.some(mode => mode.value === selected)) throw new Error('permission_mode_unavailable');
  let configOptions: unknown;
  if (transport === 'session-mode') {
    await runtime.setMode({ handle, mode: selected, signal });
    configOptions = (await runtime.getStatus({ handle, signal })).details?.configOptions;
  } else {
    configOptions = (await runtime.setConfigOption({ handle, key: options.permissionModeConfigId, value: selected, signal })).configOptions;
  }
  const confirmed = nativePermissionModes(configOptions);
  if (confirmed.defaultPermissionMode !== selected) throw new Error('permission_mode_unconfirmed');
}
