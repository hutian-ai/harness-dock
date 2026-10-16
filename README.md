# harness-dock

harness-dock 是供 调用方应用 等应用调用的本地 Agent 接入基础设施。每台执行设备运行独立 Daemon，server 管理连接与配对，调用方使用 client SDK；三者可同机或分别部署。人日常使用调用方应用或原生客户端，dock 的本机入口用于安装、配对、权限引导和诊断。当前为私有源码/构建产物，没有发布 npm 或托管云服务。

```text
调用方应用 / 其他中台 ── ServerClient ──→ harness-dock server
                                        ↑ 设备主动连接
                              ┌─────────┴─────────┐
                         家用电脑 Daemon     其他设备 Daemon
                         Codex / ZCode…      Lobi / DeepSeek…
```

正式定位、当前实现、必改项和暂不做的内容见 [独立设备执行范围](docs/standalone-v1.md)。[历史架构图](docs/architecture.html) 保留旧 dockui 候选的背景；该候选已退出本轮产品范围。

- server 拥有设备配对、调用方访问范围和连接转发；每台设备绑定一个控制方。
- Daemon 拥有 Provider 登录、进程、会话、执行证据和本机文件。安装发现与实际协议就绪分别报告。
- 调用方应用 拥有 World、成员、任务、授权及业务结果，只依赖 client SDK。
- 连接断开不重发 prompt、审批或工具。响应丢失保持未知，通过原执行身份查询。
- 设备执行不需要 Docker，不新增账号或 SSO。公网使用校验证书的 WSS，WS 仅允许回环地址。

源码按职责组织 server、daemon、client、protocol、drivers，全部是私有 workspace package。server 可独立运行；daemon 是设备上的命令行程序。

## 本机开始

需要 Node.js 22.19+、pnpm 11.9.0，以及目标 Provider 已完成本机登录。真实执行会访问模型服务。

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p .local/work
pnpm server init .local/control
pnpm daemon init --mode device --home .local/device --cwd .local/work \
  --pairing .local/control/device-pairing.json
pnpm server run .local/control/server.json
# 另一个终端：
pnpm daemon start .local/device/config.json
pnpm demo:devices .local/control/client.json
```

`init` 生成互相独立的设备和应用凭据，文件权限为 0600；不要提交或输出凭据。server 前台运行，云端 server 由 Docker Compose 管理其进程。

控制台命令：`nodes`、`inventory`、`run codex 回复 hello`、`run zcode 回复 hello`、`status`、`allow <审批 ID>`、`deny <审批 ID>`、`reply <审批 ID> <JSON>`、`cancel`、`quit`。多设备时用 `use <nodeId>` 选择设备。原生审批用 `reply <ID> {"optionId":"原始 ID"}`，原生提问用 `reply <ID> {"action":"accept","content":{...}}`；二值 allow 不能替代原生选择。

```sh
pnpm daemon status .local/device/config.json
pnpm daemon logs .local/device/config.json
pnpm daemon stop .local/device/config.json
```

关闭控制台不等于停止执行。Daemon 状态中的 `connected` 表示已连接 server；暂无开机自启。安装、跨网与 调用方应用 配对见 [家用电脑安装](docs/home-install.md)。

## 控制端 SDK

```ts
import { ServerClient } from '@harness-dock/client';

const client = new ServerClient({
  endpoint: 'wss://dock.example.com:48519/', clientId, token,
});
await client.ready;
console.table(client.listNodes()); // 仅返回本调用方获准控制的设备
client.onConnection(node => console.log(node.nodeId, node.connected));
const peer = client.node(nodeId)!;
peer.onRequest('execution.callback', async (input, context) => {
  // 按 runId 绑定已授权的执行；断线/超时会中止本次 callback。
  // ready 在业务准入后确认，permission 默认拒绝。
  return handleAuthorizedCallback(input, context);
});
const inventory = await peer.request('inventory');
// await client.close();
```

`request(method, params, timeoutMs)` 不自动重试。节点方法为 `inventory / prepare / execute / getExecution / events / reconcile / cancel / steer / collect / release / forgetSession`。设备协议 v3，server-client 协议 v1，版本不符明确拒绝。`DeviceController` 是 server 内部的设备入口，也可用于不经过中继的局部集成。

Skill 字节通过 `prepare` 传到设备，结果文件通过 `collect` 回传；`release` 只删除该次输出。`forgetSession` 仅在引用该会话的执行均安全释放后删除托管会话目录，保留执行去重身份。

## 长期资源管理

默认每连接最多 32 个待响应请求、16 个并行处理；消息、累计在途输入和发送分别限制为 64 MiB，发送 deadline 为 60 秒。重连不重置未完成 handler 的额度。

Provider 空闲 10 分钟回收。Codex 可重新加载原 thread；ZCode 目前只有暖会话，回收后续接明确失败。单轮文本上限 8 MiB；过程按条/总字节/数量限制，超限显式标记。终态且 release 后的详细记录保留 7 天，去重身份和未知结果保留。托管目录默认软上限 512 MiB、身份 10 万，达到上限拒绝新准入。后台日志最多 3 个 10 MiB 文件。

这些限制约束本项目的缓存和托管数据，不是 Provider 进程的操作系统内存限额。具体失败语义见 [资源生命周期](docs/resource-lifecycle.md)。

## 引擎与结果

- Codex：固定 ACPX 0.19.4 / Codex ACP 2.1.1，使用设备选择的本机 Codex 安装/home 与原生登录；支持明确的 `final_answer`、严格插话和原 turn 的只读查回。
- ZCode：固定 zcode-acp-server 0.68.2，调用设备上的 ZCode；保留 build 模式审批。已单独完成 macOS ZCode 3.14.5 的真实执行验证，见 [ZCode Driver](docs/zcode-driver.md)。
- Lobi / DeepSeek：复用独立 drivers 中的 ACP 适配器；本机安装、登录及 ACP 插件版本必须通过探测。

文本增量不是权威最终答案。ZCode 不提供精确 `final_answer`，不能将拼接文本冒充这一能力。Provider 支持的能力、探测失败和真实验收证据分别记录。固定补丁见 [补丁说明](patches/README.md)。

## 分发与依赖边界

```sh
pnpm bundle /absolute/new-output-directory
node /absolute/new-output-directory/daemon/dist/cli.js help
node /absolute/new-output-directory/server/dist/cli.js run /absolute/server.json
node /absolute/new-output-directory/controller/dist/device-console.js /absolute/client.json
```

产物包含编译代码和依赖，不含本地认证、会话或实验文件。controller 只依赖 client/protocol、ws、json-rpc-2.0 和 zod，不包含 Provider 依赖。执行端有平台相关的原生依赖，应在目标平台安装；不要将 macOS 的 node_modules 或 daemon bundle 复制到 Linux。

其他 Node.js 应用可使用私有本地依赖：

```sh
npm install --offline --install-links=false --ignore-scripts --no-audit --no-fund /absolute/new-output-directory/controller
```

保留上述产物目录，移动后重新安装。没有 npm registry 发布或自动升级流程。

## 验证与边界

```sh
pnpm check
# 需要已登录的真实模型；只操作隔离实验目录
pnpm accept:codex
pnpm accept:zcode
node --import tsx scripts/accept-bundle.ts /absolute/new-output-directory
```

这不是完整桌面远控软件：鼠标、屏幕及应用操作依赖 Provider 自身工具与操作系统权限。ZCode 桌面 UI 也不是 harness-dock 控制端；当前方向是 Daemon 调用 ZCode Agent。

正式执行链只保留设备 Daemon 和 ServerClient；Driver 是 Daemon 内部的执行模块，见 [Driver 边界](docs/embedded-driver.md)。Provider Docker/Podman 保留实验代码并后置，不作为家用安装门禁。

## 云端部署

server 可单独部署在 Linux ECS 上，由 Docker Compose 管理，Nginx 提供 HTTPS/WSS。设备与应用都主动连接公网入口；Provider 登录和执行仍留在设备本地。部署、证书续期、检查与回退方式见 [ECS 部署](docs/ecs-deployment.md)。
