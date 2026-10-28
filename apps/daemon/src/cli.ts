#!/usr/bin/env node
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { initializeDevice, parseDevicePairing, readConfig } from './config.ts';
import { control } from './local-control.ts';

process.umask(0o077);
try {
  const { positionals: [command, argument], values } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, cwd: { type: 'string' }, endpoint: { type: 'string' },
    mode: { type: 'string' }, pairing: { type: 'string' }, 'node-id': { type: 'string' }, token: { type: 'string' }, 'ca-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, 'background-log': { type: 'boolean' },
    bundle: { type: 'string' }, 'install-dir': { type: 'string' }, node: { type: 'string' }, disable: { type: 'boolean' },
    version: { type: 'boolean' }, json: { type: 'boolean' }, autostart: { type: 'boolean' },
  } });
  if (values.version) console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (!command || values.help || command === 'help') {
    console.log('harness-dock-daemon init --cwd <directory> [--home .local/device] [--endpoint wss://controller.example/] [--pairing <device-pairing.json>]\nharness-dock-daemon <run|start|status|stop|logs> [config.json]\nharness-dock-daemon <install|upgrade> [config.json] --bundle <daemon-bundle> [--node <node>] [--install-dir <directory>]\nharness-dock-daemon rollback [config.json] [--install-dir <directory>]\nharness-dock-daemon autostart [config.json] [--disable] [--install-dir <directory>]\nDefault config: .local/device/config.json. start runs in the background; run stays in the foreground.\nManaged installs keep releases separate from device state. autostart enables a macOS user LaunchAgent and starts it; --disable stops and unregisters it.');
    console.log('harness-dock-daemon setup --cwd <directory> --home <private-directory> --pairing <device-pairing.json> --bundle <daemon-bundle> [--autostart]\nharness-dock-daemon doctor [config.json] [--json]\nharness-dock-daemon --version\nsetup installs and starts this device only; --autostart explicitly enables login startup. doctor sends no model prompt.');
  } else if (command === 'doctor') {
    await (await import('./doctor.ts')).deviceDoctor(resolve(argument ?? process.env.HARNESS_DOCK_INSTALLED_CONFIG ?? '.local/device/config.json'), values.json);
  } else if (command === 'init' || command === 'setup') {
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
      const options = { home: values.home ?? '.local/device', cwd: values.cwd, endpoint: pairing.endpoint ?? values.endpoint, nodeId: pairing.nodeId ?? values['node-id'], token: pairing.token ?? values.token, caFile: values['ca-file'] };
      if (command === 'init') console.log(JSON.stringify(await initializeDevice(options), null, 2));
      else {
        if (!values.pairing || !values.bundle) throw new Error('setup requires --pairing and --bundle');
        const path = resolve(options.home, 'config.json');
        try {
          const existing = await readConfig(path);
          if (existing.nodeId !== pairing.nodeId || existing.token !== pairing.token || existing.endpoint !== pairing.endpoint || existing.cwd !== resolve(values.cwd))
            throw new Error('setup_identity_conflict: existing device was preserved; use its installed entrypoint');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await initializeDevice(options);
        }
        const { installationRoot, readInstallation, manageInstallation, startInstalled } = await import('./installation.ts');
        const root = installationRoot(path, values['install-dir']);
        if (!await readInstallation(root, path)) await manageInstallation('install', { config: path, root, bundle: values.bundle, runtime: values.node });
        const result = values.autostart ? await manageInstallation('autostart', { config: path, root }) : await startInstalled(path, root);
        console.log(JSON.stringify({ configPath: path, installation: root, result, next: 'Run the installed doctor command. Connected is not model execution verification.' }, null, 2));
      }
    }
  } else {
    if (!['run', 'start', 'status', 'stop', 'logs', 'install', 'upgrade', 'rollback', 'autostart'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const path = resolve(argument ?? process.env.HARNESS_DOCK_INSTALLED_CONFIG ?? '.local/device/config.json');
    const { installationRoot, manageInstallation, readInstallation, startInstalled } = await import('./installation.ts');
    const { startBackground } = await import('./process-management.ts');
    const root = installationRoot(path, values['install-dir'] ?? process.env.HARNESS_DOCK_INSTALL_DIR);
    const config = await readConfig(path);
    if (command === 'install' || command === 'upgrade' || command === 'rollback' || command === 'autostart') {
      console.log(JSON.stringify(await manageInstallation(command, { config: path, root, bundle: values.bundle, runtime: values.node, disable: values.disable }), null, 2));
    } else if (command === 'run') {
      if (values['background-log']) {
        await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
        (await import('./rotating-log.ts')).installBackgroundLog(config.stateDir);
      }
      await (await import('./device-main.ts')).runDeviceDaemon(config);
    }
    else if (command === 'status' || command === 'stop') {
      const result = await control(config, command);
      const installation = command === 'status' ? await readInstallation(root, path) : undefined;
      console.log(JSON.stringify({ ...(result ?? { nodeId: config.nodeId, available: false }),
        ...(installation ? { installation: { root, current: installation.current, previous: installation.previous, autostart: installation.autostart } } : {}) }, null, 2));
    } else if (command === 'logs') {
      const file = await open(join(config.stateDir, 'daemon.log'), 'r');
      try {
        const { size } = await file.stat();
        const data = Buffer.alloc(Math.min(size, 32_768));
        await file.read(data, 0, data.length, Math.max(0, size - data.length));
        process.stdout.write(data);
      } finally { await file.close(); }
    } else {
      const result = await startInstalled(path, root) ?? await startBackground(config, path, fileURLToPath(import.meta.url), process.execPath, process.execArgv);
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
