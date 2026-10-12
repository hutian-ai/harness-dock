import { readFile, stat } from 'node:fs/promises';
import { CodexExecutor, ContainerHarness, createCodexRuntime, ZCodeExecutor } from '@harness-dock/drivers';
import { Engine } from './engine.ts';
import { DaemonConnection } from './connection.ts';
import type { ProviderNodeConfig } from './config.ts';
import { serveControl } from './local-control.ts';

export async function runDaemon(config: ProviderNodeConfig): Promise<void> {
  if (!(await stat(config.cwd)).isDirectory()) throw new Error('Working directory must be a directory');
  // The agent receives this fixed, small environment plus ACPX's explicit overlay.
  const permitted = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SYSTEMROOT']);
  for (const key of Object.keys(process.env)) if (!permitted.has(key)) delete process.env[key];
  const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined;
  const container = config.provider !== 'zcode' && config.container ? new ContainerHarness(config.container, config.nodeId, config.cwd, config.codexHome, config.stateDir) : undefined;
  const driver = config.provider === 'zcode' ? new ZCodeExecutor(config)
    : new CodexExecutor({ ...config, sandbox: 'workspace-write' }, options => createCodexRuntime(options, container?.command));
  const engine = new Engine(driver, { nodeId: config.nodeId, stateDir: config.stateDir });
  const connection = new DaemonConnection(engine, config.endpoint, config.token, { ca });
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    connection.stop();
    try { await engine.shutdown(); } finally { await container?.cleanup(); }
  })();
  let closeControl: (() => Promise<void>) | undefined;
  try {
    await container?.cleanup();
    closeControl = await serveControl(config, () => ({
      nodeId: config.nodeId, daemonId: engine.daemonId, pid: process.pid,
      connected: connection.connected, endpoint: config.endpoint,
    }), stop);
    connection.connect();
  } catch (error) {
    await stop().catch(() => {});
    await closeControl?.();
    throw error;
  }
  console.log(`Daemon ${engine.daemonId} connecting to ${config.endpoint}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void stop().then(() => closeControl?.()).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
