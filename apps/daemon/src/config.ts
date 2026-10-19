import { resourceLimits, type DeviceResourceLimits } from './device-resources.ts';
import { isProviderEnvironment } from './provider-environment.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertEndpoint, id } from '@harness-dock/protocol';
import type { ProviderKey, ProviderOverride } from '@harness-dock/drivers';
import { z } from 'zod';

export type NodeIdentity = { nodeId: string; endpoint: string; token: string; caFile?: string; };
export interface DeviceConfig extends NodeIdentity { mode: 'device'; cwd: string; stateDir: string; resources?: Partial<DeviceResourceLimits>; providers?: Partial<Record<ProviderKey, ProviderOverride>> }
const absolutePath = (error: string) => z.string({ error }).refine(isAbsolute, { error });
const providerOverride = z.preprocess(value => Array.isArray(value) && !value.length ? {} : value, z.strictObject({
  home: absolutePath('invalid_provider_home').optional(),
  executable: z.string({ error: 'invalid_provider_executable' }).optional(),
  disabled: z.boolean({ error: 'invalid_provider_disabled' }).optional(),
  environment: z.custom<Record<string, string>>(isProviderEnvironment, { error: 'invalid_provider_environment' }).optional(),
}, { error: 'invalid_provider_override' }));
const deviceConfig = z.looseObject({
  nodeId: id, endpoint: z.unknown(),
  token: z.string({ error: 'weak_token' }).min(32, { error: 'weak_token' }),
  mode: z.literal('device', { error: 'unsupported_mode' }),
  resources: z.record(z.string(), z.unknown(), { error: 'invalid_resource_limit' }).optional(),
  cwd: absolutePath('Node directories must be absolute'), stateDir: absolutePath('Node directories must be absolute'),
  caFile: z.preprocess(value => value || undefined, absolutePath('Node directories must be absolute').optional()),
  // Preserve the old optional/empty override inputs; validation does not rewrite the stored config.
  providers: z.preprocess(value => value ? Object.fromEntries(Object.entries(value)) : undefined,
    z.partialRecord(z.enum(['codex', 'lobi', 'deepseek-harness', 'zcode']), providerOverride, { error: 'invalid_provider_override' }).optional()),
});
const devicePairing = z.strictObject({ nodeId: z.string(), token: z.string(), endpoint: z.string() });
export function parseDevicePairing(input: unknown): Pick<NodeIdentity, 'nodeId' | 'token' | 'endpoint'> {
  const parsed = devicePairing.safeParse(input);
  if (!parsed.success) throw new Error('invalid_device_pairing');
  return parsed.data;
}
export async function readConfig(path: string): Promise<DeviceConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as DeviceConfig;
  id.parse(config.nodeId);
  assertEndpoint(config.endpoint);
  const parsed = deviceConfig.safeParse(config);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  if (Object.values(config.providers ?? {}).some(provider => provider?.environment && Object.keys(provider.environment).length)) {
    const file = await stat(path);
    if (process.platform !== 'win32' && ((file.mode & 0o077) || file.uid !== process.getuid?.()))
      throw new Error('provider_environment_config_requires_owner_only');
  }
  resourceLimits(config.resources);
  return config;
}

export async function initializeDevice(options: { home: string; cwd: string; endpoint?: string; nodeId?: string; token?: string; caFile?: string }) {
  const home = resolve(options.home), cwd = resolve(options.cwd);
  const endpoint = options.endpoint ?? 'ws://127.0.0.1:48518/';
  assertEndpoint(endpoint);
  const nodeId = options.nodeId ?? randomUUID(), token = options.token ?? randomBytes(32).toString('hex');
  id.parse(nodeId);
  if (token.length < 32) throw new Error('weak_token');
  if (!(await stat(cwd)).isDirectory()) throw new Error('Choose an existing working directory');
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const config: DeviceConfig = { mode: 'device', nodeId, token, endpoint, cwd, stateDir: join(home, 'state'),
    ...(options.caFile ? { caFile: resolve(options.caFile) } : {}) };
  await mkdir(config.stateDir, { mode: 0o700 });
  await writeFile(join(home, '.gitignore'), '*\n', { mode: 0o600 });
  await writeFile(join(home, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(home, 'controller.json'), JSON.stringify({ nodes: [{ nodeId, token }], endpoint }, null, 2), { mode: 0o600 });
  return { configPath: join(home, 'config.json'), controllerPath: join(home, 'controller.json') };
}
