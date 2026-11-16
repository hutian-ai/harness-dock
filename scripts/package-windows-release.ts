import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease } from '../apps/daemon/src/release-manifest.ts';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('windows_release_requires_windows_x64');
const { values } = parseArgs({ options: { panel: { type: 'string' }, output: { type: 'string' },
  tag: { type: 'string' }, iscc: { type: 'string' } } });
assert.ok(values.panel && values.output && values.tag && values.iscc, 'panel_output_tag_and_iscc_required');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(values.tag, /^v\d+\.\d+\.\d+-windows\.[1-9]\d*$/u);
assert.equal(values.tag.split('-windows.')[0], `v${pkg.version}`);
assert.equal(pkg.private, true);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'release_source_must_be_clean');
const panel = resolve(values.panel), output = resolve(values.output);
const verified = await verifyRelease(join(panel, 'resources/daemon'));
assert.equal(verified.manifest.revision, revision);
assert.equal(verified.manifest.version, pkg.version);
const desktop = JSON.parse(execFileSync(process.env.CARGO ?? 'cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1',
  '--manifest-path', 'apps/gpui-panel/Cargo.toml'], { encoding: 'utf8' }));
assert.equal(desktop.packages.find((p: { name: string }) => p.name === 'harness-dock-panel').version, pkg.version);
await mkdir(output); // Never overlay an existing release or active application.
const payload = join(output, 'payload');
await mkdir(payload);
for (const name of ['HarnessDock.exe', 'resources', 'README.txt']) await cp(join(panel, name), join(payload, name), { recursive: true });
const helpPath = join(payload, 'resources/ConnectionHelp.html');
await writeFile(helpPath, (await readFile(helpPath, 'utf8')).replace('Windows 本地候选', 'Windows Developer Alpha'));
const readme = (await readFile(join(payload, 'README.txt'), 'utf8'))
  .replace('Windows x64 本地候选', 'Windows 11 x64 · Developer Alpha')
  .replace('本地候选未经代码签名，不自动安装或发布。', '本版尚未进行 Windows 代码签名。请按组织的软件安装政策处理系统提示。');
await writeFile(join(payload, 'README.txt'), readme + '\n安装程序按当前用户安装，添加开始菜单入口并提供卸载；ZIP 解压后可直接使用。\n运行库：https://aka.ms/vc14/vc_redist.x64.exe\n更新或卸载前先退出界面；若后台直接运行于应用目录，只能在没有活动或待核对任务时从概览停止。不会强制结束进程，卸载保留外部设备配置、身份与历史。\n');
const metadata = { version: pkg.version, tag: values.tag, revision, frontend: 'gpui', platform: 'win32', arch: 'x64',
  minimumWindows: '11', signature: 'unsigned',
  source: `https://github.com/hutian-ai/harness-dock/tree/${revision}`,
  ...(process.env.GITHUB_RUN_ID ? { build: `https://github.com/hutian-ai/harness-dock/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}) };
await writeFile(join(payload, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
const stem = `harness-dock-panel-gpui-${values.tag.slice(1)}-windows-x64`;
execFileSync(values.iscc, [`/DPayloadDir=${payload}`, `/DPackageVersion=${pkg.version}`,
  `/DOutputDir=${output}`, `/DArtifactName=${stem}-setup`, resolve('scripts/windows-installer.iss')], { stdio: 'inherit' });
execFileSync('tar.exe', ['-a', '-cf', join(output, `${stem}.zip`), '-C', payload,
  'HarnessDock.exe', 'resources', 'README.txt', 'release.json'], { stdio: 'inherit' });
for (const name of ['README.txt', 'release.json']) await cp(join(payload, name), join(output, name));
const hashes = [];
for (const name of [`${stem}-setup.exe`, `${stem}.zip`, 'README.txt', 'release.json']) {
  const hash = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  hashes.push(`${hash}  ${name}`);
}
await writeFile(join(output, 'SHA256SUMS'), hashes.join('\n') + '\n');
console.log(`Windows installer and portable archive ready: ${output}`);
