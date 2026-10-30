import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform === 'darwin' && process.arch === 'arm64') {
  const sources = (await readdir('apps/device-panel/Sources')).filter(file => file.endsWith('.swift')).map(file => resolve('apps/device-panel/Sources', file));
  execFileSync('xcrun', ['swiftc', '-typecheck', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macosx13.0', ...sources], { stdio: 'inherit' });
  console.log('PASS native macOS panel typecheck');
} else console.log('SKIP native panel typecheck: requires macOS arm64; device support is unchanged.');
