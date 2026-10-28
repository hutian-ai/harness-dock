# 成熟模块复用评估（2026-10-12）

当前结论（2026-10-28）：定位为供应用、Agent 和自动化流程使用的跨机器原生 Harness 接入与执行基础设施，调用方应用 是调用方之一。当前仅支持 macOS arm64 上的 Codex，经固定 ACPX/Codex ACP 与具名薄适配连接，设备网络继续 ws + json-rpc-2.0，云端 server 用 Docker Compose。Lobi/DeepSeek 只保留未支持的源码，ZCode 接入已移除。下文保留具名历史取舍，不构成当前支持或继续实施项。

## 2026-10-28：ACPX 0.21.1 与补丁收缩

固定升级到 0.21.1，精确 optionId 改用已合入的上游 PR #882，子进程环境传递改用原生 agentProcessEnvAllow。删除这两处旧实现，保留一处显式允许列表严格生效的兼容修正，避免上游默认额外继承 ACPX_AUTH_*、LC_/XDG_ 等宿主变量。可信显式环境增量继续由上游 overlay 处理；不增加进程、会话或权限管理实现。

其余事件、受限控制、审批投递回执、模式投影、逐操作期限和启动观察仍有当前调用方，保留具名最小接缝；Codex ACP 2.1.1 补丁不变。具体分工和删除条件归 [补丁说明](../patches/README.md)，确定性测试与实际 Codex 结果归 [验证记录](validation.md)。

## 2026-10-27：安全依赖与原生分发能力

采用 diff 8.0.3、Zod 4.6.6、MCP server/client 2.3.0，生产及全部依赖公告扫描清零。固定 pnpm 12.15.0，以原生 hoisted deploy 和 npm bundledDependencies 交付完整运行目录与离线 SDK 归档；不维护自定义依赖解析器或锁文件改写器。运行目录移除仍指向源码的 deploy 安装元数据，daemon 随附原补丁且保留 hardlink detach/manifest。ACPX/Codex ACP 的版本、补丁和设备执行语义不变。仓外空缓存 SDK 安装/ci、公开类型、完整确定性检查与真实 Codex 链路 Local 通过，具体范围归验证记录；未发布或切换现用服务。

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

## 2026-10-13：进一步复用现有依赖

- 配置结构校验统一使用已有 Zod 4.6.5，设备和 server 显式声明同一固定依赖。server/配对文件仍拒绝未知字段，设备配置保留原扩展字段与可选输入兼容；Token 唯一性、完整设备授权、TLS、文件权限和资源关系继续由原边界检查负责。
- ACP 能力探测使用固定 SDK 1.4.0 的 `connectWith` 明确关闭连接；保留协议版本、模型/模式和续接 metadata、超时/abort/Provider exit 竞态，以及 Daemon 的 Provider/MCP/临时目录清理。没有引入 `withSession` 的额外 update queue，也没有把 Lobi/DeepSeek 执行器整体迁到 ACPX。
- 采用 pnpm 11.9.0 的现代 `deploy`，启用 workspace 注入与 build 后同步；移除 legacy 自引用软链修补及源安装状态恢复。保留交付文件 hardlink detach，不能用注入本身替代产物不可变性。隔离实验及最终产物均通过仓库外使用、依赖隔离与重建后不变检查；外部依赖锁定版本没有升级。

本轮没有新增日志框架、状态机、ORM 或网络协议。源码、合成回归、真实 Provider 探测与交付证据分别见 [验证记录](validation.md)。

## 2026-10-17：Lobi / DeepSeek 执行统一到 ACPX

复核固定 ACPX 0.19.4 后，确认其公共 runtime 已覆盖注册启动命令、显式原会话续接、配置控制、逐轮权限回调及写入回执、原始 session update、取消和完整结果。此前能力探测字段不足，不能作为保留另一套完整执行器的理由。

`runAcpSession` 改为消费 ACPX 公共 API，删除直接通过 SDK 启动进程、initialize/new/load/resume、发送 prompt/cancel 及管理权限响应传输的实现。每次调用使用内存 sessionStore 并显式冷加载原生 sessionId，Daemon 仍拥有持久执行身份；不从 ACPX 旧记录推断另一会话，也不自动重发 prompt。具名适配器只保留启动参数/环境、模型/模式/推理配置及实际响应校验。

确认的元数据缺口是 ACPX 丢弃 new/load/resume 返回的模式列表。固定补丁仅增加模式目录的只读投影，经现有 record/clone/getStatus.details.modes 通道提供本轮真实目录；缺失仍为 null，不使用探测时的旧列表替代。没有增加 RPC 或修改会话、权限、恢复状态机。完整安装能力探测继续使用 `probeAcpSession` 的 SDK 实现。

保留 dock 的结果边界：只有 end_turn 算成功；cancelled 还须有明确取消请求；其他明确 stopReason 算失败；已派发但无完成响应保持 unknown。使用 promptStarted 确认实际派发，取消 ACK 不算完成。配置须由实际 setConfigOption 响应确认，不能使用 ACPX 乐观更新后的本地值代替 Provider 回读；用量经本轮 runtime record 还原原有字段，缺失保持未知。MCP 工具桥及其 delivered 回执沿用原实现。验证结果与真实环境限制见 [验证记录](validation.md)。

## 2026-10-19：轻量接入层收口

保留 server/SDK/Daemon 的可靠派发、审批归属、去重、unknown 与资源边界。将 Provider 专属探测、配置和结果映射从 DeviceHost 收入具名适配器；原生工具循环、插件、skill 与记忆继续由 harness 管理。普通 drivers 导出移除 ContainerHarness，容器实验文件和脚本保留，不作为 v1 门禁。

能力报告只增加标准字段，保留调用方现用的原生 inspection 和续接字段；协议 ready 不提升为真实模型或工具验收。本机按 Provider 明确选择代理/证书依赖；原生交互保留 options/form/url 和实际投递回执。Lobi 不再要求同时支持所有模式和两种恢复协议，但每次执行仍确认所选配置；DeepSeek 的本机权限上限保留。

ZCode 已经通过固定 ACP 桥接入，纳入本轮适配收口。固定桥不支持可靠附加调用方 skill，非空输入在准入前明确拒绝；保持默认 build、warm-only、无精确 final 和 Browser Use 未验收的限制。Codex 独立恢复证据不合并删除；后台原生能力缺口先核对启动环境、必需依赖与原生信任限制，不预设采用桌面 relay 或新增授权机制。

权限职责澄清：Harness 拥有内部 Agent、工具执行与原生授权范围；dock 只连接所选原生环境、路由原生审批并保持其归属/有效期。当前 ACP 启动的 Codex 实例并非桌面 App 已运行的聊天；原生宿主拒绝是需要准确报告的接入结果，不能据此把“桌面宿主委托”列成独立建设项。只有确认缺失依赖及受支持入口后，才补具名薄适配。
