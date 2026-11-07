import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease, writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { createAppArchive } from './app-archive.ts';
import { buildPanelIcon } from './panel-icon.ts';
import { buildGpuiPanel } from './gpui-panel.ts';

process.umask(0o077);
const { values } = parseArgs({ options: { bundles: { type: 'string' }, output: { type: 'string' }, node: { type: 'string' }, 'node-license': { type: 'string' }, frontend: { type: 'string', default: 'swift' } } });
if (!['swift', 'gpui'].includes(values.frontend!)) throw new Error('invalid_panel_frontend');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('panel_build_requires_macos_arm64');
const output = resolve(values.output ?? `.local/device-panel-${Date.now()}`);
const bundles = resolve(values.bundles ?? join(output, 'build-bundles'));
// Reject an existing destination instead of replacing user files.
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
if (!values.bundles) execFileSync('pnpm', ['bundle', bundles], { stdio: 'inherit' });
const verified = await verifyRelease(join(bundles, 'daemon'));
// The desktop frontend and independently installed daemon have separate versions.
let appVersion = verified.manifest.version;
if (values.frontend === 'gpui') {
  const localCargo = join(homedir(), '.cargo/bin/cargo');
  const cargo = process.env.CARGO ?? await access(localCargo).then(() => localCargo, () => 'cargo');
  const manifest = resolve('apps/gpui-panel/Cargo.toml');
  const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', manifest], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  })) as { packages: { name: string; version: string; manifest_path: string }[] };
  const frontend = metadata.packages.find(pkg => pkg.name === 'harness-dock-panel' && pkg.manifest_path === manifest);
  if (!frontend) throw new Error('panel_frontend_version_missing');
  appVersion = frontend.version;
}
const bundleVersion = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(appVersion)?.[1];
if (!bundleVersion) throw new Error('invalid_panel_frontend_version');
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
for (const name of ['JiezhouMark.png', 'TrayTemplate.png']) {
  await copyFile(resolve('apps/device-panel/Resources', name), join(resources, name));
}
await cp(join(bundles, 'daemon'), join(resources, 'daemon'), { recursive: true, verbatimSymlinks: true });
await mkdir(join(resources, 'daemon/runtime'));
await copyFile(runtime, join(resources, 'daemon/runtime/node'));
await chmod(join(resources, 'daemon/runtime/node'), 0o755);
await copyFile(runtimeLicense, join(resources, 'daemon/runtime/LICENSE'));
await copyFile(resolve('LICENSE'), join(resources, 'LICENSE'));
await copyFile(resolve('apps/device-panel/Info.plist'), join(app, 'Contents/Info.plist'));
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${bundleVersion}`, join(app, 'Contents/Info.plist')]);
if (values.frontend === 'gpui') {
  const pages = JSON.parse(await readFile(resolve('apps/docs-site/src/content.json'), 'utf8')) as { slug: string; body: string }[];
  const guide = pages.find(page => page.slug === 'app')?.body ?? '';
  const start = guide.indexOf('<h3 id="preview-connect">');
  const end = guide.indexOf('<h2 id="first-connect">', start);
  if (start < 0 || end <= start) throw new Error('panel_connection_help_missing');
  const help = guide.slice(start, end)
    .replaceAll('%BASE%', 'https://hutian-ai.github.io/harness-dock/')
    .replaceAll('<h3', '<h2').replaceAll('</h3>', '</h2>');
  await writeFile(join(resources, 'ConnectionHelp.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>界舟 · 连接与日常使用</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{max-width:800px;margin:40px auto;padding:0 24px 48px;font:15px/1.75 system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}h1,h2{line-height:1.35;letter-spacing:-.02em}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:32px 0 12px}p,ol{margin:12px 0}li{margin:12px 0}a{color:LinkText;text-underline-offset:3px}.version{font-size:13px;opacity:.65}.table-wrap{overflow-x:auto;margin-top:16px}table{width:100%;min-width:540px;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid color-mix(in srgb,CanvasText 18%,transparent);padding:12px 10px}th{font-weight:600}strong{font-weight:600}
</style></head><body><h1>连接与日常使用</h1><p class="version">界舟 · Harness Dock ${appVersion} · 随应用提供的离线说明</p>${help}</body></html>\n`);
  await buildGpuiPanel(join(app, 'Contents/MacOS/HarnessDock'), resources);
  await chmod(join(app, 'Contents/MacOS/HarnessDock'), 0o755);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :LSMinimumSystemVersion 15.0', join(app, 'Contents/Info.plist')]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleVersion 7', join(app, 'Contents/Info.plist')]);
} else {
  const sources = (await readdir('apps/device-panel/Sources')).filter(file => file.endsWith('.swift')).map(file => resolve('apps/device-panel/Sources', file));
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0', '-module-name', 'HarnessDock',
    '-debug-prefix-map', `${process.cwd()}=.`, ...sources, '-o', join(app, 'Contents/MacOS/HarnessDock')], { stdio: 'inherit' });
}
// Runtime and notices are part of the same verified, independently installable daemon release.
await rm(join(resources, 'daemon/dock-release.json'));
await writeReleaseManifest(join(resources, 'daemon'), verified.manifest.revision);
await verifyRelease(join(resources, 'daemon'));
// Ad-hoc signing is for local verification only. Developer ID signing/notarization is a separate release step.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
await verifyRelease(join(resources, 'daemon'));
execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
const name = `harness-dock-panel-${values.frontend === 'gpui' ? 'gpui-' : ''}${appVersion}-darwin-arm64.zip`;
createAppArchive(app, join(output, name));
const hash = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${hash}  ${name}\n`);
if (values.frontend === 'gpui') {
  await writeFile(join(output, 'README.txt'), `界舟 · Harness Dock ${appVersion} — macOS 15+ arm64 · Developer Alpha
附带 Daemon：${verified.manifest.version}（桌面与后台独立版本）
接入说明：在邀请输入框下点击“如何获取？”，打开随包离线帮助；文件位于 Contents/Resources/ConnectionHelp.html。

将 Harness Dock.app 放入 ~/Applications，再双击打开。应用附带 Node 与 Daemon，无需 Git、pnpm 或自行构建。打开后读取原设备选择；替换 App 不会自动更新或停止现有后台。

侧栏保留“概览”、各本机 Harness 和“设置”。接入后的概览查看服务器连接、执行记录及各 Harness 已上报的 Token 用量；并发执行按独立编号区分，未确认结果不会计为完成。当前服务的启动、停止与移除操作放在服务器区域。详情展示安装信息、当前原生会话配置与模型目录（含本机覆盖），不更改原生设置。dsh 没有可查询的权限模式时显示“由原生 Harness 管理”，审批在任务发起方处理。设置调整外观和登录后自动连接；登录偏好仅影响下次登录，不启动、停止或重启当前服务。停止连接保留原接入信息；移除服务器会停止服务并关闭该连接的登录自启，保留旧身份与历史。

首次接入：向服务器管理员获取邀请链接或配对文件，在概览进入接入流程。粘贴邀请并点击“确认”，或点击“选择文件”；核对服务器与本机执行目录后确认接入。已有设备 config.json 不是服务器配对文件；上次接入中断时先核对原接入结果。接入完成后回到提供邀请的调用方应用，任务、进度、原生审批和结果都在那里处理。

原生 Codex 或 dsh 仍需在这台电脑上安装并登录，dsh 为实验适配。需要核验时进入 Harness 详情，手动执行可选的响应测试；测试使用模型额度，Codex 使用原生只读模式，dsh 沿用原生权限配置、不提供只读保证。安装、服务器连接与测试结果分别确认。缺少执行结果时只核对原记录，不自动重发。

连接诊断不发送模型任务。“日志位置”直接在 Finder 中定位本机日志文件。菜单栏使用 macOS 原生菜单，可打开主窗口、设置或退出界面。关闭窗口或退出界面不会停止独立运行的连接服务；需要暂停接收任务时，在概览明确停止连接。已有任务或结果待核对时，停止与移除由后台安全检查。

依赖许可证位于 Contents/Resources/rust-licenses。Developer Alpha 采用 ad-hoc 签名，尚未完成 Developer ID 签名与 Apple 公证。Windows 桌面未完成实机验收，不属于此包支持范围；旧 Swift v0.1.2 保留 macOS 13+ 下载。
`);
} else {
  await writeFile(join(output, 'README.txt'), `Harness Dock ${verified.manifest.version} — macOS arm64; Codex + experimental dsh adapter\nApp 使用指南：https://hutian-ai.github.io/harness-dock/app/\n\n` + '将 Harness Dock.app 放入 ~/Applications，再双击打开。\n应用附带 Node 与 Daemon，无需 Git、pnpm 或自行构建依赖。原生 Harness 仍由用户安装、登录和管理。本版包含 dsh 实验适配；面板是设备持有人的轻量接入、状态和维护入口：首页突出已检测到的Harness数量和安装列表，独立显示服务连接，不常驻展示任务统计，正常回到调用方应用。点击Harness条目查看安装信息、固定回显、诊断与原测试记录，按后台发现结果展示当前已支持的Codex/dsh并分别保留历史；数量只统计已发现安装，待确认不等于零，安装发现不代表模型就绪。界面使用与App图标同源的标识、中性按钮与小面积柔和绿色状态图标，并随系统切换浅深色外观。\n首次接入：打开服务管理员提供的邀请链接，点击“在 Harness Dock 中打开”，确认服务器后点击“连接这台 Mac”。也可在客户端粘贴邀请链接；旧 JSON 文件导入在高级设置。执行目录自动设置。\n已有设备：从自动检测到的连接中选择；旧源码设备可“使用此应用管理…”，保留设备身份、历史和原自启偏好。\n首次引导先连接这台Mac，环境核验不阻挡邀请接入。需要时点击首页Harness条目，在详情执行对应固定测试：Codex使用原生确认的只读模式；dsh沿用原生权限配置，不提供只读保证。测试使用模型额度，出现工具活动或额外审批不会判定通过；工具与应用授权分别验收。“诊断”仍只检查环境。任一测试运行或启动收据待确认时，可只读查看其他Harness详情，但原测试归属不变，不能另启测试或维护后台。详情保留单一返回入口。“设置与维护”是可返回首页的独立页面，收纳本地日志、版本信息、登录自启、停止、更新和回滚；自启需显式开启，维护由后台检查空闲与unknown执行。此应用自管的后台与随包版本不同时，点击“更新后台…”并确认“更新至此应用附带版本”。同版显示“后台与此应用附带版本一致。”，可更新时显示“已安装后台与此应用附带版本不同，可显式更新。”。版本提示仅比较清单元数据，不表示随包版本号更高；实际更新仍完整校验运行包。右上角收起按钮只隐藏弹层，保留菜单栏图标与App进程；“设置与维护”中的“退出 LaunchApp”结束App并移除菜单栏图标，Daemon继续运行。“停止后台”才通过后台拥有者检查空闲后停止后台。安装或维护写操作期间可收起，App与helper继续处理；真正退出被禁用，避免中断写操作。\nDeveloper Alpha：此产物仅有 ad-hoc 签名，未进行 Developer ID 签名或 Apple 公证。\n');
}
console.log(`Panel built: ${app}\nArchive: ${join(output, name)}\nLocal ad-hoc signing only; no publication or notarization was performed.`);
