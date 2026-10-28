# SDK 接入

应用只依赖 `@harness-dock/client`。Provider 的安装发现、登录、进程和本机文件由独立设备 Daemon 管理。当前支持 macOS arm64 上的 Codex，公共接口为具名 Harness 扩展保留边界。

## 安装与连接

使用随候选产物分发的 SDK 归档：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/harness-dock-sdk-0.1.0.tgz
```

应用领取自己的 `client.json`，不持有设备配对凭据。`loadClientOptions` 读取私有文件并处理相对 CA 路径。

```ts
import { ServerClient, loadClientOptions } from '@harness-dock/client';

const client = new ServerClient(await loadClientOptions('.local/client.json'));
await client.ready;
console.table(client.listNodes());
client.onConnection(node => console.log(node.nodeId, node.connected));
```

`listNodes` 仅包含该应用获准访问的设备。每台设备连接一个控制方，每个应用身份只允许一个活动连接。

## 一次执行

```ts
import { randomUUID } from 'node:crypto';

const nodes = client.listNodes();
const peer = nodes.length === 1 ? client.node(nodes[0]!.nodeId) : undefined;
if (!peer?.connected) throw new Error('device_unavailable');

const runId = randomUUID();
const sessionKey = randomUUID();
const daemonId = peer.daemonId;
const remove = peer.onExecutionCallback(async (request, context) => {
  context.signal.throwIfAborted();
  if (request.runId !== runId || context.nodeId !== peer.nodeId || context.daemonId !== daemonId)
    throw new Error('run_not_authorized');
  if (request.kind === 'permission') return 'deny';
  if (request.kind === 'toolCall') throw new Error('caller_tool_not_registered');
  return null;
});

try {
  const inventory = await peer.request('inventory');
  const codex = inventory.providers.find(provider => provider.key === 'codex');
  if (codex?.status !== 'ready') throw new Error('provider_unavailable');
  await peer.request('prepare', { runId, sessionKey, files: [] });
  const response = await peer.request('execute', {
    provider: 'codex', runId, sessionKey, prompt: '回复 hello',
  });
  if (response.result.state === 'completed') {
    console.log(response.result);
    await peer.request('release', { runId });
  }
} finally {
  remove();
  await client.close();
}
```

应用应在派发前持久化 runId、sessionKey 和原输入。上述默认回调拒绝原生审批；实际应用需接入自己的授权与交互界面。只有确定执行结束后才释放托管文件。

## 方法

ServerPeer 和用于直接连接的 DevicePeer 共享方法类型。普通 `request` 按方法推导参数与结果；显式 `request<T>` 可用于调用方自有投影，由调用方保证准确性。类型不替代运行时校验或 server 白名单。

| 方法 | 输入与结果 |
| --- | --- |
| inventory | 可选 refresh；返回安装、协议就绪、能力与活动执行 |
| prepare | runId、可选 sessionKey/files；返回托管目录 |
| execute | provider、runId、prompt 及可选原生配置；返回执行结果 |
| getExecution | 原 runId；返回本地快照或 null |
| events | runId、可选 after；返回有序事件 |
| reconcile | 原 runId；按已保存上下文只读查回，未确认时为 null |
| cancel | 原 runId；只确认取消请求，不等于 cancelled 终态 |
| steer | runId/text；返回 accepted、rejected 或 unknown |
| collect | 原 runId；返回带 SHA256 的输出文件 |
| release | 原 runId；释放已确认结束的托管输出 |
| forgetSession | sessionKey；释放托管会话，保留去重身份与用户文件 |

公共类型包含 DeviceInventory、DeviceExecuteInput、DeviceExecutionResponse、DeviceExecutionSnapshot、DeviceProviderCapabilities、DeviceExecutionCallback 及审批/工具类型。原生扩展字段保留 unknown；使用前按支持的后端校验。

## 原生交互与能力

`onExecutionCallback` 为执行回调提供类型推导；`onRequest` 保留通用传输处理器签名。两个入口共享一个处理器槽位和连接有效期。

- permission：options 精确返回 `{ optionId }`；form/url 返回 `{ action, content? }`。保留原始问题和作用域，不猜测选项或默认 always。
- toolCall：仅执行本应用为本轮注册并授权的工具，返回 `{ content, isError?, deliveryContext? }`。
- permissionDelivered/toolDelivery：确认协议投递；不代表工具成功或业务目标完成。
- ready/event/progress 等：用于准入和观察，不能代替权威终态。

先检查 sessionResume、resultQuery、exactFinalAnswer、callerSkills 和 permissionInteractions。inventory 的 ready 只表示协议探测成功，modelExecutionVerified=false。

## 续接、断线和恢复

相同 runId 与相同输入返回原结果，冲突输入拒绝。sessionKey 与原生会话身份分开；续接须显式传入原生 resumeSessionId 和需要的 previousRunId，不能自动新建替代会话。

SDK 只恢复连接和观察，不自动重发 prompt、工具或审批。断线后先按原 runId 查询 getExecution/events，再按 resultQuery 能力显式 reconcile。null 不证明未执行；缺失完成证据保持 unknown。

Daemon 重启将未完成记录视为 unknown，不恢复进程或旧审批。结果和原生恢复上下文保存在设备端，远端不能指定任意 home、命令或恢复上下文。资源与释放规则见 [资源管理](resource-lifecycle.md)。
