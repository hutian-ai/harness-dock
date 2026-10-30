import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease, writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { createAppArchive } from './app-archive.ts';

process.umask(0o077);
const { values } = parseArgs({ options: { bundles: { type: 'string' }, output: { type: 'string' }, node: { type: 'string' }, 'node-license': { type: 'string' } } });
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('panel_build_requires_macos_arm64');
const output = resolve(values.output ?? `.local/device-panel-${Date.now()}`);
const bundles = resolve(values.bundles ?? join(output, 'build-bundles'));
// Reject an existing destination instead of replacing user files.
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
if (!values.bundles) execFileSync('pnpm', ['bundle', bundles], { stdio: 'inherit' });
const verified = await verifyRelease(join(bundles, 'daemon'));
const runtime = await realpath(values.node ?? process.execPath);
const nodeInfo = JSON.parse(execFileSync(runtime, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { encoding: 'utf8' }));
const [major, minor] = nodeInfo.version.split('.').map(Number);
if (nodeInfo.platform !== 'darwin' || nodeInfo.arch !== 'arm64' || major < 22 || major === 22 && minor < 19) throw new Error('invalid_panel_runtime');
// Homebrew runtimes can depend on mutable external dylibs. Only self-contained runtimes may ship.
const libraries = execFileSync('/usr/bin/otool', ['-L', runtime], { encoding: 'utf8' }).trim().split('\n').slice(1).map(line => line.trim().split(' ')[0]!);
if (libraries.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) throw new Error('panel_runtime_has_external_libraries');
const runtimeLicense = resolve(values['node-license'] ?? join(dirname(dirname(runtime)), 'LICENSE'));
if (!(await lstat(runtimeLicense)).isFile()) throw new Error('node_license_required');
const app = join(output, 'Harness Dock.app'), resources = join(app, 'Contents/Resources');
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resources);
await cp(join(bundles, 'daemon'), join(resources, 'daemon'), { recursive: true, verbatimSymlinks: true });
await mkdir(join(resources, 'daemon/runtime'));
await copyFile(runtime, join(resources, 'daemon/runtime/node'));
await chmod(join(resources, 'daemon/runtime/node'), 0o755);
await copyFile(runtimeLicense, join(resources, 'daemon/runtime/LICENSE'));
await copyFile(resolve('LICENSE'), join(resources, 'LICENSE'));
await copyFile(resolve('apps/device-panel/Info.plist'), join(app, 'Contents/Info.plist'));
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${verified.manifest.version}`, join(app, 'Contents/Info.plist')]);
const sources = (await readdir('apps/device-panel/Sources')).filter(file => file.endsWith('.swift')).map(file => resolve('apps/device-panel/Sources', file));
execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0', '-module-name', 'HarnessDock',
  '-debug-prefix-map', `${process.cwd()}=.`, ...sources, '-o', join(app, 'Contents/MacOS/HarnessDock')], { stdio: 'inherit' });
// Runtime and notices are part of the same verified, independently installable daemon release.
await rm(join(resources, 'daemon/dock-release.json'));
await writeReleaseManifest(join(resources, 'daemon'), verified.manifest.revision);
await verifyRelease(join(resources, 'daemon'));
// Ad-hoc signing is for local verification only. Developer ID signing/notarization is a separate release step.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
await verifyRelease(join(resources, 'daemon'));
execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
const name = `harness-dock-panel-${verified.manifest.version}-darwin-arm64.zip`;
createAppArchive(app, join(output, name));
const hash = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${hash}  ${name}\n`);
await writeFile(join(output, 'README.txt'), 'Harness Dock — macOS arm64 + Codex\n\n将 Harness Dock.app 放入 ~/Applications，再双击打开。\n应用附带 Node 与 Daemon，无需 Git、pnpm 或自行构建依赖。\n首次接入：打开服务管理员提供的邀请链接，点击“在 Harness Dock 中打开”，确认服务器后点击“连接这台 Mac”。也可在客户端粘贴邀请链接；旧 JSON 文件导入在高级设置。执行目录自动设置。\n已有设备：从自动检测到的连接中选择；旧源码设备可“使用此应用管理…”，保留设备身份、历史和原自启偏好。\n连接后直接点击“测试 Codex”：后台实际执行一次只读模型回显，面板显示通过、失败或结果待核对；会使用一次模型请求的额度，无需终端或应用凭据。“诊断”仍只检查环境。自启需显式开启，停止设备在维护区；退出面板不会停止 Daemon。\nDeveloper Alpha：此产物仅有 ad-hoc 签名，未进行 Developer ID 签名或 Apple 公证。\n');
console.log(`Panel built: ${app}\nArchive: ${join(output, name)}\nLocal ad-hoc signing only; no publication or notarization was performed.`);
