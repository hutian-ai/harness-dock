import { isAbsolute, join } from 'node:path';
import { runBoundedCommand } from './process-command.ts';
import { usableFile } from './installation-lookup.ts';

/** Query this user's registered package on every discovery, rather than retaining a versioned path. */
export async function windowsCodexApplications(environment: NodeJS.ProcessEnv, signal?: AbortSignal,
  query = runBoundedCommand): Promise<string[]> {
  const systemRoot = environment.SYSTEMROOT ?? environment.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return [];
  try {
    const result = await query(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress"],
      { env: environment, signal, timeoutMs: 10_000, maxOutputCharacters: 16_384 });
    if (result.exitCode !== 0) return [];
    const value: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''));
    const roots = Array.isArray(value) ? value : [value];
    const paths = roots.filter((root): root is string => typeof root === 'string' && isAbsolute(root))
      .map(root => join(root, 'app/resources/codex.exe'));
    return [...new Set((await Promise.all(paths.map(async file => await usableFile(file) ? file : null))).filter((file): file is string => file !== null))];
  } catch { signal?.throwIfAborted(); return []; }
}
