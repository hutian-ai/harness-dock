# 固定版本的本地协议补丁

补丁绑定 ACPX 0.21.1 / Codex ACP 2.1.1，通过 patchedDependencies 与 lockfile 安装，不手改 node_modules。Codex ACP 继续使用其已有 app-server client；ACPX 继续持有 Harness 子进程和会话，没有第二套原生 Codex Driver。

| 补丁 | 当前边界 |
| --- | --- |
| Codex ACP | 透传明确消息 phase、根会话完整消息、原生 turn/diff/usage；具名 `_harness-dock/control` 只允许 inspect、read_turn、带 expectedTurnId 的 steer；HARNESS_DOCK_SKILL_ROOT 增量传入原生 skills/extraRoots/set，不修改用户目录；具名桌面宿主启动 bootstrap 复用原生 MCP；inspect 可按 ACP 自有 thread 查询可选原生 MCP 状态，查询故障仅报告 unavailable，不阻断必需 config/model 读取；执行不做 hostOnly 全局门禁，不能注入其他 thread，普通启动不变 |
| ACPX | 提供每轮显式启用的 rawSessionUpdates 通用事件接缝，同一队列中每条 update 仅产生一个携带标准解析结果的信封，默认保持上游标准事件；在其既有 manager/client 生命周期内转发三个控制操作；inspect 的 handle 经既有持久会话控制路径传入实际 sessionId，活动轮次拒绝此类探测；显式环境允许列表严格生效；向审批/提问调用方提供 responseSent，确认响应已写入 ACP transport |

## 0.21.1 上游覆盖与保留范围

- PR #882 的精确 optionId 类型、选项校验、无效 ID 取消直接使用上游实现；对应补丁已删除，decisionToResponse 与公开 decision union 和 npm 原包字节一致。
- 子进程环境传递改用原生 agentProcessEnvAllow，两个 Driver 的 Runtime 创建入口均显式传入同一基础变量目录；buildAgentEnvironment 与 npm 原包字节一致，不再维护环境复制实现。
- 上游允许列表会额外放行进程 essentials、LC_/XDG_ 前缀和 ACPX_AUTH_*。保留一处严格允许列表兼容修正：显式 allow 存在时，仅该目录中的父环境名可继承，block 仍优先；未提供 allow 时保持上游默认行为。调用方明确提供的可信环境/认证增量仍走原生 overlay。它保留原有宿主凭据隔离，不增加新的授权系统。
- 其余补丁只保留当前调用方依赖的 raw session/update、受限 dockControl、permission/elicitation responseSent、模式 metadata 投影、逐操作建会话期限与进程内启动观察。模式投影只服务保留但未支持的其他适配器，不扩大 Codex 首版支持范围。
- Codex ACP 2.1.1 补丁保持不变。补丁按 0.21.1 的实际发布文件重新生成，不复用旧版本带内容 hash 的 chunk 路径。

控制方法不提供任意 RPC 透传。read_turn 不创建会话或执行 prompt；steer 迟到拒绝，不回退下一轮。responseSent 不决定 allow/deny，也不保证工具成功。环境允许列表保留基础进程变量及调用方显式环境，防止嵌入宿主的 Core 凭据被继承。授权 MCP 环境由宿主单独冻结。

Lobi/DeepSeek 执行统一使用 ACPX 后，增加 new/load/resume 的模式目录只读投影：保留到 record.acpx.session_modes，经现有 clone 和 getStatus.details.modes 返回。缺失为 null，用于本轮配置校验；不创建会话、不触发重连，不修改执行/恢复状态机。该投影不把安装探测结果冒充本轮会话能力，完整能力探测仍局部使用 SDK；上游完整暴露模式 metadata 后删除此补丁。

ACPX 新建 runtime owner 时，initialize 已有 timeoutMs 限时，而随后的 new/load/resume 原来没有独立限时。固定补丁为后一步补相同的逐操作上限；通用 ACP driver 不再用一个外层计时把初始化与会话建立合并计费。生产两步各为 15 秒，与迁移前 SDK 的逐操作语义一致；卡住的恢复仍失败，不创建替代会话、不发送 prompt。该补丁沿用 ACPX 关闭失败 owner 的既有路径，上游提供相同限时后删除。

ACPX 进程内 Runtime 透传现有 AcpClient.onAcpMessage 观察回调；共享 Runtime 拒绝该进程内选项。Codex 只在启动时配对 initialize、session/new/load/resume 请求和响应，输出固定阶段、runId、状态和单调耗时，不保存协议 payload。进程创建沿用现有 processLifecycle 观察点；诊断失败不改变执行裁决和逐操作期限。上游 Runtime 暴露等价观察入口后删除此透传补丁。

Codex ACP 冷恢复仅在原有授权与 Skill 根设置完成后，将项目作用域 MCP 配置读取和全局 Provider 读取用 Promise.all 并行；两项查询的作用域和结果保持独立，二者均成功后才调用 thread/resume。任一失败继续拒绝启动并由原 owner 关闭路径清理，不补建会话、不派发 prompt、不缓存账户或配置，不改变 MCP 就绪、订阅时序与逐操作期限。上游消除该串行读取后删除对应补丁。

事件约定 `_meta["harness-dock"].version = 1` 是本地扩展；其解析与 CodexEvent/CodexMessage/CodexTokens 类型由 packages/drivers/src/codex-events.ts 持有，CodexExecutor 在对外观察前解码，原始信封和其他元数据不进入设备事件流。详细消费边界见 [嵌入接口](../docs/embedded-driver.md)。历史 SDK 的版本和能力以各验收日期为准。补丁不是零维护成本；升级前须检查上游对应函数、固定类型与真实审批、精确结果、取消、续接和进程清理。上游提供等价能力后删除对应补丁。

保留依赖包内的许可证：ACPX MIT、Codex ACP Apache-2.0。固定来源为 [ACPX v0.21.1](https://github.com/openclaw/acpx/tree/v0.21.1) 和 [Codex ACP v2.1.1](https://github.com/agentclientprotocol/codex-acp/tree/v2.1.1)。

## 独立交付

源码安装由根 pnpm-lock.yaml 和 patchedDependencies 应用补丁。daemon 运行产物完整携带已应用补丁的依赖，另附 patches/ 中的这两份原文件供审查；运行时不读取源码仓库的补丁路径。bundle 不携带 deploy 生成的外部源码/补丁安装元数据，升级依赖须从源码重新构建并验证。controller.tgz 使用 npm bundledDependencies，只含 SDK 及其传递依赖，不含 ACPX/Codex。
