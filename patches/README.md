# 协议补丁

补丁绑定 ACPX 0.21.1 和 Codex ACP 2.3.0，由 pnpm patchedDependencies 安装。分发包携带实际补丁、上游许可证及来源；依赖升级须重新核对补丁应用和原生行为。

## Codex ACP

| 接缝 | 当前作用 |
| --- | --- |
| 原生身份与完整消息 | 提供精确 thread/turn、phase 和消息完成信息 |
| read_turn | 只读查询指定原执行，不创建会话或派发 prompt |
| steer | 绑定 expectedTurnId，迟到拒绝，不转入新轮 |
| 配置/能力读取 | 提供 Driver 所需的具名只读信息 |
| 工具 metadata | 补充标准 ACP 事实缺少的原生身份/字段 |

标准 ACP 工具报告器负责工具输入、状态、结果和输出。drivers 持有展示白名单、增量合并、截断、文本过滤及摘要/桌面启动策略；权威完成证据不依赖展示投影。

本机 CODEX_ACP_APP_SERVER_ARGS、CODEX_ACP_SKILL_ROOTS 等具名参数只供已选择的原生环境使用，不接受远程任意 argv、路径或配置注入，不改写用户认证或配置。

## ACPX

保留原始更新的有序透传、受限原生控制、审批投递回执、严格环境允许列表、模式投影、会话操作期限和启动观察。精确 optionId 和基础子进程环境传递使用上游接口。

进程环境只包含明确允许的原生依赖，阻止父应用凭据意外继承。responseSent 只证明协议投递，不决定审批，也不保证工具成功。

## 维护与删除条件

这些本地接缝不是任意 RPC 代理。原始 reasoning、文件补丁和二进制结果不进入受限展示 metadata；原始信封由 drivers 解码，具体契约见 [Driver 开发](../apps/docs-site/README.md#drivers)。

升级时核对固定依赖、补丁逆向检查、公开类型、审批、精确结果、取消、续接、恢复和进程清理。上游提供等价接口后删除对应接缝，不能用会话加载代替只读查询，或用异常 fallback 绕过原生语义。

验证方法见 [验证与验收](../apps/docs-site/README.md#verification)，许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
