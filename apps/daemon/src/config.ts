import { resourceLimits, type DeviceResourceLimits } from './device-resources.ts';
import { isProviderEnvironment } from './provider-environment.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertEndpoint, id } from '@harness-dock/protocol';
import { assertWindowsPrivatePath, protectWindowsDirectory, providerKeys, type ProviderKey, type ProviderOverride } from '@harness-dock/drivers';
import { z } from 'zod';

export type NodeIdentity = { nodeId: string; endpoint: string; token: string; caFile?: string; };
export interface DeviceConfig extends NodeIdentity { mode: 'device'; cwd: string; stateDir: string; resources?: Partial<DeviceResourceLimits>; providers?: Partial<Record<ProviderKey, ProviderOverride>> }
const absolutePath = (error: string) => z.string({ error }).refine(isAbsolute, { error });
const providerOverride = z.strictObject({
  home: absolutePath('invalid_provider_home').optional(),
  executable: z.string({ error: 'invalid_provider_executable' }).optional(),
  disabled: z.boolean({ error: 'invalid_provider_disabled' }).optional(),
  environment: z.custom<Record<string, string>>(isProviderEnvironment, { error: 'invalid_provider_environment' }).optional(),
}, { error: 'invalid_provider_override' });
const deviceConfig = z.strictObject({
  nodeId: id, endpoint: z.unknown(),
  token: z.string({ error: 'weak_token' }).min(32, { error: 'weak_token' }),
  mode: z.literal('device', { error: 'unsupported_mode' }),
  resources: z.record(z.string(), z.unknown(), { error: 'invalid_resource_limit' }).optional(),
  cwd: absolutePath('Node directories must be absolute'), stateDir: absolutePath('Node directories must be absolute'),
  caFile: absolutePath('Node directories must be absolute').optional(),
  providers: z.partialRecord(z.enum(providerKeys), providerOverride, { error: 'invalid_provider_override' }).optional(),
}, { error: 'invalid_device_config' });
const devicePairing = z.strictObject({ nodeId: z.string(), token: z.string(), endpoint: z.string() });
export function parseDevicePairing(input: unknown): Pick<NodeIdentity, 'nodeId' | 'token' | 'endpoint'> {
  const parsed = devicePairing.safeParse(input);
  if (!parsed.success) throw new Error('invalid_device_pairing');
  return parsed.data;
}
export async function readConfig(path: string): Promise<DeviceConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as DeviceConfig;
  await assertWindowsPrivatePath(path);
  id.parse(config.nodeId);
  assertEndpoint(config.endpoint);
  const parsed = deviceConfig.safeParse(config);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  if (Object.values(config.providers ?? {}).some(provider => provider?.environment && Object.keys(provider.environment).length)) {
    const file = await stat(path);
    if (process.platform !== 'win32' && ((file.mode & 0o077) || file.uid !== process.getuid?.()))
      throw new Error('provider_environment_config_requires_owner_only');
  }
  await assertWindowsPrivatePath(config.stateDir);
  resourceLimits(config.resources);
  return config;
}

/** Preflight local storage before consuming a one-use invitation. Never rewrite existing permissions. */
export async function prepareDeviceHome(options: { home: string; cwd: string; caFile?: string }): Promise<void> {
  if (!(await stat(resolve(options.cwd))).isDirectory()) throw new Error('connection_local_preflight_failed');
  if (options.caFile) await readFile(resolve(options.caFile), 'utf8');
  const home = resolve(options.home);
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  for (const path of [home, join(home, 'state')]) {
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (created) await protectWindowsDirectory(path);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('connection_local_preflight_failed');
    await assertWindowsPrivatePath(path);
  }
  const probe = join(home, `.setup-${randomUUID()}.tmp`);
  try {
    const file = await open(probe, 'wx', 0o600);
    try { await file.writeFile('local setup storage check'); await file.sync(); } finally { await file.close(); }
  } finally { await rm(probe, { force: true }); }
}

export async function initializeDevice(options: { home: string; cwd: string; endpoint?: string; nodeId?: string; token?: string; caFile?: string;
  providers?: DeviceConfig['providers']; resources?: DeviceConfig['resources'] }, preparedHome = false) {
  const home = resolve(options.home), cwd = resolve(options.cwd);
  const endpoint = options.endpoint ?? 'ws://127.0.0.1:48518/';
  assertEndpoint(endpoint);
  const nodeId = options.nodeId ?? randomUUID(), token = options.token ?? randomBytes(32).toString('hex');
  id.parse(nodeId);
  if (token.length < 32) throw new Error('weak_token');
  if (!(await stat(cwd)).isDirectory()) throw new Error('Choose an existing working directory');
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  if (preparedHome) await prepareDeviceHome(options);
  else { await mkdir(home, { mode: 0o700 }); await protectWindowsDirectory(home); }
  const config: DeviceConfig = { mode: 'device', nodeId, token, endpoint, cwd, stateDir: join(home, 'state'),
    ...(options.providers ? { providers: options.providers } : {}), ...(options.resources ? { resources: options.resources } : {}),
    ...(options.caFile ? { caFile: resolve(options.caFile) } : {}) };
  if (!preparedHome) await mkdir(config.stateDir, { mode: 0o700 });
  await writeFile(join(home, '.gitignore'), '*\n', { mode: 0o600 });
  const file = await open(join(home, 'config.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(config, null, 2)); await file.sync(); } finally { await file.close(); }
  if (process.platform !== 'win32') {
    const directory = await open(home, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  await writeFile(join(home, 'controller.json'), JSON.stringify({ nodes: [{ nodeId, token }], endpoint }, null, 2), { mode: 0o600 });
  return { configPath: join(home, 'config.json'), controllerPath: join(home, 'controller.json') };
}
