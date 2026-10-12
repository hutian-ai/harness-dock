# 固定版本的本地协议补丁

补丁绑定 ACPX 0.19.4 / Codex ACP 2.1.1，通过 patchedDependencies 与 lockfile 安装，不手改 node_modules。Codex ACP 继续使用其已有 app-server client；ACPX 继续持有 Harness 子进程和会话，没有第二套原生 Codex Driver。

| 补丁 | 当前边界 |
| --- | --- |
| Codex ACP | 透传明确消息 phase、根会话完整消息、原生 turn/diff/usage；具名 `_harness-dock/control` 只允许 inspect、read_turn、带 expectedTurnId 的 steer |
| ACPX | 校验和转换具名事件；在其既有 manager/client 生命周期内转发三个控制操作；子进程环境允许列表；向审批调用方提供 responseSent，确认响应已写入 ACP transport |

控制方法不提供任意 RPC 透传。read_turn 不创建会话或执行 prompt；steer 迟到拒绝，不回退下一轮。responseSent 不决定 allow/deny，也不保证工具成功。环境允许列表保留基础进程变量及调用方显式环境，防止嵌入宿主的 Core 凭据被继承。授权 MCP 环境由宿主单独冻结。

事件约定 `_meta["harness-dock"].version = 1` 是本地扩展；详细消费边界见 [嵌入接口](../docs/embedded-driver.md)。独立 SDK v3 继续只提供其已声明的能力。两个 patch 共 411 行（含上下文），不是零维护成本；升级前须检查上游对应函数、固定类型与真实审批、精确结果、取消、续接和进程清理。上游提供等价能力后删除对应补丁。

保留依赖包内的许可证：ACPX MIT、Codex ACP Apache-2.0。固定来源为 [ACPX v0.19.4](https://github.com/openclaw/acpx/tree/v0.19.4) 和 [Codex ACP v2.1.1](https://github.com/agentclientprotocol/codex-acp/tree/v2.1.1)。
