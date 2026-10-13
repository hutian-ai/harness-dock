#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeDevice, parseDevicePairing, readConfig } from './config.ts';
import { control } from './local-control.ts';

process.umask(0o077);
try {
  const { positionals: [command, argument], values } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, cwd: { type: 'string' }, endpoint: { type: 'string' },
    mode: { type: 'string' }, pairing: { type: 'string' }, 'node-id': { type: 'string' }, token: { type: 'string' }, 'ca-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, 'background-log': { type: 'boolean' },
  } });
  if (!command || values.help || command === 'help') {
    console.log('harness-dock-daemon init --cwd <directory> [--home .local/device] [--endpoint wss://controller.example/] [--pairing <device-pairing.json>]\nharness-dock-daemon <run|start|status|stop|logs> [config.json]\nDefault config: .local/device/config.json. start runs in the background; run stays in the foreground.');
  } else if (command === 'init') {
    if (!values.cwd) throw new Error('init requires --cwd');
    if (values.mode && values.mode !== 'device') throw new Error('unsupported_mode');
    {
      let pairing: { nodeId?: string; token?: string; endpoint?: string } = {};
      if (values.pairing) {
        if (values['node-id'] || values.token || values.endpoint) throw new Error('pairing_conflicts_with_identity_flags');
        const file = await stat(values.pairing);
        if (!file.isFile() || file.size > 16_384 || process.platform !== 'win32' && (file.mode & 0o077)) throw new Error('invalid_pairing_file_permissions');
        pairing = parseDevicePairing(JSON.parse(await readFile(values.pairing, 'utf8')));
      }
      console.log(JSON.stringify(await initializeDevice({ home: values.home ?? '.local/device', cwd: values.cwd, endpoint: pairing.endpoint ?? values.endpoint, nodeId: pairing.nodeId ?? values['node-id'], token: pairing.token ?? values.token, caFile: values['ca-file'] }), null, 2));
    }
  } else {
    if (!['run', 'start', 'status', 'stop', 'logs'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const path = resolve(argument ?? '.local/device/config.json');
    const config = await readConfig(path);
    if (command === 'run') {
      if (values['background-log']) {
        await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
        (await import('./rotating-log.ts')).installBackgroundLog(config.stateDir);
      }
      await (await import('./device-main.ts')).runDeviceDaemon(config);
    }
    else if (command === 'status' || command === 'stop') {
      const result = await control(config, command);
      console.log(JSON.stringify(result ?? { nodeId: config.nodeId, available: false }, null, 2));
    } else if (command === 'logs') {
      const file = await open(join(config.stateDir, 'daemon.log'), 'r');
      try {
        const { size } = await file.stat();
        const data = Buffer.alloc(Math.min(size, 32_768));
        await file.read(data, 0, data.length, Math.max(0, size - data.length));
        process.stdout.write(data);
      } finally { await file.close(); }
    } else {
      const existing = await control(config, 'status');
      if (existing) console.log(JSON.stringify({ ...existing, alreadyRunning: true }, null, 2));
      else {
        await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'run', path, '--background-log'], {
          detached: true, stdio: 'ignore',
        });
        let error: Error | undefined;
        child.on('error', value => { error = value; });
        child.unref();
        let ready = false;
        for (let i = 0; i < 50; i++) {
          if (error) throw error;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('Daemon exited during startup; inspect logs');
          const result = await control(config, 'status');
          if (result) { console.log(JSON.stringify(result, null, 2)); ready = true; break; }
          await delay(100);
        }
        if (!ready) throw new Error('Startup unconfirmed; query status and logs before retrying');
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
