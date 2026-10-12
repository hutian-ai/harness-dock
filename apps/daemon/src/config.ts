import { resourceLimits, type DeviceResourceLimits } from './device-resources.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertEndpoint, id } from '@harness-dock/protocol';
import type { CodexExecutionConfig, ContainerConfig, ProviderKey, ProviderOverride, ZCodeExecutionConfig } from '@harness-dock/drivers';

export type NodeIdentity = { nodeId: string; endpoint: string; token: string; caFile?: string; };
export type ProviderNodeConfig = NodeIdentity & (
  | (Omit<CodexExecutionConfig, 'sandbox'> & { provider?: 'codex'; container?: ContainerConfig; })
  | (ZCodeExecutionConfig & { provider: 'zcode'; })
);
export interface DeviceConfig extends NodeIdentity { mode: 'device'; cwd: string; stateDir: string; resources?: Partial<DeviceResourceLimits>; providers?: Partial<Record<ProviderKey, ProviderOverride>> }
export type NodeConfig = ProviderNodeConfig | DeviceConfig;
export async function readConfig(path: string): Promise<NodeConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as NodeConfig;
  id.parse(config.nodeId);
  assertEndpoint(config.endpoint);
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('weak_token');
  if ('mode' in config && config.mode === 'device') {
    if (config.resources !== undefined && (!config.resources || typeof config.resources !== 'object' || Array.isArray(config.resources))) throw new Error('invalid_resource_limit');
    resourceLimits(config.resources);
    for (const path of [config.cwd, config.stateDir, ...(config.caFile ? [config.caFile] : [])])
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Node directories must be absolute');
    if (config.providers) for (const [key, value] of Object.entries(config.providers)) {
      if (!['codex', 'lobi', 'deepseek-harness', 'zcode'].includes(key) || !value || typeof value !== 'object') throw new Error('invalid_provider_override');
      for (const field of Object.keys(value)) if (!['executable', 'home', 'disabled'].includes(field)) throw new Error('invalid_provider_override');
      if (value.home !== undefined && (typeof value.home !== 'string' || !isAbsolute(value.home))) throw new Error('invalid_provider_home');
      if (value.executable !== undefined && typeof value.executable !== 'string') throw new Error('invalid_provider_executable');
      if (value.disabled !== undefined && typeof value.disabled !== 'boolean') throw new Error('invalid_provider_disabled');
    }
    return config;
  }
  if ('mode' in config) throw new Error('unsupported_mode');
  const legacy = config as ProviderNodeConfig;
  if (legacy.provider !== undefined && legacy.provider !== 'codex' && legacy.provider !== 'zcode') throw new Error('unsupported_provider');
  if (legacy.provider === 'zcode' && 'container' in legacy) throw new Error('zcode_container_unsupported');
  for (const path of [config.cwd, config.stateDir, ...(legacy.provider === 'zcode' ? [legacy.zcodeHome, legacy.zcodeBin] : [legacy.codexHome])])
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Node directories must be absolute');
  return config;
}

export async function initialize(options: { home: string; cwd: string; authFrom?: string; endpoint?: string; provider?: 'codex' | 'zcode'; zcodeHome?: string; zcodeBin?: string; }) {
  const home = resolve(options.home), cwd = resolve(options.cwd);
  const endpoint = options.endpoint ?? 'ws://127.0.0.1:48517/';
  assertEndpoint(endpoint);
  let auth: Buffer | undefined;
  if (options.provider === 'zcode') {
    if (!options.zcodeHome || !options.zcodeBin || options.authFrom) throw new Error('ZCode requires --zcode-home and --zcode-bin; --auth-from is Codex-only');
    if (!(await stat(resolve(options.zcodeHome))).isDirectory() || !(await stat(resolve(options.zcodeBin))).isFile()) throw new Error('ZCode home or binary is unavailable');
  } else {
    if (!options.authFrom) throw new Error('Codex requires --auth-from');
    auth = await readFile(resolve(options.authFrom));
    JSON.parse(auth.toString()); // Fail before creating the node if auth is invalid.
  }
  if (!(await stat(cwd)).isDirectory()) throw new Error('Choose an existing working directory');
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 }); // Never overwrite an existing node, credential, or state directory.
  const identity = {
    nodeId: randomUUID(), token: randomBytes(32).toString('hex'), endpoint, cwd,
    stateDir: join(home, 'state'),
  };
  const config: ProviderNodeConfig = options.provider === 'zcode'
    ? { ...identity, provider: 'zcode', zcodeHome: resolve(options.zcodeHome!), zcodeBin: resolve(options.zcodeBin!) }
    : { ...identity, codexHome: join(home, 'codex-home') };
  await mkdir(config.stateDir, { mode: 0o700 });
  await writeFile(join(home, '.gitignore'), '*\n', { mode: 0o600 });
  if (config.provider !== 'zcode') {
    await mkdir(config.codexHome, { mode: 0o700 });
    await writeFile(join(config.codexHome, 'auth.json'), auth!, { mode: 0o600 });
    await writeFile(join(config.codexHome, 'config.toml'), [
    '# Node-local configuration; keep host plugins and skills out of the initial setup.',
    '[features]', 'plugins = false', 'remote_plugin = false', 'apps = false',
    'skip_host_skill_discovery = true', 'skill_mcp_dependency_install = false', '',
  ].join('\n'), { mode: 0o600 });
  }
  await writeFile(join(home, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(home, 'controller.json'), JSON.stringify({
    nodeId: config.nodeId, token: config.token, endpoint,
  }, null, 2), { mode: 0o600 });
  return { configPath: join(home, 'config.json'), controllerPath: join(home, 'controller.json') };
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
