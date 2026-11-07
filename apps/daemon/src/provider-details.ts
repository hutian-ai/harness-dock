import { nativePermissionModes } from '@harness-dock/drivers';

export interface ProviderDetails {
  checkedAt: number;
  state: 'reported' | 'unavailable';
  models: { id: string; name?: string; provider?: string; efforts: string[] }[];
  modelsTruncated: boolean;
  defaults: { model: string | null; effort: string | null; mode: string | null; sandbox: string | null; approvalPolicy: string | null };
  permissionModes: { id: string; name: string }[];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u001f]/u.test(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.flatMap(item => { const text = label(item); return text && text.length <= 64 ? [text] : []; }))].slice(0, 32) : [];

/** ACP values are opaque execution identities; names and groups are presentation only. */
function modelLabels(options: unknown): Map<string, { name?: string; provider?: string }> {
  const result = new Map<string, { name?: string; provider?: string }>();
  const visit = (entries: unknown, provider?: string, depth = 0): void => {
    if (!Array.isArray(entries) || depth > 4) return;
    for (const entry of entries) {
      const row = object(entry), id = label(row.value), name = label(row.name);
      if (id && !result.has(id)) result.set(id, { ...(name ? { name } : {}), ...(provider ? { provider } : {}) });
      else if (!id) visit(row.options, label(row.name) ?? label(row.group) ?? provider, depth + 1);
    }
  };
  visit(options);
  return result;
}

/** Bounded local presentation projection. Never expose native config, environment or credentials. */
export function providerDetails(value: { status: string; inspection?: unknown; checkedAt?: number }): ProviderDetails | undefined {
  if (value.checkedAt === undefined) return undefined;
  const native = object(value.inspection), config = object(native.config);
  const options = Array.isArray(native.configOptions) ? native.configOptions.map(object) : [];
  const current = (key: string) => label(options.find(option => option.id === key && option.type === 'select')?.currentValue);
  const labels = modelLabels(options.find(option => option.type === 'select' && (option.id === 'model' || option.category === 'model'))?.options);
  const rows = Array.isArray(native.models) ? native.models : [];
  const models = rows.flatMap(row => {
    const item = object(row), id = label(item.id);
    return id ? [{ id, ...labels.get(id), efforts: strings(item.efforts) }] : [];
  }).filter((row, index, all) => all.findIndex(other => other.id === row.id) === index);
  const permissions = nativePermissionModes(native.configOptions);
  const permissionModes = (Array.isArray(native.permissionModes) ? native.permissionModes : permissions.permissionModes)
    .flatMap(row => { const item = object(row), id = label(item.value), name = label(item.name); return id && name ? [{ id, name }] : []; }).slice(0, 32);
  const model = label(native.currentModelId) ?? current('model');
  const mode = label(native.defaultPermissionMode) ?? permissions.defaultPermissionMode;
  const result: ProviderDetails = {
    checkedAt: value.checkedAt, state: value.status === 'ready' ? 'reported' : 'unavailable',
    models: models.slice(0, 128), modelsTruncated: models.length > 128,
    defaults: {
      model: models.some(item => item.id === model) ? model : null,
      effort: current('reasoning_effort'), mode: permissionModes.some(item => item.id === mode) ? mode : null,
      sandbox: label(config.sandbox), approvalPolicy: label(config.approvalPolicy),
    }, permissionModes,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 && result.models.length) {
    result.models.pop(); result.modelsTruncated = true;
  }
  return result;
}
