import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceConfig } from './config.ts';
import { control, type LocalStatus } from './local-control.ts';

export async function waitForDaemon(config: DeviceConfig, entrypoint?: string, runtime?: string, check?: () => void): Promise<LocalStatus> {
  for (let i = 0; i < 100; i++) {
    check?.();
    const result = await control(config, 'status');
    if (result) {
      if (entrypoint && result.entrypoint !== entrypoint || runtime && result.runtime !== runtime) throw new Error('unexpected_daemon_owner');
      return result;
    }
    await delay(100);
  }
  throw new Error('Startup unconfirmed; query status and logs before retrying');
}

export async function stopIdleDaemon(config: DeviceConfig): Promise<boolean> {
  if (!await control(config, 'status')) {
    const path = join(config.stateDir, 'runs.sqlite');
    if (existsSync(path)) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        if (database.prepare('SELECT id FROM node').get()?.id !== config.nodeId) throw new Error('state_node_mismatch');
        if (database.prepare("SELECT 1 FROM device_executions WHERE json_extract(value,'$.state') IN ('running','unknown') LIMIT 1").get()) throw new Error('unresolved_execution');
      } finally { database.close(); }
    }
    return false;
  }
  // The live owner checks busy/unknown and closes admission in the same operation.
  if (!await control(config, 'stop-idle')) throw new Error('maintenance_stop_unconfirmed');
  for (let i = 0; i < 50; i++) {
    if (!await control(config, 'status')) return true;
    await delay(100);
  }
  throw new Error('maintenance_stop_unconfirmed');
}

export async function startBackground(config: DeviceConfig, path: string, entrypoint: string, runtime = process.execPath, execArgv: string[] = []): Promise<LocalStatus> {
  const existing = await control(config, 'status');
  if (existing) return { ...existing, alreadyRunning: true } as LocalStatus;
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  // The launcher can be a temporary checkout; background commands need a lasting cwd.
  const child = spawn(runtime, [...execArgv, entrypoint, 'run', path, '--background-log'], { cwd: dirname(entrypoint), detached: true, stdio: 'ignore' });
  let error: Error | undefined;
  child.on('error', value => { error = value; });
  child.unref();
  return waitForDaemon(config, entrypoint.endsWith('.js') ? entrypoint : undefined, runtime, () => {
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Daemon exited during startup; inspect logs');
  });
}
