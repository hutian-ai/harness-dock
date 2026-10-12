# 成熟模块复用评估（2026-10-12）

结论：云端用 Docker Compose；Codex/ZCode 继续 ACPX；Lobi/DeepSeek 复用官方 ACP SDK 和统一探测/执行生命周期；设备网络继续 ws + json-rpc-2.0。没有引入新的代理平台、账号系统或消息中间件。

## Socket.IO 4.8.4：本轮不替换

本机用实际 Socket.IO server/client（仅 WebSocket、合成身份）验证了：

- 默认离线 emit 会在重连后投递。添加 connected 检查与 volatile 后，离线请求可以明确拒绝。
- 已发请求在连接中断后报错，未开启 retries 时重连没有再次派发。
- 三次重连留下三个尚未完成的服务端 handler。跨重连额度与 callback AbortSignal 仍需应用层管理。
- 单条消息上限可复用，但累计在途输入、发送积压、待响应请求数和消息发送 deadline 仍需要保护。
- 实验安装 Socket.IO server/client 共 24 个传递包。没有将这些依赖加到生产 manifest 或 lockfile。

它能替换 heartbeat、重连退避和 RPC 应答关联，但不能删除本项目中占主要篇幅的设备身份/访问范围、代际隔离、未确认结果、审批归属和资源预算。现有 json-rpc-2.0 已承担请求 ID 和应答关联；替换还会改变双端协议并需要重写传输预算。因此这轮没有足够净收益，不保留实验服务或兼容协议。

这不是 Socket.IO 不支持该场景：可以用它重新实现这些规则。当前取舍是避免为了减少少量连接代码，把稳定的 wire protocol 和配额实现整体替换。

官方依据：[离线行为](https://socket.io/docs/v4/client-offline-behavior/)、[投递保证](https://socket.io/docs/v4/delivery-guarantees/)。本机实验原始记录：`.local/optimization/socketio-evidence.json`，属于合成传输实验。

## ACPX 0.19.4：继续用于 Codex/ZCode，不扩大补丁接管所有探测

使用已安装的固定补丁版 ACPX 和合成 ACP 服务验证：

- 缺失原 session 的显式续接返回 `Session not found`，没有成功创建替代会话。
- Provider 不确认取消时，设置 1 秒请求超时后结果是 failed/TIMEOUT；Driver 必须仍映射为 unknown，不能把失败或本地 abort 当作取消确认。
- `getStatus` 提供模型和 configOptions；合成服务返回的 availableModes 和 loadSession 能力没有出现在公共状态结果。完整信息仍需读取 session record 或另走协议探测。
- prompt usage 没有直接进入 turn result，但可以从 status 的累计/perRequest usage 读取，不能误判为用量完全丢失。

Lobi 要在新会话上验证可选模式再设置 build/plan；DeepSeek 要逐模型确认配置选项和推理档位；两者还要验证 MCP 列表读取及恢复能力。把它们整体改为 ACPX 仍需要一层元数据访问与事件映射，或者扩大固定补丁。当前官方 ACP SDK 已负责线协议，不需要手写 JSON-RPC。

采用较小改动：抽出 `probeAcpSession`，统一临时目录、进程、ACP initialize/new、连接关闭/超时、MCP 探测和清理。Provider 文件只保留版本、启动参数和配置差异；执行继续共用已有 runAcpSession。沒有原生 Codex fallback，也没有因元数据缺失跳过模式校验。

本机实验：`.local/optimization/acpx-evidence.json`。这是当前公开接口的取舍，不是宣称 ACPX 无法适配其他 Provider；将来上游直接提供完整探测结果时可重新评估。

## 进程管理

云端 Docker Compose 已负责重启策略、健康检查、日志轮转和资源限额；不叠加 PM2。设备需要直接调用宿主 Provider 和本机文件，保留宿主 Daemon CLI。Provider 容器执行继续后置。
