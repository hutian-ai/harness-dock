import type { ProviderOverride } from '@harness-dock/drivers';

const baseVariables = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SYSTEMROOT']);
const discoveryVariables = new Set(['CODEX_HOME', 'CODEX_CLI_PATH', 'DSH_HOME', 'ZCODE_HOME', 'ZCODE_BIN']);

/** Dependency values are chosen in protected local config, never copied from the whole host. */
export const providerDependencyVariables = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
] as const;
const dependencyVariables = new Set<string>(providerDependencyVariables);

export function isProviderEnvironment(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => dependencyVariables.has(key)
      && typeof item === 'string' && !item.includes('\0') && Buffer.byteLength(item) <= 16_384));
}

/** Keep discovery selectors inside the daemon; adapters receive only their own selected home/bin. */
export function daemonEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    typeof value === 'string' && (baseVariables.has(key.toUpperCase()) || discoveryVariables.has(key))));
}

/** Resolve one Provider's dependencies without inheriting controller credentials or another Provider's choices. */
export function providerEnvironment(override?: ProviderOverride, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selected = override?.environment === undefined ? {} : override.environment;
  if (!isProviderEnvironment(selected)) throw new Error('invalid_provider_environment');
  const base = Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    typeof value === 'string' && baseVariables.has(key.toUpperCase())));
  return { ...base, ...selected };
}
