import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform === 'darwin' && process.arch === 'arm64') {
  const sources = (await readdir('apps/device-panel/Sources')).filter(file => file.endsWith('.swift')).map(file => resolve('apps/device-panel/Sources', file));
  execFileSync('xcrun', ['swiftc', '-typecheck', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macosx13.0', ...sources], { stdio: 'inherit' });
  console.log('PASS native macOS panel typecheck');
  const local = resolve('.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(local, 'panel-model-check-'));
  try {
    const executable = join(temporary, 'panel-model-checks');
    const modelSources = ['DaemonBridge.swift', 'PanelModel.swift', 'PanelTheme.swift'].map(file => resolve('apps/device-panel/Sources', file));
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macosx13.0',
      ...modelSources, resolve('tests/panel-model.swift'), '-o', executable], { stdio: 'inherit' });
    execFileSync(executable, [temporary, process.execPath], { stdio: 'inherit' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else console.log('SKIP native panel typecheck: requires macOS arm64; device support is unchanged.');
