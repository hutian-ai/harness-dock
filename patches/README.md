# 固定版本的本地协议补丁

补丁绑定 ACPX 0.19.4 / Codex ACP 2.1.1，通过 patchedDependencies 与 lockfile 安装，不手改 node_modules。Codex ACP 继续使用其已有 app-server client；ACPX 继续持有 Harness 子进程和会话，没有第二套原生 Codex Driver。

| 补丁 | 当前边界 |
| --- | --- |
| Codex ACP | 透传明确消息 phase、根会话完整消息、原生 turn/diff/usage；具名 `_harness-dock/control` 只允许 inspect、read_turn、带 expectedTurnId 的 steer；HARNESS_DOCK_SKILL_ROOT 增量传入原生 skills/extraRoots/set，不修改用户目录；具名桌面宿主启动 bootstrap 复用原生 MCP；inspect 可按 ACP 自有 thread 查询可选原生 MCP 状态，查询故障仅报告 unavailable，不阻断必需 config/model 读取；执行不做 hostOnly 全局门禁，不能注入其他 thread，普通启动不变 |
| ACPX | 提供每轮显式启用的 rawSessionUpdates 通用事件接缝，同一队列中每条 update 仅产生一个携带标准解析结果的信封，默认保持上游标准事件；在其既有 manager/client 生命周期内转发三个控制操作；inspect 的 handle 经既有持久会话控制路径传入实际 sessionId，活动轮次拒绝此类探测；子进程环境允许列表；精确 optionId 不按 kind fallback；向审批/提问调用方提供 responseSent，确认响应已写入 ACP transport |

控制方法不提供任意 RPC 透传。read_turn 不创建会话或执行 prompt；steer 迟到拒绝，不回退下一轮。responseSent 不决定 allow/deny，也不保证工具成功。环境允许列表保留基础进程变量及调用方显式环境，防止嵌入宿主的 Core 凭据被继承。授权 MCP 环境由宿主单独冻结。

Lobi/DeepSeek 执行统一使用 ACPX 后，增加 new/load/resume 的模式目录只读投影：保留到 record.acpx.session_modes，经现有 clone 和 getStatus.details.modes 返回。缺失为 null，用于本轮配置校验；不创建会话、不触发重连，不修改执行/恢复状态机。该投影不把安装探测结果冒充本轮会话能力，完整能力探测仍局部使用 SDK；上游完整暴露模式 metadata 后删除此补丁。

事件约定 `_meta["harness-dock"].version = 1` 是本地扩展；其解析与 CodexEvent/CodexMessage/CodexTokens 类型由 packages/drivers/src/codex-events.ts 持有，CodexExecutor 在对外观察前解码，原始信封和其他元数据不进入设备事件流。详细消费边界见 [嵌入接口](../docs/embedded-driver.md)。历史 SDK 的版本和能力以各验收日期为准。补丁不是零维护成本；升级前须检查上游对应函数、固定类型与真实审批、精确结果、取消、续接和进程清理。上游提供等价能力后删除对应补丁。

保留依赖包内的许可证：ACPX MIT、Codex ACP Apache-2.0。固定来源为 [ACPX v0.19.4](https://github.com/openclaw/acpx/tree/v0.19.4) 和 [Codex ACP v2.1.1](https://github.com/agentclientprotocol/codex-acp/tree/v2.1.1)。
