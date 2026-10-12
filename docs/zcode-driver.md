# ZCode Driver

## 目标与边界（2026-10-12）

用户授权将 ZCode 接入独立 Daemon，作为家用机器的执行 Harness。目标链路为 DockClient → Daemon → ACPX → zcode-acp-server → ZCode app-server。继续使用当前 SDK 协议、准入和 SQLite；不接入 ZCode 桌面 UI、其远程 Hub 或 调用方应用。

适配器固定 `zcode-acp-server@0.68.2`（Apache-2.0），源码核对提交 `4769d58f189a949de28f5f88591b529c52d1459b`。不复制适配器源码、不加入第二套 JSON-RPC 实现。ZCode 本体由执行机器安装，并通过绝对路径显式配置；其版本与真实运行结果一起记录。

只启动 `dist/index.js`。固定版本的 pnpm override 排除 `zcode-acp-martty`：源码仅 `src/tui.ts` 引用它，stdio 入口不需要其终端 UI、DeepSeek 和 LibreOffice 依赖。禁止运行适配器 postinstall 的 Hub 通知。升级时必须重新检查这条依赖边界并执行真实桥接器握手，不能只更新版本。

## 所有权和失败语义

- Daemon 继续拥有 runId 准入、单轮并发、审批归属、快照与未知结果；Driver 只管理 ACPX 和 ZCode 进程/会话。
- 从 Codex 输入中抽出已有的窄执行契约，两个 Driver 共用；不改变 SDK 请求格式。
- 节点固定 provider、cwd、ZCode 入口和 ZCODE_HOME；控制端不能通过 prompt 请求参数更换它们。Codex 仍为默认入口，ZCode 必须显式选择。
- 复用同一 ACPX 实例和原会话；续接不匹配立即失败，不静默创建替代会话。新会话关闭旧实例。
- 显式使用 ZCode `build` 权限模式；独立 XDG 配置关闭桥接器远程 Hub、自动配额续跑及完成提示。该模式不等同于 Codex workspace-write 或 OS 沙箱。
- 只允许 ACP `allow_once`；审批回调异常、取消或过期默认拒绝。拒绝客户端文件和终端委托回调，由 ZCode 自身工具负责执行。
- 取消发往原轮次，只有上游终态确认才记为 cancelled；派发后失联为 unknown。重连不重派；跨 Daemon 重启不恢复执行。
- ZCode ACP 文本作为本轮输出，不伪造 `final_answer`。探测明确报告不支持精确 final 和原生 turn 查询。

## 验证

先复用现有控制、身份和权限测试，追加 ZCode 适配边界的协议测试：模式拒绝时不发送 prompt、同会话续接、审批允许/拒绝/迟到、取消竞争和不确定终态。尽可能用真实 ACPX 与固定社区桥接器；合成 ZCode app-server 必须标记为模拟，不冒充真实模型证据。

真实验收走 SDK → Daemon，使用独立目录和合成数据，覆盖两轮对话、工具事件、审批允许/拒绝、执行中取消和重连观察。无 ZCode 本体/认证时记录阻塞，不以模拟通过代替模型验收。家用跨网络与 Windows 验收仍独立记录。

## 当前实现与真实验收

2026-10-12 已实现上述 Daemon 路径。macOS arm64、Node 22.22.2、ZCode 桌面 3.14.5 自带 CLI、固定社区桥接器 0.68.2，通过六次真实模型执行：两轮随机标记续接、shell 工具允许写入、拒绝后文件不存在、取消待审批后旧决定失效、运行 sleep 工具后上游确认取消。SDK 重连沿用原会话，重复 runId 未重复派发。最后两次均为 cancelled，其余四次 completed；所有 finalAnswer 均保持 null。

证据在本机忽略目录 `.local/zcode-acceptance/2026-10-12T09-34-58.819Z/evidence.json`。实验结束后已删除复制的 credentials/provider_config/config 文件，关闭自建 Daemon 与桥接器；不关闭用户的 ZCode 桌面应用。

统一 `pnpm check` 68/68 通过（新增 3 项适配边界测试，复用现有 CLI 测试）。独立 bundle 在仓库外 `/private/tmp` 导入 drivers 成功，并用包内真实 ZCode ACP 桥接器建会话；Daemon 编译产物 help 包含 ZCode 初始化入口。该 bundle 检查不重复调用模型，也不代表 Linux/Windows 安装验收。

```sh
pnpm accept:zcode /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs "$HOME/.zcode"
```

验收程序会在 `.local/zcode-acceptance/` 创建隔离工作目录，复制指定 ZCODE_HOME 的认证和模型配置，代表测试控制端作允许/拒绝决定，并运行一个可取消的 `sleep 60`。使用真实在线模型，会消耗模型额度；不会操作指定源目录里的历史会话。家庭跨网络、Linux/Windows 和桌面鼠标/屏幕控制尚未验收。

`probe()` 只表示 ACP 桥接器建会话成功，不表示模型登录有效。上游惰性会话在模型进程启动前会报告默认模式；`configuredPermissionMode: build` 是节点要求，执行前必须成功完成 setMode 才派发 prompt。`modelExecutionVerified: false` 避免将无认证握手误报为模型可用。

## 设备模式的模型与 MCP

2026-10-12 补齐通用设备模式需要的两项能力：从 ACPX `getStatus().models` 读取上游实际模型目录，通过 `session/set_config_option` 选择 model/thought；使用已有 MCP bridge 把本轮授权工具传入 ACP `session/new`。MCP transport 可随会话保留，授权回调每轮重新绑定，退出该轮即解除。相同会话的工具定义发生变化时明确拒绝，避免保留上一轮的工具授权。

真实 ZCode 3.14.5 探测返回 `builtin:bigmodel-coding-plan\\GLM-5.3`，思考档位为 low/high/max。隔离认证副本下，build 模式和模型设置成功，ZCode 后端完成了合成 MCP 工具列表读取。该实验没有派发 prompt、没有模型工具调用；`mcpTools` 表示协议支持，`mcpExecutionVerified: false` 保留证据边界。实验记录位于 `.local/zcode-mcp-probe-Ciea0f/evidence.json`，复制的认证已移除。
