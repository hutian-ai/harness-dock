# SDK 接入契约

harness-dock 为应用、Agent 和自动化流程提供跨机器的原生 Harness 接入。调用方只依赖 `@harness-dock/client`，不依赖 调用方应用、Daemon 或 drivers。当前受支持的设备组合仍为 macOS arm64 + Codex；通用 SDK 不保证任意 ACP Harness 已可使用。

安装与凭据领取见 [快速开始](quickstart.md)。每台设备一个控制方，每个应用身份一个活动连接；业务授权、审批交互和结果验收由调用方拥有，原生工具与权限由 Harness 拥有。

## 方法与类型

```ts
import { ServerClient, type DeviceExecuteInput, type ExecutionCallbackHandler } from '@harness-dock/client';

const client = new ServerClient({ endpoint, clientId, token });
await client.ready;
const peer = client.node(nodeId);
if (!peer?.connected) throw new Error('device_unavailable');
const inventory = await peer.request('inventory'); // DeviceInventory
const provider = inventory.providers.find(item => item.key === selectedProvider);
if (provider?.status !== 'ready') throw new Error('provider_unavailable');
const input: DeviceExecuteInput = { provider: provider.key, runId, sessionKey, prompt };
// 按业务准入绑定回调后，显式 prepare/execute。重连不调用这两步。
```

方法名推导参数和结果，ServerPeer 与直接集成的 DevicePeer 使用同一契约。缺少 runId、错误参数及未知方法在普通 TypeScript 调用中报错。既有显式 `request<T>(method, params)` 保留，由调用方承担自选类型的准确性；它不扩大 server 的方法白名单，也不替代运行时校验。JavaScript 调用方仍受既有设备准入校验约束。

| 方法 | 主要输入 | 返回与边界 |
| --- | --- | --- |
| inventory | 可选 refresh | 安装、协议就绪、能力、容量和活动执行；ready 不等于模型已执行 |
| prepare | runId、可选 sessionKey/files | 固定工作根与托管 skill/output 目录；不能指定任意宿主路径 |
| execute | provider、runId、prompt 及原生配置/续接身份 | provider/result；result.state 是技术执行结果，其他字段由原生后端提供 |
| getExecution | runId | 本地执行快照或 null；断线后先按原身份查回 |
| events | runId、可选 after | 有序事件页；截断和详情过期单独报告 |
| reconcile | 原 runId | 原生只读查回或 null；null 包含不支持/没有确认结果，不能推断未执行 |
| cancel / steer | 原 runId，steer 另需 text | 请求取消或插话回执；accepted/requested 不等于最终完成 |
| collect | runId | 带 SHA256 的本轮输出文件 |
| release | runId | 删除已确认结束的本轮托管输出；unknown 拒绝释放 |
| forgetSession | sessionKey | 安全释放后删除托管会话，保留执行去重身份和用户文件 |

`DeviceExecuteInput`、`DeviceExecutionSnapshot`、`DeviceExecutionResponse`、`DeviceProviderCapabilities`、`DevicePermissionRequest/Decision`、`DeviceExecutionCallback`、`DeviceToolCall/Result` 等均从 client 导出。公共类型不引入 Provider 执行依赖。原生 inspection/result/event 的扩展字段保留 unknown，调用方先检查能力，再按已支持后端解析；不将 Codex 的 threadId、turnId、final_answer 强加给所有 Harness。

## 能力与回调

`sessionResume`、`resultQuery`、`exactFinalAnswer`、`callerSkills` 和 `permissionInteractions` 分别声明。缺少能力时拒绝相应业务操作或报告不支持，不能通过新建会话、重发 prompt 或扩权补齐。模型目录、模式和原生账户仍以目标设备为准。

```ts
const handler: ExecutionCallbackHandler = async (request, context) => {
  context.signal.throwIfAborted();
  // 必须核对本应用实际准入的 runId、nodeId、daemonId。
  if (!ownsAuthorizedRun(request.runId, context)) throw new Error('run_not_authorized');
  if (request.kind === 'permission') return 'deny'; // 默认拒绝；不自动选择选项
  if (request.kind === 'toolCall') throw new Error('caller_tool_not_registered');
  return null;
};
const remove = peer.onExecutionCallback(handler);
```

此处函数/身份变量由接入方提供，示例不会派发任务。原生 options 使用 `{ optionId }` 精确返回；form/url 使用 `{ action, content? }`。不能把多选交互压成二值 allow，更不能默认选择 always。`permissionDelivered.success` 是原生响应投递确认；工具 delivery 的 delivered 是协议 ACK，均不代表业务目标已完成。断线/迟到回答失效。

`onExecutionCallback` 提供类型化的执行回调；原有 `onRequest(method, DeviceRequestHandler)` 保留 unknown 输入与原签名，已有应用的传输包装和测试替身可继续使用。两者共享相同的单一处理器槽位、连接有效期与审批边界。

## 执行身份与恢复

调用方在首次派发前保存 runId、sessionKey 和输入；runId 与单轮输入绑定，相同输入查回原结果，冲突拒绝。sessionKey 与原生会话身份分开，续接必须显式指定；连接恢复不恢复业务执行。

SDK 断线后只恢复连接与观察。应用先调用 getExecution/events，具备 resultQuery 能力时可显式 reconcile 原 runId。没有完成证据则保留 unknown；不能换一个 runId 重发以探测是否执行。Daemon 重启将未完成记录标为 unknown，不恢复进程或待批审批。原生恢复上下文只在设备端保存，不返回 SDK，也不能由远端指定。

类型推导、协议测试、仓外 SDK 安装和真实 Harness 执行分别构成不同证据，见 [验证记录](validation.md)。新增 Harness 仍需具名适配和真实验证；合成后端只证明控制边界。
