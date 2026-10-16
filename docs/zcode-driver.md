# ZCode Driver


2026-10-16 继续核对原生服务：安装版 Electron main 的 createWebRemoteControlSharedHostAttachments 使用 AttachServicePort/MessageChannelMain 接入既有 desktop host，clientMode=web-remote-replayable；host 内 interaction/browserList/browserExecute 交给 browserControlExecutor。该入口由内置 Web Remote Control manager 在 relay 鉴权、bridgeSessionId/generation、workspace scope 校验后装配，并非独立 app-server 暴露的本地监听端口。已找到复用原生 Browser Use 的候选路径，但未找到可供社区 ACP 直接连接的稳定本地 attach API，未启用远程连接/改鉴权/接管现有任务。下一步应取得原生授权 attach 入口并在 ZCode 薄适配转发整套原生服务；不能在 dock 实现 browserList/browserExecute 的浏览器后端。此处是静态安装包证据，不是新的运行成功。

## 2026-10-16 宿主扩展核查结果（公开契约/静态/无模型 CLI）

目标是 ACP 会话复用原生工具，不要求桌面 UI 聊天。固定 [官方 main aac4755666d09fdcd70272fcf063c077a639015f](https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f)，package 3.15.1，与本机 Desktop 3.14.5/build 3.14.5.7961、CLI 0.16.9 分开判断，未安装升级。

[UI_PLUGIN.md](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.md) 中 sendMessage 向绑定主对话发后续消息，需要用户手势或确认；sampling 不读取主聊天历史、拒绝 tools、includeContext 只支持 none，页面工具随活页面存在。它不是无人值守的原生执行委托入口。内部 mobile/Web Remote Control 能共享 desktop host，但由原生 relay 鉴权与 MessagePort 装配；未核实到供外部 ACP 直接连接的稳定本地 transport/auth 契约。

本轮 app-server --browser-use=headless 首次因内置 Provider Config 路径缺失停止；只补安装包内置配置路径后再次明确拒绝：仅可与 --prompt、--target 或 tui 使用。两次进程均返回 0，不能据退出码记为通过；没有创建模型任务或浏览器。社区 0.72.0 完整发布包静态检查仍无 browserList/browserExecute/AttachServicePort。未修改用户配置、启用远控或编写替代浏览器；当前结论是可靠接入未验证，不能承诺只补一个回调就能接通。

## 定位更新（2026-10-15，目标已确认，待实施）

保留 ACP 默认接入与现有社区桥，修复目标是连接 ZCode 自身的原生能力，通用 dock 不实现浏览器命令。CLI 是 Harness 的启动入口，Desktop Host/浏览器服务是 ZCode 自身运行组件；不能把二者理解为互斥产品或必须另装第三方宿主。

当前固定包 zcode-acp-server 即 william0wang/zcode-acp 的发布物，单纯切换仓库名称不构成换实现。当前启动独立 app-server，未连接 Desktop 浏览器服务；原生 Browser Use skill/node_repl 可加载，但 browserList 被社区桥拒绝。恢复原生 memory/search 偏好、补充 skill 路径及 cold resume 也属待修项。最新本轮证据归 [验证记录](validation.md)。

2026-10-15 开发补充：隔离下载 0.72.0 发布包进行静态核对，仍没有 browserList/browserExecute 分支，runtime preferences 仍将 memory/search 设为 false；未升级依赖，不能据此声称新版本运行验收。当前阻点是可靠原生服务接入口，未以换包或自建浏览器后端替代。

优先验证可靠原生连接入口，再为社区桥补 browserList/browserExecute 转发、会话/workspace、generation、取消和生命周期。源码/REA 可辅助隔离验证；现有内部 MessagePort 和官方同宿主远控不证明已有第三方本地 attach API，不能承诺只补转发即可成功。另配浏览器 MCP 或新 headless 上下文不算自带 Desktop Browser Use 已接通。

完成标准：正式 SDK/server/设备/ACP 路径下原生浏览器操作有页面读回，权限及续接保留正确身份，调用方按自身规则收存结果。本轮未更换 ZCode 包、改客户端、启用远程 Hub 或改变 build 默认权限。

## 当前启动方式与前序边界（2026-10-12）

用户授权将 ZCode 接入独立 Daemon，作为家用机器的执行 Harness。当前链路为 ServerClient → server → 设备 Daemon → ACPX → zcode-acp-server → ZCode app-server。当前代码使用既有 SDK 协议、准入和 SQLite，未接入 ZCode 桌面服务或远程 Hub；新目标的原生连接尚待验证，不在 dock 引入 调用方应用 业务类型。

适配器固定 `zcode-acp-server@0.68.2`（Apache-2.0），源码核对提交 `4769d58f189a949de28f5f88591b529c52d1459b`。不复制适配器源码、不加入第二套 JSON-RPC 实现。ZCode 本体由执行机器安装，Daemon 自动发现，必要时用设备配置覆盖入口；其版本与真实运行结果一起记录。

只启动 `dist/index.js`。固定版本的 pnpm override 排除 `zcode-acp-martty`：源码仅 `src/tui.ts` 引用它，stdio 入口不需要其终端 UI、DeepSeek 和 LibreOffice 依赖。禁止运行适配器 postinstall 的 Hub 通知。升级时必须重新检查这条依赖边界并执行真实桥接器握手，不能只更新版本。

## 所有权和失败语义

- Daemon 继续拥有 runId 准入、单轮并发、审批归属、快照与未知结果；Driver 只管理 ACPX 和 ZCode 进程/会话。
- 从 Codex 输入中抽出已有的窄执行契约，两个 Driver 共用；不改变 SDK 请求格式。
- 节点固定 cwd、发现的 ZCode 入口和 ZCODE_HOME；控制端可选择已就绪的 Provider，不能通过执行参数更换宿主目录或可执行文件。
- 复用同一 ACPX 实例和原会话；续接不匹配立即失败，不静默创建替代会话。新会话关闭旧实例。
- 默认显式使用 ZCode `build` 权限模式；控制端可选择实际 ACP configOptions 上报的 mode（2026-10-15，当前工作树），派发前重验目录并通过原生 session/set_mode 设置并核对配置更新 currentValue 后才发送 prompt；独立 XDG 配置关闭桥接器远程 Hub、自动配额续跑及完成提示。该模式不等同于 Codex workspace-write 或 OS 沙箱。
- 当前单次审批仅支持 ACP `allow_once`；目标需透传精确原生选项与实际支持的提问，不以权限种类替代 optionId。审批回调异常、取消或过期默认拒绝。拒绝客户端文件和终端委托回调，由 ZCode 自身工具负责执行。
- 取消发往原轮次，只有上游终态确认才记为 cancelled；派发后失联为 unknown。重连不重派；跨 Daemon 重启不恢复执行。
- ZCode ACP 文本作为本轮输出，不伪造 `final_answer`。探测明确报告不支持精确 final 和原生 turn 查询。

## 验证

先复用现有控制、身份和权限测试，追加 ZCode 适配边界的协议测试：模式拒绝时不发送 prompt、同会话续接、审批允许/拒绝/迟到、取消竞争和不确定终态。尽可能用真实 ACPX 与固定社区桥接器；合成 ZCode app-server 必须标记为模拟，不冒充真实模型证据。

真实验收走 SDK → server → 设备 Daemon，使用独立目录和合成数据，覆盖两轮对话、工具事件、审批允许/拒绝、执行中取消和重连观察。无 ZCode 本体/认证时记录阻塞，不以模拟通过代替模型验收。家用跨网络与 Windows 验收仍独立记录。

## 当前实现与真实验收

2026-10-12 已实现上述 Daemon 路径。macOS arm64、Node 22.22.2、ZCode 桌面 3.14.5 自带 CLI、固定社区桥接器 0.68.2，通过六次真实模型执行：两轮随机标记续接、shell 工具允许写入、拒绝后文件不存在、取消待审批后旧决定失效、运行 sleep 工具后上游确认取消。SDK 重连沿用原会话，重复 runId 未重复派发。最后两次均为 cancelled，其余四次 completed；所有 finalAnswer 均保持 null。

证据在本机忽略目录 `.local/zcode-acceptance/2026-10-12T09-34-58.819Z/evidence.json`。实验结束后已删除复制的 credentials/provider_config/config 文件，关闭自建 Daemon 与桥接器；不关闭用户的 ZCode 桌面应用。

统一 `pnpm check` 68/68 通过（新增 3 项适配边界测试，复用现有 CLI 测试）。独立 bundle 在仓库外 `/private/tmp` 导入 drivers 成功，并用包内真实 ZCode ACP 桥接器建会话；Daemon 编译产物 help 包含 ZCode 初始化入口。该 bundle 检查不重复调用模型，也不代表 Linux/Windows 安装验收。

```sh
pnpm accept:zcode
```

当前验收程序在 `.local/device-acceptance/` 创建隔离工作目录，复制本机 ZCODE_HOME（默认 ~/.zcode）的认证与模型配置，结束后删除副本。它经过 server 和 SDK 验证真实 MCP、审批送达、两轮上下文、去重、事件、重连与安全释放。此前六轮审批/取消实验属于历史证据；当前控制边界另有合成协议测试，不能混作本轮模型验证。家里实体电脑、Linux/Windows 和鼠标/屏幕控制尚未验收。

`probe()` 只表示 ACP 桥接器建会话成功，不表示模型登录有效。上游惰性会话在模型进程启动前会报告默认模式；`configuredPermissionMode: build` 是节点要求，执行前必须通过原生 set_mode 成功应用冻结选择（未选择时为 build）并核对配置更新才派发 prompt。握手惰性返回的 currentValue 不覆盖设备默认 build，默认值与可选目录分别报告。`modelExecutionVerified: false` 避免将无认证握手误报为模型可用。

## 设备模式的模型与 MCP

2026-10-12 补齐通用设备模式需要的两项能力：从 ACPX `getStatus().models` 读取上游实际模型目录，通过 `session/set_config_option` 选择 model/thought；使用已有 MCP bridge 把本轮授权工具传入 ACP `session/new`。MCP transport 可随会话保留，授权回调每轮重新绑定，退出该轮即解除。相同会话的工具定义发生变化时明确拒绝，避免保留上一轮的工具授权。

真实 ZCode 3.14.5 探测返回 `builtin:bigmodel-coding-plan\\GLM-5.3`，思考档位为 low/high/max。隔离认证副本下，build 模式和模型设置成功，ZCode 后端完成了合成 MCP 工具列表读取。该实验没有派发 prompt、没有模型工具调用；`mcpTools` 表示协议支持，`mcpExecutionVerified: false` 保留证据边界。实验记录位于 `.local/zcode-mcp-probe-Ciea0f/evidence.json`，复制的认证已移除。
