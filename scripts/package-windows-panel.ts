import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execaSync } from 'execa';
import { verifyRelease, writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { writeBundleNotices } from './bundle-notices.ts';
import { buildGpuiPanel } from './gpui-panel.ts';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('windows_panel_requires_windows_x64');
const { values } = parseArgs({ options: { output: { type: 'string' }, node: { type: 'string' },
  'node-license': { type: 'string' }, debug: { type: 'boolean' } } });
const output = resolve(values.output ?? '.local/windows-panel');
// Existing output is never removed or overlaid, especially if its daemon is running.
await mkdir(output);
const resources = join(output, 'resources'), daemon = join(resources, 'daemon');
await mkdir(resources);
const runtime = resolve(values.node ?? process.execPath);
const info = JSON.parse(execFileSync(runtime, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})'], { encoding: 'utf8' }));
const [major, minor] = String(info.version).split('.').map(Number);
if (info.platform !== 'win32' || info.arch !== 'x64' || major! < 24 || major === 24 && minor! < 9) throw new Error('invalid_panel_runtime');
const license = resolve(values['node-license'] ?? join(dirname(runtime), 'LICENSE'));
if (!(await lstat(license)).isFile()) throw new Error('node_license_required');

execaSync('pnpm', ['--filter', '@harness-dock/daemon', 'deploy', '--prod', '--config.node-linker=hoisted',
  ...(values.debug ? ['--offline', '--no-optional'] : []), daemon], { stdio: 'inherit' });
async function detach(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await detach(file);
    else if (entry.isFile() && (await lstat(file)).nlink > 1) {
      const temporary = `${file}.dock-copy-${process.pid}`;
      await copyFile(file, temporary, constants.COPYFILE_EXCL);
      await rename(temporary, file);
    }
  }
}
await detach(daemon);
const manifest = JSON.parse(await readFile(join(daemon, 'package.json'), 'utf8'));
for (const name of Object.keys(manifest.dependencies))
  manifest.dependencies[name] = JSON.parse(await readFile(join(daemon, 'node_modules', name, 'package.json'), 'utf8')).version;
manifest.bundledDependencies = Object.keys(manifest.dependencies);
delete manifest.scripts;
await writeFile(join(daemon, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm/lock.yaml'])
  await rm(join(daemon, file), { force: true });
await rmdir(join(daemon, 'node_modules/.pnpm'));
await mkdir(join(daemon, 'patches'));
for (const file of ['acpx@0.21.1.patch', '@agentclientprotocol__codex-acp@2.3.0.patch', '@openclaw__fs-safe@0.26.13.patch', 'README.md'])
  await copyFile(resolve('patches', file), join(daemon, 'patches', file));
await writeBundleNotices(daemon);
await mkdir(join(daemon, 'runtime'));
await copyFile(runtime, join(daemon, 'runtime/node.exe'));
await copyFile(license, join(daemon, 'runtime/LICENSE'));
await copyFile(resolve('LICENSE'), join(resources, 'LICENSE'));
let revision: string | undefined;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) revision += '+dirty';
} catch { /* Source archives do not include Git metadata. */ }
await writeReleaseManifest(daemon, revision);
await verifyRelease(daemon);
const cargo = process.env.CARGO ?? 'cargo';
const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve('apps/gpui-panel/Cargo.toml')], { encoding: 'utf8' }));
const version = metadata.packages.find((pkg: { name: string }) => pkg.name === 'harness-dock-panel')?.version;
if (typeof version !== 'string') throw new Error('panel_frontend_version_missing');
const pages = JSON.parse(await readFile('apps/docs-site/src/content.json', 'utf8')) as { slug: string; body: string }[];
const guide = pages.find(page => page.slug === 'app')?.body ?? '';
const start = guide.indexOf('<h3 id="preview-connect">'), end = guide.indexOf('<h2 id="first-connect">', start);
if (start < 0 || end <= start) throw new Error('panel_connection_help_missing');
const help = guide.slice(start, end).replaceAll('%BASE%', 'https://hutian-ai.github.io/harness-dock/');
await writeFile(join(resources, 'ConnectionHelp.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>界舟 · 连接与日常使用</title><style>:root{color-scheme:light dark}body{max-width:800px;margin:40px auto;padding:0 24px;font:15px/1.75 system-ui;background:Canvas;color:CanvasText}table{border-collapse:collapse}td,th{padding:8px;border:1px solid GrayText}a{color:LinkText}</style><h1>连接与日常使用</h1><p>Harness Dock ${version} · Windows 本地候选</p>${help}</html>`);
await buildGpuiPanel(join(output, 'HarnessDock.exe'), resources, { debug: values.debug });
await cp(resolve('apps/device-panel/Resources/JiezhouMark.png'), join(resources, 'JiezhouMark.png'));
await writeFile(join(output, 'README.txt'), `界舟 · Harness Dock ${version} — Windows x64 本地候选\n\n双击 HarnessDock.exe，在概览粘贴设备邀请或选择服务器配对文件，核对服务器和本机执行目录后连接。\n请保持 resources 与程序在同一目录；需要 Microsoft Visual C++ x64 运行库。\n运行时与后台随包提供，原生 Codex/dsh 仍需自行安装和配置。关闭窗口或退出界面保留独立后台；停止连接在概览中操作。\n登录自启、链接协议注册和单实例激活尚未提供。依赖许可位于 resources，离线帮助为 resources/ConnectionHelp.html。\n本地候选未经代码签名，不自动安装或发布。\n`);
const sha256 = createHash('sha256').update(await readFile(join(output, 'HarnessDock.exe'))).digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${sha256}  HarnessDock.exe\n`);
console.log(`Windows client ready: ${output}`);
