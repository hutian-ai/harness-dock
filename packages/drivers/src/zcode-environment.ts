import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DiscoveredProvider, ProviderOverride } from "./discovery.ts";
/** Discovery only; the native account is checked by the separate ACP probe. */
export async function discoverZcodeInstallation(options: {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  override?: ProviderOverride;
  signal?: AbortSignal;
}): Promise<DiscoveredProvider> {
  options.signal?.throwIfAborted();
  const home = resolve(
    options.override?.home ??
      options.environment.ZCODE_HOME ??
      join(options.homeDirectory, ".zcode"),
  );
  const descriptor: DiscoveredProvider = {
    key: "zcode",
    displayName: "ZCode",
    status: "not_found",
    executable: null,
    home,
    version: null,
    source: null,
    candidates: [],
  };
  if (options.override?.disabled) return { ...descriptor, status: "disabled" };
  const executable =
    options.override?.executable ??
    (process.platform === "darwin"
      ? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
      : undefined);
  if (!executable)
    return { ...descriptor, reason: "zcode_installation_not_configured" };
  const path = resolve(executable);
  if (!(await stat(path).catch(() => null))?.isFile())
    return {
      ...descriptor,
      candidates: [path],
      reason: "zcode_installation_not_found",
    };
  return {
    ...descriptor,
    status: "installed",
    executable: await realpath(path),
    source: options.override?.executable ? "configured" : "app",
    candidates: [path],
  };
}
