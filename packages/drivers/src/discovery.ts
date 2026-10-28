import { homedir } from 'node:os';
import { discoverCodexInstallation } from './codex-environment.ts';

export type ProviderKey = 'codex';
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
}
/** Discover Codex without reading credentials, opening login, or sending model prompts. */
export async function discoverProviders(options: ProviderDiscoveryOptions = {}): Promise<DiscoveredProvider[]> {
  options.signal?.throwIfAborted();
  return [await discoverCodexInstallation({
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir(),
    override: options.overrides?.codex,
    signal: options.signal,
  })];
}
