import { execa } from 'execa';

const routeNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;
const proxyNames = [...routeNames, 'NO_PROXY'] as const;
type Environment = Record<string, string>;
export interface ProxyDefaults {
  inherited: Environment;
  system: Environment;
  systemState: 'available' | 'unavailable' | 'unsupported' | 'not_applicable';
}
export interface ProviderProxyStatus {
  source: 'device' | 'environment' | 'system' | 'none';
  mode: 'proxy' | 'direct' | 'unavailable';
  bypassConfigured: boolean;
}

function value(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  // Normalize both spellings so native clients cannot disagree about precedence.
  return environment[name.toLowerCase()] ?? environment[name];
}
function proxyVariables(environment: NodeJS.ProcessEnv): Environment {
  return Object.fromEntries(proxyNames.flatMap(name => {
    const selected = value(environment, name);
    return typeof selected === 'string' && !selected.includes('\0') && Buffer.byteLength(selected) <= 16_384
      ? [[name, selected], [name.toLowerCase(), selected]] : [];
  }));
}
function hasRoute(environment: Environment) {
  return routeNames.some(name => value(environment, name) !== undefined);
}

/** Read only fixed OS proxy settings. PAC requires per-URL evaluation and is not guessed. */
export async function discoverProxyDefaults(environment: NodeJS.ProcessEnv = process.env): Promise<ProxyDefaults> {
  const inherited = proxyVariables(environment);
  if (process.platform !== 'darwin') return { inherited, system: {}, systemState: 'not_applicable' };
  try {
    const { stdout } = await execa('/usr/sbin/scutil', ['--proxy'], {
      cwd: '/', timeout: 2_000, maxBuffer: 65_536, extendEnv: false,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    });
    if (!stdout.startsWith('<dictionary> {')) throw new Error('system_proxy_unavailable');
    const fields = Object.fromEntries([...stdout.matchAll(/^  (\w+) : (.+)$/gmu)].map(match => [match[1]!, match[2]!]));
    if (fields.ProxyAutoConfigEnable === '1' || fields.ProxyAutoDiscoveryEnable === '1')
      return { inherited, system: {}, systemState: 'unsupported' };
    const system: Environment = {};
    for (const [kind, name, scheme] of [['HTTP', 'HTTP_PROXY', 'http'], ['HTTPS', 'HTTPS_PROXY', 'http'], ['SOCKS', 'ALL_PROXY', 'socks5h']] as const) {
      if (fields[`${kind}Enable`] !== '1') continue;
      const host = fields[`${kind}Proxy`], port = Number(fields[`${kind}Port`]);
      if (!host || /[\s/@?#]/u.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535
        || fields[`${kind}ProxyAuthenticated`] === '1') throw new Error('system_proxy_unavailable');
      system[name] = `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    }
    const exceptions = /ExceptionList : <array> \{([\s\S]*?)\n  \}/u.exec(stdout)?.[1] ?? '';
    const bypass = [...exceptions.matchAll(/^\s*\d+ : (.+)$/gmu)].map(match => match[1]!.replace(/^\*\./u, '.'));
    system.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '::1', ...bypass])].join(',');
    if (Buffer.byteLength(system.NO_PROXY) > 16_384) throw new Error('system_proxy_unavailable');
    return { inherited, system: proxyVariables(system), systemState: 'available' };
  } catch {
    // Errors can contain environment data; only a bounded state reaches diagnostics.
    return { inherited, system: {}, systemState: 'unavailable' };
  }
}

/** A route group comes from one source; NO_PROXY may be overridden independently. */
export function resolveProviderProxy(selected: Environment, defaults: ProxyDefaults) {
  const explicit = hasRoute(selected), inherited = hasRoute(defaults.inherited);
  const source: ProviderProxyStatus['source'] = explicit ? 'device' : inherited ? 'environment'
    : defaults.systemState === 'not_applicable' ? 'none' : 'system';
  const chosen = explicit ? selected : inherited ? defaults.inherited : defaults.system;
  const environment = proxyVariables(chosen);
  const bypass = value(selected, 'NO_PROXY') ?? value(defaults.inherited, 'NO_PROXY')
    ?? value(defaults.system, 'NO_PROXY') ?? 'localhost,127.0.0.1,::1';
  environment.NO_PROXY = bypass; environment.no_proxy = bypass;
  const unresolved = !explicit && !inherited && ['unsupported', 'unavailable'].includes(defaults.systemState);
  const status: ProviderProxyStatus = { source,
    mode: unresolved ? 'unavailable' : routeNames.some(name => Boolean(environment[name])) ? 'proxy' : 'direct',
    bypassConfigured: Boolean(bypass) };
  return { environment, status };
}
