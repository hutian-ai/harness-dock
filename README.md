# harness-dock

harness-dock 是供 调用方应用 等应用调用的本地 Agent 接入基础设施。每台执行设备运行独立 Daemon，server 管理连接与配对，调用方使用 client SDK；三者可同机或分别部署。人日常使用调用方应用或原生客户端，dock 的本机入口用于安装、配对、权限引导和诊断。

**当前仅支持 Codex，设备端支持环境为 macOS arm64。** 项目代码采用 [MIT](LICENSE)，当前为私有分发的开发者 Alpha 候选，没有公开 Release、npm 发布或托管云服务。安装、使用和真实验收入口均以 Codex 为准；其他 Provider 的仓内保留实现不属于当前支持范围，详见支持矩阵。

[支持矩阵](docs/support.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [变更记录](CHANGELOG.md) · [发布与设备验收](docs/releasing.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

Codex 拥有模型循环、工具、插件和原生权限。dock 通过 ACP 与具名薄适配接入 Codex，负责跨设备派发、观察、审批归属和恢复；原生能力接入缺失时明确报告，不在 dock 中另建浏览器、电脑操作或工具宿主。

Harness 内部后续 Agent、工具调用及权限范围继续由 Harness 自己处理。dock 负责正确启动/连接所选原生环境，必要时转发原生审批；当前 Codex 路径经 ACP 启动执行实例，并非接管桌面 App 已运行的聊天。后台实例缺少某项原生依赖时，先核对启动与连接条件，只对已确认的缺口补薄适配；原生拒绝保持如实报告，不据此另建桌面授权机制。

```text
调用方应用 / 其他中台 ── ServerClient ──→ harness-dock server
                                        ↑ 设备主动连接
                              ┌─────────┴─────────┐
                         家用电脑 Daemon     其他设备 Daemon
                              Codex             Codex
```

正式定位、当前实现、必改项和暂不做的内容见 [独立设备执行范围](docs/standalone-v1.md)。[历史架构图](docs/architecture.html) 保留旧 dockui 候选的背景；该候选已退出本轮产品范围。

- server 拥有设备配对、调用方访问范围和连接转发；每台设备绑定一个控制方。
- Daemon 拥有 Provider 登录、进程、会话、执行证据和本机文件。安装发现与实际协议就绪分别报告。
- 调用方应用 拥有 World、成员、任务、授权及业务结果，只依赖 client SDK。
- 连接断开不重发 prompt、审批或工具。响应丢失保持未知，通过原执行身份查询。
- 设备执行不需要 Docker，不新增账号或 SSO。公网使用校验证书的 WSS，WS 仅允许回环地址。

源码按职责组织 server、daemon、client、protocol、drivers，全部是私有 workspace package。server 可独立运行；daemon 是设备上的命令行程序。

Codex 使用本机选择的安装/home，保留原生配置、登录、插件与记忆；业务 MCP/skill 增量附加。真实模型、冷续接、原生浏览器和精确 options/form/url 分别有具名 Local 证据。独立 LaunchAgent 的桌面 MCP 存在原生进程链授权拒绝，应用重启后的原 thread 续接和全部插件功能尚未验收；当前支持与历史证据分别见 [支持矩阵](docs/support.md) 和 [验证记录](docs/validation.md)。

## 本机开始

需要 macOS arm64、Node.js 22.19+、pnpm 12.15.0，以及已安装并完成本机登录的 Codex。真实执行会访问模型服务。

首次安装或从 pnpm 11 升级时，先通过 `npm install --global pnpm@12.15.0` 完成 pnpm 原生执行文件安装，再运行下面的命令。不要跳过该工具自身的安装脚本。

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

控制台命令：`nodes`、`inventory`、`run codex 回复 hello`、`status`、`allow <审批 ID>`、`deny <审批 ID>`、`reply <审批 ID> <JSON>`、`cancel`、`quit`。多设备时用 `use <nodeId>` 选择设备。原生审批用 `reply <ID> {"optionId":"原始 ID"}`，原生提问用 `reply <ID> {"action":"accept","content":{...}}`；二值 allow 不能替代原生选择。

```sh
pnpm daemon status .local/device/config.json
pnpm daemon logs .local/device/config.json
pnpm daemon stop .local/device/config.json
```

关闭控制台不等于停止执行。Daemon 状态中的 `connected` 表示已连接 server；macOS 可显式启用当前用户登录自启。安装、跨网与 调用方应用 配对见 [家用电脑安装](docs/home-install.md)。

本机所有者可在受保护的设备配置中为每个 Provider 选择代理和证书依赖，例如：

```json
{
  "providers": {
    "codex": {
      "environment": {
        "HTTPS_PROXY": "http://proxy.example:8080",
        "NODE_EXTRA_CA_CERTS": "/absolute/local-ca.pem"
      }
    }
  }
}
```

允许 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY` 及其小写形式，以及 `NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / SSL_CERT_DIR / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE`。值为不含 NUL、最多 16 KiB 的字符串；非空选择要求 POSIX 配置归当前用户所有且无组/其他用户权限，建议 0600。前台和自启动读取同一配置，依赖值不复制到 LaunchAgent 或安装记录，也不出现在 inventory/status 中。不自动继承整个终端环境；远程执行不能传任意环境值、home、命令或权限变量。

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

inventory 保留原有 `inspection`，并增量提供 `capabilities` 与 `readiness`。`ready` 和 `readiness.level=protocol` 表示已完成协议探测，`modelExecutionVerified=false`；不代表已执行模型、浏览器或全部插件。续接、查回、精确最终答案、附加 skill、原生交互及桌面宿主分别报告，真实动作证据见验证记录。

`request(method, params, timeoutMs)` 不自动重试。节点方法为 `inventory / prepare / execute / getExecution / events / reconcile / cancel / steer / collect / release / forgetSession`。设备协议 v3，server-client 协议 v1，版本不符明确拒绝。`DeviceController` 是 server 内部的设备入口，也可用于不经过中继的局部集成。

Skill 字节通过 `prepare` 传到设备，执行前按 `capabilities.callerSkills` 校验；结果文件通过 `collect` 回传；`release` 只删除该次输出。`forgetSession` 仅在引用该会话的执行均安全释放后删除托管会话目录，保留执行去重身份。

## 长期资源管理

默认每连接最多 32 个待响应请求、16 个并行处理；消息、累计在途输入和发送分别限制为 64 MiB，发送 deadline 为 60 秒。重连不重置未完成 handler 的额度。

Provider 空闲 10 分钟回收。Codex 可重新加载原 thread；单轮文本上限 8 MiB；过程按条/总字节/数量限制，超限显式标记。终态且 release 后的详细记录保留 7 天，去重身份和未知结果保留。托管目录默认软上限 512 MiB、身份 10 万，达到上限拒绝新准入。后台日志最多 3 个 10 MiB 文件。

这些限制约束本项目的缓存和托管数据，不是 Provider 进程的操作系统内存限额。具体失败语义见 [资源生命周期](docs/resource-lifecycle.md)。

## Codex 执行与结果

Codex 使用固定 ACPX 0.21.1 / Codex ACP 2.1.1，以及设备选择的本机 Codex 安装/home 与原生登录；支持明确的 `final_answer`、严格插话和原 turn 的只读查回。

文本增量不是权威最终答案。Provider 支持的能力、探测失败和真实验收证据分别记录。固定补丁见 [补丁说明](patches/README.md)。

## 分发与依赖边界

```sh
pnpm bundle /absolute/new-output-directory
node /absolute/new-output-directory/daemon/dist/cli.js help
node /absolute/new-output-directory/server/dist/cli.js run /absolute/server.json
node /absolute/new-output-directory/controller/dist/device-console.js /absolute/client.json
```

产物包含编译代码、锁定依赖、项目许可证和按实际平台生成的第三方许可索引，不含本地认证、会话或实验文件。daemon/controller/server 是可直接运行的完整目录；controller.tgz 是包含传递依赖与许可说明的 npm 离线安装包。controller 只依赖 client/protocol、ws、json-rpc-2.0 和 zod，不包含 Provider 依赖。执行端有平台相关的原生依赖，应在目标平台安装；不要将 macOS 的 node_modules 或 daemon bundle 复制到 Linux。

其他 Node.js 应用可使用私有本地依赖：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/new-output-directory/controller.tgz
```

SDK 安装后不依赖原产物目录；在保留归档的前提下可使用 npm ci --offline 重装。运行目录的依赖由源码根冻结锁文件构建，更新依赖时重新构建产物；不要在已封存的 daemon release 中运行包管理器。设备端支持将 daemon bundle 安装到独立版本目录，并通过固定入口显式升级或回滚；macOS 可注册用户登录自启，见 [家用安装与维护](docs/home-install.md)。没有 npm registry 发布或无人值守自动更新。

## 验证与边界

```sh
pnpm check
# 仓外离线安装验证，不需要 Provider 登录或模型账户：
node --import tsx scripts/accept-bundle.ts /absolute/new-output-directory --offline
# 需要已登录的真实模型；只操作隔离实验目录
pnpm accept:codex
node --import tsx scripts/accept-bundle.ts /absolute/new-output-directory
```

上述验收命令包含构建，请串行执行。真实 Codex 验收与离线安装分别记录，不将协议探测或离线安装通过视为真实模型、浏览器和全部插件通过。

这不是完整桌面远控软件：鼠标、屏幕及应用操作依赖 Provider 自身工具与操作系统权限。

正式执行链只保留设备 Daemon 和 ServerClient；Driver 是 Daemon 内部的执行模块，见 [Driver 边界](docs/embedded-driver.md)。ContainerHarness 已退出 drivers 普通导出入口，Provider Docker/Podman 保留实验代码并后置，不作为家用安装门禁。

## 云端部署

server 可单独部署在 Linux ECS 上，由 Docker Compose 管理，Nginx 提供 HTTPS/WSS。设备与应用都主动连接公网入口；Provider 登录和执行仍留在设备本地。部署、证书续期、检查与回退方式见 [ECS 部署](docs/ecs-deployment.md)。
