import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const local = join(homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.env.CARGO ?? await access(local).then(() => local, () => 'cargo');
execFileSync(cargo, ['check', '--locked', '--manifest-path', resolve('apps/gpui-panel/Cargo.toml')], {
  stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: resolve(process.env.CARGO_TARGET_DIR ?? '.local/gpui-build') },
});
