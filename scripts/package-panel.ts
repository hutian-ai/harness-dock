import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease, writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { createAppArchive } from './app-archive.ts';
import { buildPanelIcon } from './panel-icon.ts';

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
await buildPanelIcon(join(resources, 'AppIcon.icns'));
await copyFile(resolve('apps/device-panel/Resources/HutianLogo.png'), join(resources, 'HutianLogo.png'));
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
await writeFile(join(output, 'README.txt'), 'Harness Dock — macOS arm64; Codex + experimental dsh SDK adapter\n\n将 Harness Dock.app 放入 ~/Applications，再双击打开。\n应用附带 Node 与 Daemon，无需 Git、pnpm 或自行构建依赖。原生 Harness 仍由用户安装、登录和管理。新构建候选包含 dsh 实验适配；面板是设备持有人的轻量接入、状态和维护入口：首页突出已检测到的Harness数量和安装列表，独立显示服务连接，不常驻展示任务统计，正常回到调用方应用。点击Harness条目查看安装信息、固定回显、诊断与原测试记录，按后台发现结果展示当前已支持的Codex/dsh并分别保留历史；数量只统计已发现安装，待确认不等于零，安装发现不代表模型就绪。候选使用与App图标同源的标识、中性按钮与小面积柔和绿色状态图标，并随系统切换浅深色外观。\n首次接入：打开服务管理员提供的邀请链接，点击“在 Harness Dock 中打开”，确认服务器后点击“连接这台 Mac”。也可在客户端粘贴邀请链接；旧 JSON 文件导入在高级设置。执行目录自动设置。\n已有设备：从自动检测到的连接中选择；旧源码设备可“使用此应用管理…”，保留设备身份、历史和原自启偏好。\n首次引导先连接这台Mac，环境核验不阻挡邀请接入。需要时点击首页Harness条目，在详情执行对应固定测试：Codex使用原生确认的只读模式；dsh沿用原生权限配置，不提供只读保证。测试使用模型额度，出现工具活动或额外审批不会判定通过；工具与应用授权分别验收。“诊断”仍只检查环境。任一测试运行或启动收据待确认时，可只读查看其他Harness详情，但原测试归属不变，不能另启测试或维护后台。详情保留单一返回入口。“设置与维护”是可返回首页的独立页面，收纳本地日志、版本信息、登录自启、停止、更新和回滚；自启需显式开启，维护由后台检查空闲与unknown执行。此应用自管的后台与随包版本不同时，点击“更新后台…”并确认“更新至此应用附带版本”。同版显示“后台与此应用附带版本一致。”，可更新时显示“已安装后台与此应用附带版本不同，可显式更新。”。版本提示仅比较清单元数据，不表示随包版本号更高；实际更新仍完整校验运行包。右上角收起按钮只隐藏弹层，保留菜单栏图标与App进程；“设置与维护”中的“退出 LaunchApp”结束App并移除菜单栏图标，Daemon继续运行。“停止后台”才通过后台拥有者检查空闲后停止后台。安装或维护写操作期间可收起，App与helper继续处理；真正退出被禁用，避免中断写操作。\nDeveloper Alpha：此产物仅有 ad-hoc 签名，未进行 Developer ID 签名或 Apple 公证。\n');
console.log(`Panel built: ${app}\nArchive: ${join(output, name)}\nLocal ad-hoc signing only; no publication or notarization was performed.`);
