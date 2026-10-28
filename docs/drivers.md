# Driver 开发

Driver 是设备 Daemon 内部模块，应用通过 client SDK 使用设备，不直接嵌入 Driver。当前受支持的适配是 Codex，执行链为：

`DeviceHost → ProviderAdapters → CodexHost → CodexExecutor → ACPX → Codex ACP → Codex`

## 接口与所有权

ProviderAdapter 提供 inspect、validate、environment、execute、close 和 forgetSession。ProviderAdapters 创建具名适配器并提供只读 reconcile。

- DeviceHost 拥有设备准入、runId 去重、容量、审批归属、持久化与资源管理。
- Driver 选择原生环境、声明能力，处理安装依赖及协议、会话、模式、事件和结果差异。
- environment 是设备端私有的不透明持久化上下文，不是远程指定原生路径的入口。
- reconcile 按原 runId 只读查回；不支持或无完成证据时返回 null，不派发 prompt 或建立替代会话。

公共 wire 类型位于 protocol，并由 client 导出。drivers 不依赖调用方业务类型。原生交互类型与公共类型的兼容性由编译 fixture 校验。

## Codex 环境与执行

使用所选本机安装及 home，dock 状态独立放在 stateDir。保留原生配置、认证、工具、插件、skills 和 memory；调用方内容只使用明确支持的增量入口。

本机 Provider 环境只接受具名代理/证书变量，不继承整个父进程环境，不接受远程命令、home 或权限变量。原生宿主不可用时报告实际限制，不绕过身份、签名或进程链检查。

当前后端固定为 ACPX / Codex ACP，版本见 [依赖清单](../packages/drivers/package.json)。不添加异常时自动切换的并行执行后端。

## 能力、交互和结果

独立声明 sessionResume、resultQuery、exactFinalAnswer、callerSkills、permissionInteractions、desktopTools 和 browser。协议 ready 不代表模型或所有原生工具已执行。

审批保留精确 optionId、form/url、作用域与有效期。投递确认只报告原生协议 ACK。工具结果保留调用方 deliveryContext，未确认投递为 unknown。

工具事实优先复用标准 ACP 事件；drivers 提供有界展示投影，权威消息完成和终态不依赖展示截断。原生 thread/turn 身份、完整消息完成和只读查询采用具名协议接缝，见 [补丁说明](../patches/README.md)。

## 验证要求

确定性测试覆盖身份、审批、取消、迟到回答、状态未知、恢复及进程清理边界；真实 Provider 验证使用隔离身份和合成内容，分别记录结果。

原生安装、配置、登录和用户文件不是清理对象。模拟后端只证明控制边界，不能据此新增对外 Provider 支持。验证方法见 [验证与验收](validation.md)。
