import { homedir } from 'node:os';
import { discoverCodexInstallation } from './codex-environment.ts';
import { discoverDshInstallation } from './dsh-environment.ts';

const providerDiscovery = {
  codex: discoverCodexInstallation,
  dsh: discoverDshInstallation,
};
export type ProviderKey = keyof typeof providerDiscovery;
export const providerKeys = Object.freeze(Object.keys(providerDiscovery) as ProviderKey[]);
export interface ProviderOverride {
  executable?: string;
  home?: string;
  disabled?: boolean;
  /** Local-owner-selected proxy/certificate dependencies; never remote execution input. */
  environment?: Record<string, string>;
}
export interface ProviderDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  overrides?: Partial<Record<ProviderKey, ProviderOverride>>;
  signal?: AbortSignal;
}
export interface DiscoveredProvider {
  key: ProviderKey;
  displayName: string;
  /** Installation evidence only; authentication and protocol readiness require a separate probe. */
  status: 'installed' | 'not_found' | 'disabled';
  executable: string | null;
  home: string | null;
  version: string | null;
  source: 'bundled' | 'managed' | 'path' | 'app' | 'configured' | null;
  candidates: string[];
  reason?: string;
  /** Verified local desktop host discovery only; not a persistent ACP/model connection. */
  desktopHost?: 'available' | 'unavailable' | 'not_applicable';
}
/** Discover named installations without reading credentials, opening login, or sending model prompts. */
export async function discoverProviders(options: ProviderDiscoveryOptions = {}): Promise<DiscoveredProvider[]> {
  options.signal?.throwIfAborted();
  const providers: DiscoveredProvider[] = [];
  for (const key of providerKeys) {
    providers.push(await providerDiscovery[key]({
      environment: options.environment ?? process.env,
      homeDirectory: options.homeDirectory ?? homedir(),
      override: options.overrides?.[key],
      signal: options.signal,
    }));
  }
  return providers;
}
