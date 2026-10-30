# harness-dock 文档站

产品文档站面向接入方开发者，帮助他判断何时使用 Dock，并跑通“产品发任务 → 所选设备原生执行 → 结果回到产品”。开发者从 SDK 示例开始，无需先安装 App；设备使用者取得管理员邀请后，走“下载 App → 邀请连接这台 Mac → 准备原生 Codex → 按需测试 → 回到调用方应用”；管理员从公开 Server 归档开始部署与配对。原生 Harness 接入与执行管理是产品所处的 AI Infra 层。App `v0.1.0` 与 SDK `sdk-v0.1.0` 分别发行：App 只支持 Codex，SDK 含 Codex 与实验性 dsh 适配；源码候选面板变化单独标注。设备安装教程默认对应可下载的 App，不以未发布界面作为操作前提。

位于 harness-dock 仓库的 `apps/docs-site/`，使用 Node.js 静态生成，无第三方运行时依赖。中性黑白底、绿色强调、两层导航、图标侧栏和三栏阅读布局。

只使用客户端的用户请阅读站点“设备快速开始”和“安装执行设备”，通过 [Release 下载客户端](https://github.com/hutian-ai/harness-dock/releases/download/v0.1.0/harness-dock-panel-0.1.0-darwin-arm64.zip)；不需要运行下面的文档预览命令。客户端仅完成本地 ad-hoc 签名，尚未完成 Developer ID 签名与公证。

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

首页以“让原生 Harness，为你的产品执行任务”表达接入后的价值；AI Infra 只用于产品定义，具体指跨设备原生 Harness 接入、连接与执行管理。内容顺序为：首屏价值与多设备图 → “生成报告”用法示意 → 原生环境复用、设备选择、原执行记录三个收益 → 接入方式选择 → 当前支持与准备条件 → 开发者、设备使用者、管理员三个入口。用法示意不代表已内置业务应用；App 已发布支持、SDK 实验适配、源码候选界面和计划适配分别标记。

首屏实色主按钮“下载 macOS 版”直达 v0.1.0 macOS arm64 ZIP，标注 Apple 芯片；描边次按钮“查看接入示例”进入 `/sdk/#first-task`，从可运行的 SDK 示例发起一次任务并读取原结果。两个按钮使用语义前置图标与对角切角背景，链接本身不裁切，以保留完整键盘焦点环；窄屏纵向排列。设备自检与产品任务验收分开，按钮下保留安装说明。窄屏先展示接入与下载操作，再展示执行图。全站沿用现有 UI 样式和组件，页面标题、摘要、示例和角色说明按任务组织，AI Infra 不作为各页口号。

首页与 overview 的选型说明区分个人原生远程入口、已有设备管理的原生 SDK / 服务接口集成、Dock 的跨设备接入与执行管理。会话、审批和事件不作为独有卖点；多 Harness 是后续适配收益。支持进度保留 Codex 已支持、dsh SDK 实验、zcode/opencode 计划，完整状态在 support 的 harness-roadmap 节。图与用法示意沿用静态 HTML/SVG，动画遵循减少动态效果设置。

首屏图展示同一 Server 接入多台执行设备，由应用通过连接 SDK 选择本次目标；只高亮一台设备的任务路径，其他设备保留独立连接。所选设备展开独立后台与原生 Harness，其他设备用简化结构表示各自的后台与原生环境；窄屏同样保留多设备分支。图中强调后台持有进程与记录、原生审批和结果沿原路返回应用，不暗示 Server 自动调度、广播或故障迁移。ACP 只表示设备后台与原生 Harness 之间的执行协议，不用于应用、Server 与设备的网络连接。图内展示设备上所选的原生 Harness 及安装、登录、工具和会话，不以多个计划适配对象作为图的重点；当前支持和计划适配在图外区分。ACPX、各 Harness 的具名适配器与原生进程层级见 architecture 和 drivers 页面。

产品与维护文档统一维护在 src/content.json，不再保留重复的 docs/ 目录。App `v0.1.0` 面向 macOS arm64 + Codex；SDK `sdk-v0.1.0` 的开发者 Daemon 另含实验性 dsh 适配。源码与新构建候选的面板把环境列表、固定回显、分环境历史与诊断放入“检查本机环境”，把自启和版本操作放入“设置与维护”；这些界面尚未进入 App `v0.1.0`，只在教程后部另列。Codex 固定回显使用原生只读模式，dsh 候选固定回显沿用原生策略，不提供只读保证。文档站不包含真实地址、设备身份或凭据。

构建、链接检查和页面 QA 不替代产品的真实设备安装、模型执行或部署验收。

## 文档索引

文档内容的唯一来源为 [src/content.json](src/content.json)，本地构建与部署共用相同内容。

### quickstart

设备快速开始：启动预览后访问 `/quickstart/`。默认介绍公开 App `v0.1.0`：先取得管理员邀请，安装客户端、连接这台 Mac，实际执行前安装并登录 Codex，需要核验时点击“测试 Codex”，最后回到提供邀请的应用。下载附近说明 macOS 可能阻止首次打开并提供求助入口。源码候选的“检查本机环境”等界面另列，不让公开 App 用户混用步骤。开发者直接进入 `/sdk/#first-task`；管理员进入 Server 部署。设备用户无须终端、Git、Node、pnpm 或 JSON。

### usage

执行与测试：启动预览后访问 `/usage/`。默认说明公开 App `v0.1.0` 的 Codex 自检、连接与结果状态；源码候选的分环境检查另列。本机自检不代表全部工具或业务应用已验收。高级应用两轮测试与可选审批使用已发布 SDK 的 `node_modules/@harness-dock/client/dist/cli.js`，从安装 SDK 的项目目录运行，沿用拥有者的应用凭据；该身份已有连接时复用原应用验证，不另建控制方。候选 bundle 与源码命令只作为显式补充。

### pairing

配对与访问管理：启动预览后访问 `/pairing/`。面向管理员，说明设备邀请、单应用拥有者、凭据分发与维护窗口内加载配置。

### troubleshooting

诊断与常见问题：启动预览后访问 `/troubleshooting/`。区分后台停止、连接未建立、状态读取失败、执行中、结果待核对和原生权限限制。

### sdk

SDK 接入：启动预览后访问 `/sdk/`。主入口 `/sdk/#first-task` 使用固定 `sdk-v0.1.0` 开发者发行：SDK、server、macOS arm64 Daemon、校验和与源码元数据。首次同机体验无需设备 App；按公开下载、校验、离线安装和三个终端启动独立服务/设备/调用方，将上传文本整理为 Markdown。已有服务走 `/sdk/#remote-device`，应用领取自己的凭据，设备通过 App 邀请连接。示例先保存私有 receipt、只派发一次，查回原任务完成后保存报告。页面优先给出 API 一次执行与方法，CLI 与恢复随后说明；两轮测试仅在需要验证续接或审批时推荐。详细源码验收记录移到 verification，SDK 保留原锚点及摘要链接。这些说明不替代第二台 Mac 首装、App 签名或业务验收。

### server

服务端部署：启动预览后访问 `/server/`。推荐 Linux 管理员从已发布 `sdk-v0.1.0` 的 Server 归档开始，校验后解压，使用归档自带 Dockerfile 构建镜像，再初始化私有配置、准备 TLS 并部署。源码构建是维护者选项。文档命令核对不代表已完成实际部署。

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

执行 CLI 已于 2026-10-30 在本机 macOS arm64 使用真实 Codex 验证通过：一次任务完成、原生 `allow_once` 审批成功送达且命令退出 0、另起 `status --receipt` 查回同一执行与完整结果。首轮验证范围仅限本机源码链路，不覆盖跨机器、断线或重启恢复、两轮续接、全部工具或插件、独立发行包及生产部署；详见 [真实 Codex 验证结论与范围](https://hutian-ai.github.io/harness-dock/verification/#execution-cli-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

同日追加验证了执行 CLI（提交 `4fcd3b8`）在原生命令开始后收到 `SIGINT`、退出码为 `130` 并返回 `unknown`，再按原 receipt 从 `running` 查回 `completed`；服务入口 `prepare/execute` 各一次，原生 turn、命令及文件效果也各一次，未重复提交。该 SIGINT 验证范围仅限同机中断 CLI 观察、Server/Daemon 持续运行，不覆盖 `SIGKILL`、进程重启、跨机器或真实网络故障恢复；详见 [CLI 中断后按 receipt 查回原执行](https://hutian-ai.github.io/harness-dock/verification/#execution-cli-interruption-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

同日还验证了执行 CLI（验证时提交 `7a51fd1`）被 `SIGKILL` 强制结束、stdout 为空且没有最终 JSON 后，完整 receipt 保持原指纹，并能从 `running` 查回原执行的 `completed` 结果；`prepare/execute`、原生 turn、命令、文件效果及持久执行行均各一次，未重复提交。范围仅限同机强杀 CLI、Server/Daemon 持续运行；未覆盖服务强杀或重启、断电、跨机、真实网络故障、原生进程崩溃或新审批请求，详见 [CLI 被 SIGKILL 后按 receipt 查回原执行](https://hutian-ai.github.io/harness-dock/verification/#execution-cli-sigkill-acceptance)。原始记录仅保存在 ignored 的 `.local/`，不提交。

### distribution

构建与分发：启动预览后访问 `/distribution/`。

SDK 发行由 `.github/workflows/sdk-release.yml` 监听 `sdk-v*` tag，从干净固定 revision 复用 bundle 与离线消费验证，再以 `package-release.ts --sdk-tag` 生成并发布开发者归档；不发布 npm，不修改独立的 App `v*` 发行。发布前后核对来源和摘要，已发布资产不覆盖。

首页下载按钮的 Apple 图标来自 [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/apple.svg)，项目许可为 [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md)；图标随文字继承颜色，作为装饰隐藏于辅助技术。SDK 代码图标复用站内线性图标风格。
