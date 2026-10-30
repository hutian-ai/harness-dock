# harness-dock 文档站

产品文档站是使用者的完整指南，README 提供快速入口。默认快速开始面向设备用户：取得 App → 安装 → 邀请接入这台 Mac → 确认状态并回到调用方应用。原生环境在实际执行前准备，固定回显按需进行；源码与新构建候选把环境检查收进“检查本机环境”，不阻挡邀请接入。SDK 开发与服务端部署各有独立入口，命令行只出现在开发者/管理员章节。当前公开下载面向 **0.1.0 Developer Alpha**，入口仍指向 [v0.1.0 Release](https://github.com/hutian-ai/harness-dock/releases/tag/v0.1.0) 的 macOS arm64 ZIP，不代表新候选已发布。

位于 harness-dock 仓库的 `apps/docs-site/`，使用 Node.js 静态生成，无第三方运行时依赖。中性黑白底、绿色强调、两层导航、图标侧栏和三栏阅读布局。

只使用客户端的用户请阅读站点“快速开始”和“安装执行设备”，通过 [Release 下载客户端](https://github.com/hutian-ai/harness-dock/releases/download/v0.1.0/harness-dock-panel-0.1.0-darwin-arm64.zip)；不需要运行下面的文档预览命令。客户端仅完成本地 ad-hoc 签名，尚未完成 Developer ID 签名与公证。

## 维护者：本地预览

从 `apps/docs-site/` 目录执行，需要 Node.js 22+，无需 npm install：

```sh
npm run build
npm run check
npm run preview
```

打开 http://localhost:4173。也可以从仓库根目录执行 `node apps/docs-site/build.mjs`、`node apps/docs-site/check.mjs`、`node apps/docs-site/serve.mjs`。生产产物在 `apps/docs-site/dist/`。

## GitHub Pages

仓库根目录的 `.github/workflows/docs-pages.yml` 会在 main 上的文档变更、相关 PR 或手动触发时构建并检查文档。Pages 部署使用单独的 job，仅上传文档站静态文件，不上传产品源码、.local、运行配置或依赖。

首次启用：

1. 确认仓库当前可见性与账户套餐允许使用 GitHub Pages。
2. Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
3. Settings → Secrets and variables → Actions → Variables 添加 `DOCS_PAGES_ENABLED`，值为 `true`。
4. 在 main 推送文档更新，或在 Actions 手动运行 Docs Pages。

部署仅在变量开启且来源为 main 时执行；未开启时只构建检查。默认站点路径为 https://hutian-ai.github.io/harness-dock/，是否已部署及实际入口以 Actions 输出为准。

## 其他托管

- 静态托管：构建后上传 dist/ 的全部内容。
- Netlify / Vercel：项目根目录选择 apps/docs-site，使用附带配置。
- Cloudflare Pages：根目录 apps/docs-site；构建 npm run build；发布 dist；Node 22。
- Docker：在 apps/docs-site 中运行 `docker build -t harness-dock-docs .`，然后 `docker run --rm -p 8080:80 harness-dock-docs`。

每页都是独立 HTML，导航、资源和搜索使用相对路径，支持仓库子路径。通过 HTTP 预览搜索，不要用 file:// 打开。

## 修改内容

- src/content.json：页面、分组、摘要和正文 HTML。
- src/shell.html：布局与头部导航。
- public/style.css：视觉系统与响应式布局。
- public/app.js：搜索、菜单、复制和主题。
- build.mjs：静态页面、目录、导航、搜索索引和 .nojekyll。

架构与驱动页使用正文内的静态 SVG 图，样式位于 `public/style.css` 的 `.doc-diagram` 规则；无需 Mermaid 脚本、CDN 或外部字体。修改时保留每张图的 title/desc、唯一 ID 和文字说明，并检查亮色、暗色与窄屏局部滚动。根 README 使用 GitHub 可渲染的 Mermaid，分层与文档站保持一致。

首页以“让你的应用，调用原生执行能力”说明产品定位，导语强调通过 SDK 调用其他机器上的原生 Harness。主要价值依次为应用接入业务流程、复用设备接入、独立后台持有执行与按原身份查回；首屏主操作进入应用 SDK，设备安装保留独立入口。支持情况紧邻首屏：Codex 已支持，dsh 为源码 SDK 实验入口，zcode、opencode 计划接入；完整状态维护在 support 的 harness-roadmap 节。首页不放不可操作的模拟功能卡或像链接的产品名。选型说明放在 overview 的 when-to-use 节，区分个人原生远程控制、单 Harness 的 SDK / App Server 集成、Dock 的跨机器接入与执行管理；保留官方入口及核对日期，明确审批与事件并非 Dock 独有，多 Harness 为次要的适配方向。首页流转图使用内联 SVG；窄屏改为纵向 HTML，信号动画遵循减少动态效果设置。

首屏图从应用经连接 SDK、Server 到独立设备后台，强调后台持有进程与记录、原生审批和结果返回应用。ACP 只表示设备后台与原生 Harness 之间的执行协议，不用于应用、Server 与设备的网络连接。图内展示设备上所选的原生 Harness 及安装、登录、工具和会话，不以多个计划适配对象作为图的重点；当前支持和计划适配在图外区分。ACPX、各 Harness 的具名适配器与原生进程层级见 architecture 和 drivers 页面。

产品与维护文档统一维护在 src/content.json；不再保留重复的 docs/ 目录。已发布支持范围为 macOS arm64 + Codex Developer Alpha；源码与新构建候选首页收敛为设备持有人的连接、后台、执行计数和需要处理事项；环境列表、固定回显、分环境历史与诊断放入“检查本机环境”，登录自启与版本操作放入“设置与维护”；Codex 为原生只读回显，dsh 为沿用原生策略的实验固定回显，不提供只读保证。现有公开下载仍只测试 Codex，其他 Harness 尚未支持。文档站不包含真实地址、设备身份或凭据。

构建、链接检查和页面 QA 不替代产品的真实设备安装、模型执行或部署验收。

## 文档索引

文档内容的唯一来源为 [src/content.json](src/content.json)，本地构建与部署共用相同内容。

### quickstart

快速开始：启动预览后访问 `/quickstart/`。首先是从 GitHub Release 下载并安装客户端、原生 Codex 登录、邀请确认和“测试 Codex”；另说明源码与新构建候选可选择 Codex/dsh、分别测试。设备用户无须终端、Git、Node、pnpm 或 JSON。源码完整链路已移到开发与验证页的次要章节，SDK 与 server 仍有各自入口。

### usage

执行与测试：启动预览后访问 `/usage/`。介绍轻量首页确认设备状态后回到调用方应用，并在需要时进入“检查本机环境”查看后台发现列表、固定回显、分环境历史与诊断；Codex 使用原生只读模式，dsh 沿用原生权限配置、不提供只读保证。两者都使用模型额度，出现工具或额外审批不会判定通过；服务器连接单独确认。公开 v0.1.0 下载仍只有 Codex 测试。本机自检由 Daemon 通过已有受保护 socket 和执行链运行，不代表全部工具或业务应用已验收。高级章节保留应用侧两轮合成测试与可选审批：使用当前拥有者的 SDK 连接，CLI 只在该应用身份未连接时使用，不创建第二个控制方。

### pairing

配对与访问管理：启动预览后访问 `/pairing/`。面向管理员，说明设备邀请、单应用拥有者、凭据分发与维护窗口内加载配置。

### troubleshooting

诊断与常见问题：启动预览后访问 `/troubleshooting/`。区分后台停止、连接未建立、状态读取失败、执行中、结果待核对和原生权限限制。

### sdk

SDK 接入：启动预览后访问 `/sdk/`。主入口 `/sdk/#first-task` 使用固定 `sdk-v0.1.0` 开发者发行：SDK、server、macOS arm64 Daemon、校验和与源码元数据。按公开下载、冷缓存离线安装、三个终端启动隔离服务/设备/调用方的顺序，将上传文本整理为 Markdown；示例在 SDK 的 `examples/first-task.mjs`，先落盘私有 receipt，再派发一次，只读查询原任务完成后才保存报告和清理托管文件。它不替代第二台 Mac 首装、App 签名或其他工具验收。 通用执行 CLI 见[通过 CLI 执行任务](https://hutian-ai.github.io/harness-dock/sdk/#execution-cli)：安装发行 SDK 后可调用包内 CLI 提交自己的任务、处理原生审批，并查询原请求记录。

执行 CLI 已于 2026-10-30 在本机 macOS arm64 使用真实 Codex 验证通过：一次任务完成、原生 `allow_once` 审批成功送达且命令退出 0、另起 `status --receipt` 查回同一执行与完整结果。首轮验证范围仅限本机源码链路，不覆盖跨机器、断线或重启恢复、两轮续接、全部工具或插件、独立发行包及生产部署；详见 [真实 Codex 验证结论与范围](https://hutian-ai.github.io/harness-dock/sdk/#execution-cli-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

同日追加验证了执行 CLI（提交 `4fcd3b8`）在原生命令开始后收到 `SIGINT`、退出码为 `130` 并返回 `unknown`，再按原 receipt 从 `running` 查回 `completed`；服务入口 `prepare/execute` 各一次，原生 turn、命令及文件效果也各一次，未重复提交。该 SIGINT 验证范围仅限同机中断 CLI 观察、Server/Daemon 持续运行，不覆盖 `SIGKILL`、进程重启、跨机器或真实网络故障恢复；详见 [CLI 中断后按 receipt 查回原执行](https://hutian-ai.github.io/harness-dock/sdk/#execution-cli-interruption-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

同日还验证了执行 CLI（验证时提交 `7a51fd1`）被 `SIGKILL` 强制结束、stdout 为空且没有最终 JSON 后，完整 receipt 保持原指纹，并能从 `running` 查回原执行的 `completed` 结果；`prepare/execute`、原生 turn、命令、文件效果及持久执行行均各一次，未重复提交。范围仅限同机强杀 CLI、Server/Daemon 持续运行；未覆盖服务强杀或重启、断电、跨机、真实网络故障、原生进程崩溃或新审批请求，详见 [CLI 被 SIGKILL 后按 receipt 查回原执行](https://hutian-ai.github.io/harness-dock/sdk/#execution-cli-sigkill-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

### server

服务端部署：启动预览后访问 `/server/`。

### installation

设备安装与维护：启动预览后访问 `/installation/`。

设备邀请以服务器生成的 HTTPS 链接为主要入口，网页唤起客户端、用户确认后领取一次；JSON 导入位于高级设置。反向代理增加 /connect 与 /invitations/redeem，服务端持久保存仅含摘要的消费记录；容器需挂载私有 invitation-state 目录，不能使用易失的 /tmp。菜单栏面板的用户接入与安装步骤统一维护在 installation 页面，普通用户先从 Release 下载并安装客户端，再通过邀请连接并回到调用方应用；环境检查按需进行，原生源码与构建说明在 `apps/device-panel/README.md`。`pnpm panel:build` 在 macOS arm64 上生成携带运行时的本地 App/ZIP；Developer ID 签名、公证、公开发行和真实目标设备验收分别记录。`pnpm check` 在 macOS arm64 上额外检查 Swift 源码，其他平台明确跳过原生面板检查。

### architecture

架构与执行契约：启动预览后访问 `/architecture/`。

### drivers

Harness 集成与 ACP 分层：启动预览后访问 `/drivers/`。区分具名 dock 集成层与 ACPX，分别说明 Codex/codex-acp、dsh 原生 ACP 路径及能力边界。

### support

支持范围：启动预览后访问 `/support/`。

### lifecycle

执行生命周期与资源：启动预览后访问 `/lifecycle/`。

### verification

开发与验证：启动预览后访问 `/verification/`。

首版逐项确认以下证据，不把一种验证当作另一种验证的通过：

| 验证层 | 交付前确认 |
| --- | --- |
| 确定性与隐私 | `pnpm check`、自检派发/收据/恢复/持久化与回调隔离边界、源码冒烟、隐私扫描与人工复核 |
| 文档站 | 构建、站内链接、桌面/窄屏和亮暗主题实际查看 |
| 独立分发 | 同一候选包的仓外离线安装、许可、manifest 和摘要 |
| 真实 Codex | 精确完成、两轮续接、工具/审批投递、只读恢复和不重派 |
| 真实 dsh | `pnpm accept:dsh`：SDK / Server / DeviceHost 本机 fixture、原生审批允许/拒绝/失效与一次性作用域、MCP 成功/错误/送达、调用方与原生项目 skills 共存；不替代独立进程、设备或发行包 |
| 实际 GUI | 邀请与已有设备复用、环境检查不阻挡接入、首页状态与需要处理事项、“检查本机环境”中的固定回显/诊断/分环境历史、关闭重开不重派、全局测试阻止切换与维护、“设置与维护”的受保护操作 |
| 独立设备 | 首装、移动 App、真实登录自启、升级/回滚和用户文件保留 |
| 远端 CI 与发行 | 对应源码 revision 的 CI、Developer ID/公证、下载入口和发行权限分别确认 |

这是一份验收要求，不是通过记录。实际结果绑定源码 revision、平台和产物摘要，保存在 ignored 的 `.local/`；公开发行另行执行。

### distribution

构建与分发：启动预览后访问 `/distribution/`。

SDK 发行由 `.github/workflows/sdk-release.yml` 监听 `sdk-v*` tag，从干净固定 revision 复用 bundle 与离线消费验证，再以 `package-release.ts --sdk-tag` 生成并发布开发者归档；不发布 npm，不修改独立的 App `v*` 发行。发布前后核对来源和摘要，已发布资产不覆盖。
