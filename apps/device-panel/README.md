# macOS 设备面板

轻量菜单栏 App，使用系统 AppKit / SwiftUI。支持 macOS 13+、Apple Silicon、Codex。面板先检测已有设备；新设备打开服务器邀请链接，在客户端确认即可安装并连接。工作目录自动设置，用户可直接点击“测试 Codex”验证本机模型执行，查看连接、最近测试结果与设备执行状态，或进行诊断、启停、自启、升级和回滚。

## 安装与接入

设备用户直接安装 App，不需要 Git、Node、pnpm、终端命令或 JSON 文件。

1. 下载 [v0.1.0 Developer Alpha 客户端（macOS arm64 ZIP）](https://github.com/hutian-ai/harness-dock/releases/download/v0.1.0/harness-dock-panel-0.1.0-darwin-arm64.zip)；[版本说明](https://github.com/hutian-ai/harness-dock/releases/tag/v0.1.0)列出已知限制。
2. 解压并将 `Harness Dock.app` 拖入“应用程序”目录（或 `~/Applications`），双击打开。
3. 在这台 Mac 上安装并登录原生 Codex。
4. 打开管理员提供的邀请链接，在客户端核对服务器并点击“连接这台 Mac”；也可粘贴邀请链接。已有设备优先使用原连接。
5. 点击“测试 Codex”，直接查看本机执行的通过、失败或结果待核对，以及最近检查时间。会使用一次模型请求额度。
6. 回到接入的应用发起任务；原生审批和业务结果仍在应用中处理。

支持 macOS 13+、Apple Silicon。App 已随带运行时和 Daemon；首版为 Developer Alpha，仅完成本地 ad-hoc 签名，尚未完成 Developer ID 签名与公证。普通设备用户使用 Release 中的客户端；下面的构建命令面向维护者。

## 接入后的使用

1. **设备已连接**：确认已连接到预期服务器。执行数量为零表示空闲，应用可以发起请求。
2. **测试 Codex**：点击后由本机 Daemon 提交一次固定合成回显，核对原生完成状态与精确回复，在面板显示通过、失败或结果待核对，以及最近检查时间。会使用一次模型请求的额度，无需终端、应用凭据或另建 SDK 连接。设备忙或有待核对执行时先处理原执行。
3. **需要时运行诊断**：检查安装、配置与连接，不提交模型请求。服务器连接与本机 Codex 执行是两项结果；本机测试通过不代表全部插件、桌面/浏览器工具或业务应用授权已验证。
4. **回到应用使用**：任务入口、原生审批与结果展示在调用方应用。server 转发请求，面板用于观察设备和维护。

本机自检属于设备维护，不借用应用身份、不覆盖已连接应用的回调，也不改变设备归属。高级的应用端到端验收仍使用 SDK 两轮回显与可选原生审批测试：每台设备只有一个应用拥有者，每个应用身份只有一个活动连接。已有应用连接时，复用它的 SDK 连接；CLI 只在该应用身份没有其他活动连接时使用。独立实验使用隔离 server/设备身份。

“结果待核对”是 `unknown` 执行数量，表示缺少确定完成证据；应用任务由原调用方按原 runId 查询，本机自检由面板查询原测试编号。它不是原生权限审批数量；不要清空状态或重发请求来消除计数。设备有活动或 unknown 执行时，维护操作被阻止。

退出面板保留后台运行；“停止设备”会通过本地拥有者检查空闲后停止后台。状态暂不可用时保留已读信息，并先刷新或诊断，不把陈旧状态当作当前在线证明。安装已保存身份但尚未完成时，可从原配置继续安装，无需领取另一份邀请。

## 维护者：构建客户端

以下命令由生成候选包的维护者执行，设备用户不需要构建。

在已安装依赖的仓库根目录执行（需要 Xcode 命令行工具）：

```sh
pnpm panel:build
# 也可复用同平台、已验证的运行包；输出目录必须不存在：
pnpm panel:build --bundles .local/bundles/candidate --output .local/panel/candidate
```

产物为 `Harness Dock.app`、ZIP、摘要与安装说明，全部位于 ignored 的 `.local/`。App 随带 Daemon、Node、依赖、补丁和许可。默认使用当前 Node 及其安装根目录的 LICENSE；可用 `--node /absolute/node --node-license /absolute/LICENSE` 显式选择。运行时必须为 macOS arm64、Node 22.19+，且只链接系统动态库；拒绝依赖外部 Homebrew 动态库的构建。构建只进行本地 ad-hoc 签名，不等于 Developer ID 签名或公证；公开发行还需核对源码来源、验证范围和 Release 资产。

用户将 App 移入 `~/Applications` 后打开，无需安装 Git、pnpm 或 Node。原生 Codex 由用户自己安装、登录和授权。接入向导不会调用模型，也不建立第二条设备身份连接。

## 所有权与本地接口

公开客户端由 `.github/workflows/release.yml` 从 `v<package.json 版本>` 标签的干净源码构建。工作流检查原生平台、源码与运行包提交一致性，运行确定性检查、源码冒烟和离线分发验收；随后只上传客户端 ZIP、SHA256SUMS、README.txt 与 release.json，下载读回逐字节核对后才公开 Developer Alpha Release。不会上传本机 `.local/`、凭据、日志、验证截图或发布 npm 包。维护者先确认主分支 CI，再创建发布标签；发布说明维护在 `.github/release-notes/<标签>.md`。

- `NSStatusItem` 打开 400px 宽的原生弹层。参考 Magpie 的紧凑菜单栏布局与逐项操作方式；本实现不复用其代码、品牌或模型网关。
- App 以 stdin JSON 启动随包的 `daemon/dist/panel-cli.js`。没有额外 HTTP 监听端口；本机测试经原有受保护 Unix socket 请求 Daemon 启动固定自检，不接受任意 prompt、工具或权限决定，不建立第二条设备/应用连接。
- helper 复用 Daemon 的 `setupDevice`、`manageInstallation`、`startInstalled`、`stopIdleDaemon`、`deviceDiagnostics`；状态和停机经过原有受保护 Unix socket，绝不使用保存 PID 发信号。
- 主要入口是服务器生成的 HTTPS 邀请链接：网页通过 `harness-dock://connect?invite=…` 唤起 App；已运行实例接收链接并置前。客户端预览只显示服务器，用户点击“连接这台 Mac”后才领取一次短期邀请、持久化私有配置并复用 setup。粘贴链接提供备用入口，网络请求不跟随重定向、不自动重试，TLS 始终校验。
- 旧 JSON 邀请在高级设置导入，允许用户选择从下载目录取得的普通 JSON 文件；有界读取并验证身份、token 和 TLS 地址，不改变原文件权限，不打印 token。持久化使用原有 0700 设备目录与 0600 配置。导入不等于服务端已经授权或加载配置，连接状态以拥有者读回为准。
- 本机检测仅检查已选配置、默认设备配置和本产品自己的用户 LaunchAgent（最多 16 项），不递归搜索 home 或实验目录。支持旧 `dev.harness-dock.device.plist` 和现有 `org.harness-dock.device.*.plist`。候选只展示服务与连接状态，不展示凭据。
- 首次接入通过“打开邀请链接 → 确认服务器 → 连接”完成；旧 `device-pairing.json` 导入保留在高级设置。没有邀请时提供获取说明与可复制申请，服务端注册/授权仍由管理员完成，不冒充自动签发。工作目录自动使用 `~/harness-work`，私有 CA、目录修改和旧配置文件导入统一收进高级设置。
- 默认设备配置为 `~/.harness-dock/.local/device/config.json`；面板只在 `~/.harness-dock/.local/panel.json` 保存所选配置的路径。已有安装可以自动检测或导入 config；源码设备可显式使用此应用管理…。自定义目录的既有版本化安装只观察和诊断，继续通过原入口维护。
- 迁移旧源码设备时先验证 App 内的运行包，再让拥有者原子检查空闲并停机。只退役与该配置精确匹配的旧 `dev.harness-dock.device` 用户服务，将原 plist 与原自启偏好保存在配置目录的 `retired-autostart/`，保留配置、状态路径、执行身份和工作文件。随后安装随包 Daemon 并按原偏好注册新自启。失败后不重放任务，不按 PID 强杀；重新读回状态。
- 自启显式开启，使用当前用户 LaunchAgent。关闭或退出面板不停止 Daemon；关闭 App 后活动执行、审批和恢复仍归 Daemon 与原调用方。
- 停机、自启更改、升级与回滚由拥有者再次检查活动 / unknown 执行。失败后读回状态，不重试写操作、不重放任何任务。
- 安装和维护显示等待说明，面板不会因固定 UI 超时而中断写操作；完成与否以 helper 返回和拥有者状态读回为准。只读检查有独立等待上限。
- 随包 Node 安装到不可变 Daemon release 内；移动 App 不影响已安装设备。更新面板后可明确选择“更新至应用版本”，回滚也必须明确点击。两者不撤销数据库变化或外部效果。
- 日志仅手动打开本地尾部，不自动上传。“诊断”不发送模型请求；点击“测试 Codex”才提交固定合成内容。安装发现、服务器连接、本机模型执行、具体桌面与工具能力分别展示和验收。
- Daemon 先持久化测试编号，再通过现有 DeviceHost → ACPX/Codex ACP 执行一次精确回显。仅使用原生探测确认的只读模式，拒绝自检中的权限与工具回调，不重绑定应用回调，也没有平行执行后端。
- 面板启动测试后只读轮询原任务。相同最新测试编号返回原状态，响应丢失、关闭面板和重新打开均不自动重发。后台重启时未完成自检为 unknown；保存记录仍由原 Daemon/执行状态规则处理，缺少完成证据不等于失败后可安全重试。

## 验证

`pnpm check` 覆盖共享安装、导入/身份冲突、敏感值投影、受保护停机、运行时迁移以及固定自检的控制边界。自检测试包括：请求只能携带测试 UUID、持久化先于派发、重复/丢失收据不重派、后台重启转 unknown、持久化故障不报告成功、回调隔离与原生只读模式。`pnpm panel:build` 验证原生编译、产物完整性与本地签名。实际 GUI、首次设备接入、旧设备迁移、自启、移动 App、升级/回滚需在目标 Mac 独立验收；本地产物构建不代表真实 Codex、签名公证或公开发行已经完成。

开发验收可指定独立配置打开应用：

```sh
open -n ".local/panel/candidate/Harness Dock.app" --args --config "$PWD/.local/panel-test/device/config.json"
```

原始截图、日志、设备标识及配对文件留在 `.local/`。

## 邀请链接验收

服务端 `invite` 为已登记、已加载的设备生成默认 15 分钟、最长 1 小时的签名领取链接。长期设备凭据不放在链接中；`#` 片段不随网页请求发送。网页与客户端唤起参考 Magpie 的 Add to magpie 交互（https://usemagpie.ai/docs/import），没有复制代码、品牌或模型网关。确认前仅本地解析；确认后通过 HTTPS 领取一次，服务端独占并持久化消费记录，原有任务/审批/原生权限边界不变。

验证包括：邀请网页与深层链接唤起、已运行实例、未安装说明和粘贴备用入口、过期/篡改/重复/并发领取、重启防重放、身份冲突、网络响应未确认、私有 CA，以及使用隔离配置的真实 Daemon 连接。截图、测试邀请与部署证据留在 `.local/`。
