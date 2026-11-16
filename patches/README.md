# 协议补丁

补丁绑定 ACPX 0.22.0、Codex ACP 2.3.0 和 fs-safe 0.27.2，由 pnpm patchedDependencies 安装。分发包携带实际补丁、上游许可证及来源；依赖升级须重新核对补丁应用和原生行为。

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

只保留受管连接上的扩展请求、审批/表单响应的本地写入回执、严格环境允许列表。ACPX 补丁不包含 Codex 名称、Dock 操作、原始事件包装或模式投影。精确 optionId、基础子进程环境传递、会话启动期限和协议消息观察使用上游接口。

ACPX 0.22.0 已包含上游 [#914](https://github.com/openclaw/acpx/pull/914) 的会话启动超时和 [#915](https://github.com/openclaw/acpx/pull/915) 的消息观察，因此已删除对应本地补丁。审批/表单写入回执的 [#916](https://github.com/openclaw/acpx/pull/916) 关闭但未合入，当前仍需保留 responseSent 接缝；其余补丁也只在上游具备等价语义后移除。

进程环境只包含明确允许的原生依赖，阻止父应用凭据意外继承。responseSent 只证明本地传输写入完成，不证明 Agent 收到或接受，也不保证工具成功。拒绝回执不证明未送达，不能据此自动重试。

### 已移回 Driver 或删除

| 原补丁 | 当前归属 |
| --- | --- |
| rawSessionUpdates 与 session_update 事件联合类型 | `packages/drivers/src/acp-updates.ts` 使用上游 onAcpMessage，只为 Driver 消费的更新关联原始 metadata；标准化和事件队列仍归 ACPX |
| modes/session_modes 类型、投影与持久化 | 删除；当前权限目录和选择验证统一读取标准 configOptions |
| dockControl 的 inspect/read_turn/steer 分支、Codex agent 选择和 thread 参数 | `packages/drivers/src/codex-control.ts`；调用方仅使用具名 Codex 命令，通用传输能力不暴露给远程消费者 |
| Codex ACP 恢复时并行读取配置与 modelProvider | 删除非必要性能改动，沿用上游恢复流程 |

Driver 仅关联 session_info_update、工具更新和非空文本更新。上游忽略的空/非文本更新不占关联队列；其他标准事件直接通过。关联按线序验证 tag 和消息/工具身份，保留子会话身份供具名 Driver 校验。队列有数量/字节上限，错序、缺项或溢出终止原执行，不猜测匹配。结束和取消清空状态；原始数据不持久化、不进入设备展示投影。这里依赖 ACPX 0.22.0 的标准化行为，升级须重验关联契约。

### 上游贡献评估：能力缺口不等于产品需求

下表首先记录 Dock 当前的技术依赖，不代表上游功能优先级或已成立的 PR。外层拿不到某个钩子，只能证明本地实现需要接缝，不能证明 ACPX 应永久提供它。通用命名、可复用代码和本地测试通过都不能替代上游用户价值论证。

评估依据是 ACPX 的 [VISION](https://github.com/openclaw/acpx/blob/main/VISION.md)：轻量 ACP CLI 和可嵌入后端，以互操作、可靠性、会话和生命周期为核心；新增公共约定需要承担长期兼容成本。按 [CONTRIBUTING](https://github.com/openclaw/acpx/blob/main/CONTRIBUTING.md)，较大的 API/架构变动先讨论 issue。需要补齐目标 ACPX 用户、具体使用路径、现有功能为何不足、是否属于已有契约缺陷、一般化边界及兼容维护成本，才能决定是否提实现 PR。其他使用者的场景尚未核实时明确标为假设，不把 Dock 的单一场景当作已证实的共同需求。

| 上游 | 当前判断 | Dock 的技术依赖 | 上游视角的下一步 |
| --- | --- | --- | --- |
| ACPX | 受管连接扩展请求：可讨论，尚非可提交的功能设计 | 公开 runtime 未提供访问当前活动 turn/空闲会话连接的入口；另建连接不能继承原 turn 的身份与权限生命周期 | 可嵌入后端的扩展性符合定位，但当前 active-turn/session/agent 三种 scope 来自 Dock 的使用路径。先核实其他集成者的具体需求，讨论是否提供扩展入口、如何保留队列/生命周期约束及是否也支持 shared runtime。当前 requestExtension 仅是本地原型，不能直接认定为上游 API；不认识 Provider 或 Dock 是必要条件，不是充分条件 |
| ACPX | 严格子进程环境：Dock 的额外隔离需求，上游价值待验证 | 当前 allow 仍附带 essentials、LC_/XDG_ 和 ACPX_AUTH_*；Dock 不希望父进程的全部 ACPX grants 自动属于当前执行 | 上游 [#897](https://github.com/openclaw/acpx/pull/897) 有意保留 process essentials 和显式 auth grants，不能把这一契约叫作缺陷。先评估调用方进程环境边界；若能证明同进程多租户嵌入等独立场景，再讨论 opt-in exact/strict 模式及复杂度。不能直接修改原有 allow/block 语义，不因 Dock 需要而默认推荐上游加开关 |
| ACPX | 暂缓：响应本地写入回执 | 观察回调在写入前发生，Driver 无法证明实际 write 完成；不能用返回决定或后续工具事件冒充 | 已有 [#916](https://github.com/openclaw/acpx/pull/916)。[维护者明确暂缓并关闭](https://github.com/openclaw/acpx/pull/916#issuecomment-6650443230)，原因是公共投递语义尚未决定，不是已知技术缺陷。保留本地必要接缝，不重复开实现 PR；待维护者重新讨论 API。测试需覆盖真实 stdio 背压、取消后仍可能送达、写失败与连接替换 |
| Codex ACP | 摘要配置：有独立用户反馈，已有开放 PR，不新开重复 PR | 当前 main 的 sendPrompt 仍用 auto 覆盖 CODEX_CONFIG.model_reasoning_summary；本地补丁读取的是 CODEX_CONFIG 对象，并未另外解析原生 config.toml | 独立反馈是 [#294](https://github.com/agentclientprotocol/codex-acp/issues/294)，已有开放 [#296](https://github.com/agentclientprotocol/codex-acp/pull/296) 和 [#298](https://github.com/agentclientprotocol/codex-acp/pull/298)。若贡献，先与现有作者协调，补当前主干复现、兼容 guard 和测试；不增加环境开关或把摘要设置与 raw reasoning 策略混在一起 |
| Codex ACP | 附加 skills root、原生启动参数：集成需求待论证 | skillsExtraRootsSet 和 app-server spawn 在 adapter 内，公开接口缺少这两个具名输入 | 先核实该 adapter 的配置边界和已有替代入口；两个独立 API 设计均需解释对普通 adapter 用户的价值与维护成本。Dock 的根目录选择和桌面启动策略留在 Driver，不把当前环境变量名称当作上游接口提案 |
| Codex ACP / ACP | 优先推进已有设计讨论：非 AIR 消息完成语义 | 普通客户端拿不到 AIR 专属 phase 元数据，也没有携带原生身份和完整文本的独立完成事件 | 已有本贡献者的 [#637](https://github.com/agentclientprotocol/codex-acp/issues/637)，当前开放且暂无回复。保留消息原始语义符合 adapter 的翻译职责，优先讨论 opt-in、通用 namespace、实时/回放和 v1/v2 一致性。不得把 commentary 映射成 thought 来替代 phase（[#169 的维护者回复](https://github.com/agentclientprotocol/codex-acp/issues/169#issuecomment-4809547296)）；不提交 Dock 展示策略 |
| Codex ACP / ACP | 进一步讨论：精确只读查询与 turn 绑定 steering | session/load 会恢复并回放；现有 steering 的 idleBehavior 只控制空闲 fallback，没有调用方指定目标 turn 的公共字段 | 只读查询已有本贡献者的 [#638](https://github.com/agentclientprotocol/codex-acp/issues/638)，当前开放且暂无回复。相较消息语义，它引入新的查询面和未加载历史访问，需要先确定接口职责及边界。steering 优先扩展已有方法，并先解决客户端如何获得/表示目标 turn；遵循现有 [steering 契约](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md)，不能仅因 Dock 需要而再加一套控制入口 |

Codex ACP 的源码核对以当前 main 和发布包为准，不能用本仓库固定的 2.3.0 补丁反推上游仍有同一缺陷。缺少文本 delta 时的完整回复 fallback 已由当前 main 和 2.6.0 的 `flushAgentMessageText` 覆盖；虽有旧开放 [#266](https://github.com/agentclientprotocol/codex-acp/pull/266) 和 [#500](https://github.com/agentclientprotocol/codex-acp/pull/500)，不再把它列为新修复机会。该 fallback 仍不是独立的消息完成事件，因此不等价于 #637。

### 留在本仓库

原生环境选择、具名 Codex/dsh 命令、thread/turn 校验、结果接受规则、展示过滤/截断、工具增量合并、原始 reasoning 不外露策略都归具名 Driver。若策略依赖 adapter 当前丢失的来源信息，保留最小 producer 接缝，并优先请求来源标记，不能把 Dock 的完整策略推给上游。

严格环境过滤目前仍保留小补丁。将 ACPX 整体移入净化环境的 worker 可以避免该补丁，但会增加进程与取消/回调管理，本轮未采用。保留本地补丁不意味着上游有义务提供替代能力；外层存在合理实现时，应结合完整运行成本选择。若将来上游接受并提供等价严格模式，再删除接缝。

## Windows 长路径

`@openclaw/fs-safe@0.27.2` 的临时目录创建在调用 Windows `mkdtemp` 时使用 extended-length path，随后恢复原路径命名空间，继续执行上游的路径别名、目录身份与清理校验。用于修复 ACPX 会话状态路径超过 MAX_PATH 时的 `ENAMETOOLONG`；Codex 和 dsh 共用该依赖。Windows 回归测试通过实际 ACP 会话保存、关闭和重新读取验证，不发送模型 prompt。ACPX 升级到 0.22.0 后将同一接缝迁移至 fs-safe 0.27.2；新版本仍直接调用 mkdtemp，故继续保留。上游修复后移除此补丁。

## 维护与删除条件

这些本地接缝不是任意 RPC 代理。原始 reasoning、文件补丁和二进制结果不进入受限展示 metadata；原始信封由 drivers 解码，具体契约见 [Driver 开发](../apps/docs-site/README.md#drivers)。

升级时核对固定依赖、补丁逆向检查、公开类型、审批、精确结果、取消、续接、恢复和进程清理。上游提供等价接口后删除对应接缝，不能用会话加载代替只读查询，或用异常 fallback 绕过原生语义。

验证方法见 [验证与验收](../apps/docs-site/README.md#verification)，许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
