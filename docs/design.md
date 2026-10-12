# 首轮设计（历史记录）

本文记录第一轮已验收实验；当前实现边界由 [独立 v1](standalone-v1.md) 和 README 描述，特别是 TLS、持久化、新会话和容器能力。

## 决策与职责

首轮只验证宿主机 Codex，不引入 Happier、OpenHands 或 OpenClaw 服务。Happier 仅参考连接与执行分离的行为，不移植其连接监督器源码。

| 模块     | 持有内容                                                |
| -------- | ------------------------------------------------------- |
| protocol | 会话、执行、审批 ID，快照与事件，公开请求校验           |
| drivers  | 固定 ACPX/Codex ACP，Provider 生命周期与事件转换        |
| daemon   | 单节点/会话/活动执行约束、去重、待审批决定、执行事实    |
| client   | loopback 入口、请求关联、订阅与连接恢复；控制台随包提供 |

依赖方向为 protocol ← drivers/daemon/client；daemon 的执行协调依赖窄 Driver 接口。没有 调用方应用 类型或业务状态。

ACPX 使用 `acpx/runtime` 公共 API。通过 registry argv 显式指定本地 Codex ACP 2.1.1 入口，避免 ACPX 默认 registry 的旧版本范围。Codex ACP 自己解析其 `@openai/codex` 依赖；Daemon 清除 `CODEX_PATH` 等外部覆盖环境变量。

## 准入、并发与失败

- 一个 Daemon boot 使用一个随机身份，只保留一个会话。输入 sessionId 必须与现有会话一致；不自动新建替代会话。
- Driver 只在首次执行调用 ensureSession，后续始终使用原 handle。续接交给 ACPX persistent 的 same-session-only 路径，原记录缺失时不能再次 ensure 并创建替代会话。
- runId 由调用方生成。Daemon 在异步启动前保留 ID、原始 prompt/sessionId 和活动槽位；相同输入返回当前快照，冲突输入拒绝；另一 run 返回 busy。
- 连接只承载查询与命令。Daemon 持有运行和待审批 Promise，断线不取消、不允许、不重发。
- 请求 ID、runId、sessionId、permissionId 独立。审批只允许单次 allow/deny，绑定 runId；已决定、取消、终态或上游 AbortSignal 触发后失效。无 allow_once 选项的请求不能升级为永久许可。
- 静态 ACPX 权限策略 deny-all，回调异常回落为拒绝。工作模式为 workspace-write / on-request / user reviewer；禁用 ACP 委托 fs/terminal 回调，Codex 自有工具仍受其沙箱配置约束。
- cancel 先记录 cancel_requested，再调用上游；completed/cancelled/failed 只由上游 result 决定，不能以取消 ACK 或流结束推断成功。
- 未拿到 result 的异常标为 outcome_unknown，并保留活动槽位，避免结果不明时再次派发。Daemon 重启不会读取旧执行账本或重新发 prompt；旧 SDK 记录绑定原 Daemon 身份。
- 订阅先注册观察者并暂存通知，再返回快照，丢弃不大于快照 sequence 的事件。重连只重订阅和回源快照。

## 本地边界

控制端仅监听 127.0.0.1；Daemon 拒绝非 loopback ws 地址。连接凭证通过 Authorization header，校验协议版本和 Daemon ID，拒绝浏览器 Origin，并只接入一个 Daemon。凭证/config 使用 0600，`.local/` 不入 Git。

工作目录、CODEX_HOME、MCP 和环境在 Daemon 初始化时固定。认证只复制 auth.json；不导入全局配置、Skills、MCP 或会话。实验配置关闭账号插件、Apps、宿主 Skill 发现和 Skill 自动安装 MCP；仅隔离 CODEX_HOME 不会关闭 Codex 自带的插件发现。Daemon main 仅保留 PATH/HOME/TMPDIR/locale 等运行必需环境。MCP fixture 只回显合成 marker。

这不是通用安全沙箱。workspace-write 的边界由 Codex 实现；单次允许越界执行后，该命令可以越过此沙箱。首轮仅用隔离目录与合成数据验证审批，不承诺宿主机多租户安全。Docker 第二阶段再验证。

## 明确不支持

即时 steer、按 Provider turn 精确只读查询终态、跨 Daemon 重启执行恢复、容器，以及多节点/会话/并行执行。

## 消息阶段透传（已完成本地验证）

保持 ACPX 会话、进程、审批、取消和持久化实现不变，只对固定 npm 版本的事件转换打补丁。补丁由 pnpm patchedDependencies 和 lockfile 管理，不依赖手工修改 node_modules，也不声明自己是 AIR 客户端。

- Codex ACP：流式文本附带 `_meta["harness-dock"] = { version: 1, phase }`；根会话的 `item/completed` 通过 `session_info_update` 附带 `messageCompleted = { messageId, providerTurnId, phase, text }`。完整正文不重发为文本增量，避免 ACPX 的会话记录重复追加。子会话完成事件不进入这一根会话结果通道。
- ACPX：只识别这个具名、版本固定的扩展，校验消息身份、阶段和文本类型，转换为 `text_delta.phase` 和 `message_completed`。未识别字段不透传；空字符串正文保留，未知 phase 显式为 null。
- harness-dock 协议升为 2：消息完成事件独立于文本增量；快照的 `messages` 保存按完成事件顺序排列的完整消息，同一消息 ID 不重复追加。`finalAnswer` 是完整消息数组或 null，不把多条消息无边界拼接。
- 仅当执行 result 为 completed、存在明确 final_answer 消息且不存在阶段未知的完整消息时发布 finalAnswer。运行中、取消、失败、结果未知、缺少完整消息或缺少阶段都保持 null。消息完成不能替代执行完成。
- 本次不读取 Codex 私有历史文件补业务结果；真实验收可以只读本次合成实验记录，独立核对 finalAnswer 的正文与阶段。

验收：确定性测试覆盖完成文本与 delta 不同、未知阶段、消息重复、取消后无最终答案、断线快照恢复；真实 Codex 验证过程说明、最终答案及连续两轮不串内容，并重跑原有控制场景。补丁若扩展到会话、权限或恢复状态机，停止扩大补丁范围并重新评估后端。

运行状态和文本暂存内存，存活期间不会清理去重记录；这是有界时长实验的实现，不作为长期服务。ACPX 自身会持久化会话。控制台丢失进程内状态后，可以用已记录 runId 调用 SDK 查询仍存活的 Daemon；未建设持久化控制端账本。

## 参考与实现来源

- [ACPX v0.19.4](https://github.com/openclaw/acpx/tree/v0.19.4)，MIT，SHA `8e396609238086dee6a407fdb3b3ac46dbdedd70`，直接依赖。
- [Codex ACP v2.1.1](https://github.com/agentclientprotocol/codex-acp/tree/v2.1.1)，Apache-2.0，SHA `68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`，直接依赖。
- Happier 固定参考 SHA `50296d6607330a42fe8dc44794eff5f271c3baf5`，仅设计参考，无源码移植与运行依赖。

实现用本地安装包声明与源码核实 API；依赖图由 pnpm-lock.yaml 固定。仓库未选定公开分发许可证，当前仅本地私有实验。
