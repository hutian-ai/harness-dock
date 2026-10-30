# harness-dock

**让你的应用，调用原生执行能力。**

让应用、Agent 和自动化服务通过 SDK 调用其他机器上的原生 Harness，将任务、原生审批和结果接入自己的业务流程。Harness Dock 封装设备接入与执行管理，复用原生安装、登录和工具环境；应用负责业务交互、授权与结果验收。

[下载 macOS 客户端](https://github.com/hutian-ai/harness-dock/releases/download/v0.1.0/harness-dock-panel-0.1.0-darwin-arm64.zip) · [文档站](https://hutian-ai.github.io/harness-dock/) · [版本说明](https://github.com/hutian-ai/harness-dock/releases/tag/v0.1.0)

## 它怎么工作

```mermaid
flowchart LR
  A["任务发起方<br/>应用 / Agent / 自动化"] <-->|"连接 SDK"| S["Dock Server"]
  subgraph DEVICE["执行设备"]
    D["独立设备后台"] <-->|"ACP 协议"| H["原生 Harness"]
  end
  S <--> D
```

设备主动连接服务端，任务、权限确认和结果沿连接双向传递。应用负责业务交互与结果验收，原生 Harness 负责执行与工具权限。

## 支持哪些 Harness

统一接入不同 Harness 是产品方向，当前安装包只包含 Codex。

| 原生 Harness | 支持状态 |
| --- | --- |
| Codex | 已支持：macOS 13+、Apple Silicon |
| dsh | 计划接入 |
| zcode | 计划接入 |
| opencode | 计划接入 |

具体工具能力取决于原生环境和权限。完整平台与能力边界见[支持范围](https://hutian-ai.github.io/harness-dock/support/)。

## 开始使用

1. **安装客户端**：下载并解压 ZIP，将 `Harness Dock.app` 拖入“应用程序”目录，打开客户端。
2. **准备 Codex**：在这台 Mac 上安装并登录 Codex。
3. **连接设备**：打开管理员提供的邀请链接，在客户端核对服务地址并连接。
4. **测试并使用**：点击“测试 Codex”检查本机执行，再回到接入的应用发起任务。

客户端自带运行时和独立后台，设备接入通过面板完成。测试会使用一次模型请求额度，通过不代表全部工具均已验证。详细步骤见[安装指南](https://hutian-ai.github.io/harness-dock/installation/)。

当前为 **v0.1.0 Developer Alpha**，仅有 ad-hoc 签名，尚未完成 Developer ID 签名与 Apple 公证；安装限制见[版本说明](https://github.com/hutian-ai/harness-dock/releases/tag/v0.1.0)。

## 你想从哪里开始

- [把这台电脑接进来](https://hutian-ai.github.io/harness-dock/installation/)：安装客户端，用邀请链接连接设备。
- [把原生 Harness 接进我的应用](https://hutian-ai.github.io/harness-dock/sdk/)：通过 TypeScript SDK 发任务、收结果。
- [自己部署连接服务](https://hutian-ai.github.io/harness-dock/server/)：在 Linux 上自托管服务端，连接应用与设备。

想了解选型？看[如何选择远程控制、原生 SDK 与 Dock](https://hutian-ai.github.io/harness-dock/overview/#when-to-use)。

## 开发与贡献

源码构建和验证见[开发指南](https://hutian-ai.github.io/harness-dock/verification/)，深入了解 [架构](https://hutian-ai.github.io/harness-dock/architecture/) 与 [ACP 分层](https://hutian-ai.github.io/harness-dock/drivers/)。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

源码采用 [MIT](LICENSE)，依赖许可见[第三方说明](THIRD_PARTY_NOTICES.md)。workspace 包保持 private，未发布到 npm。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。
