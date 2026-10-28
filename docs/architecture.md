# 架构与执行契约

harness-dock 为调用方提供跨机器 Harness 接入，分为 client、server、daemon、drivers 和 protocol 五个模块。当前具名适配使用 ACPX / Codex ACP 连接设备上的 Codex。

## 职责与信任

| 模块 | 拥有的状态 | 边界 |
| --- | --- | --- |
| client | 连接、请求关联、回调有效期 | 不管理 Provider 进程、登录或本机目录 |
| server | 设备配对、应用授权范围、连接转发 | 不承接业务调度或替设备裁决执行完成 |
| daemon | 准入、Provider 进程、待批请求、执行记录和托管文件 | 生命周期独立于连接 |
| drivers | 安装/环境选择、原生协议与结果差异 | 复用 Harness 原生工具和权限 |
| protocol | 公共 JSON 类型、版本、身份和预算 | 不引入调用方业务模型 |

server 是受信任的转发节点，TLS 不提供针对 server 的端到端内容保密。配对凭据分别用于设备接入和应用访问。远程传输必须校验证书和节点身份，明文仅限回环。

设备协议为 v3，server-client 协议为 v1；版本不匹配明确拒绝。每台设备绑定一个控制方，应用授权声明可访问的节点。

## 身份与状态

- nodeId：稳定的设备身份；daemonId：本次 Daemon 实例身份。
- runId：调用方生成的单轮执行身份，与原输入绑定并持久去重。
- sessionKey：dock 托管会话身份，与原生 thread/session ID 分离。
- 原生续接身份：由已支持后端返回，后续执行显式提交。

执行状态为 running、completed、failed、cancelled 或 unknown。缺少权威完成证据时保持 unknown；取消请求、观察文本或传输成功不能替代终态证据。

## 执行与恢复

调用方先 prepare，再显式 execute。Daemon 负责准入、设备容量与本机会话互斥；相同原生会话不并发续接，不同会话按设备容量隔离。

Provider 进程与待批审批归 Daemon 所有。SDK/server 连接断开不会转移所有权，也不重放请求或决定。迟到审批失效，调用方必须响应 AbortSignal。

原生恢复上下文由 Driver 产生和解释，Daemon 只保存不透明内容。reconcile 从原记录选择 Provider 与上下文，只读查询原执行，不重新发现安装、不建立替代会话或发送 prompt。没有证据时仍为 unknown。

## 原生环境

Codex 使用设备明确选择的安装、home、配置与登录。dock 状态独立保存，不改写原生认证或配置；调用方 skills 通过受支持的附加根增量接入。

Harness 拥有内部 Agent、模型循环、原生工具、MCP、插件、skills、memory 与权限规则。dock 连接必要宿主并转发原生交互，不能把共享 home、设备配对或新进程视为继承所有系统授权。

应用承担业务授权、数据来源授权、审批界面和最终结果验收。dock 不提供聊天、IDE、插件商店或业务权限系统。

## 扩展 Harness

公开接口通用，不代表任意 ACP Harness 已获支持。新增支持须实现具名 Driver，并验证安装选择、环境依赖、模型/模式、审批、会话、取消和只读结果语义。

Driver 的接口与维护约定见 [Driver 开发](drivers.md)。当前支持承诺见 [支持范围](support.md)。
