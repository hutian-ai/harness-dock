# 快速开始

本指南使用预构建的 `server/`、`daemon/`、`controller/` 运行目录，在一台 macOS arm64 机器上完成接入验证。准备 Node.js 22.19+ 和已安装、已登录的 Codex。解压产物后先核对 `release.json` 和 `SHA256SUMS`；摘要检查传输完整性，来源仍须可信。

各命令从这三个目录的共同父目录执行。配置、凭据和状态保存在私有 `.local/` 中，不要提交或共享这些文件。

## 1. 初始化 server

```sh
node server/dist/cli.js init .local/control
node server/dist/cli.js run .local/control/server.json
```

保持该终端运行。`init` 生成 server 配置、设备配对文件和应用凭据，分别授权设备接入和应用访问。默认使用回环 WS。跨机器部署请按 [server 指南](server.md) 设置公开 WSS 入口，不要关闭 TLS 验证。

## 2. 安装执行设备

在另一个终端执行：

```sh
mkdir -p .local/work
node daemon/dist/cli.js setup \
  --cwd "$PWD/.local/work" --home "$PWD/.local/device" \
  --pairing "$PWD/.local/control/device-pairing.json" --bundle "$PWD/daemon"

node .local/device/installation/launch.cjs doctor
node .local/device/installation/launch.cjs status
```

`setup` 初始化、安装并启动 Daemon。相同身份重复 setup 可以继续安装流程；工作目录、配对或 server 冲突时会拒绝覆盖。

`doctor` 默认不发送模型 prompt；`connected` 只表示已连接 server。首次安装需要当前用户登录自启时，在 setup 增加 `--autostart`，详见 [设备维护](device.md)。

## 3. 连接控制端

```sh
node controller/dist/cli.js nodes .local/control/client.json
node controller/dist/cli.js doctor .local/control/client.json
# 显式检查原生 ACP，可能建立协议会话，但不发送模型 prompt：
node controller/dist/cli.js doctor .local/control/client.json --probe
```

每个应用身份只允许一个活动连接。请为诊断使用独立的应用身份，或先断开使用该身份的现有应用。

## 4. 显式验证真实执行

```sh
node controller/dist/cli.js test .local/control/client.json --model <可用模型>
# 交互式验证两轮上下文、合成工具与原生审批：
node controller/dist/cli.js test .local/control/client.json --model <可用模型> --approval
```

测试会发送真实模型请求，使用原生账户额度。`--approval` 需要交互终端，精确返回用户选中的原生 optionId，不自动允许权限。

结果未确认时保存原 runId，再查询：

```sh
node controller/dist/cli.js status .local/control/client.json \
  --node-id <设备UUID> --run-id <原执行UUID>
```

不要通过换 runId 或重发 prompt 判断原任务是否执行。

## 5. 接入应用与停止设备

应用只需安装 SDK 并领取应用凭据，见 [SDK 指南](sdk.md)。随 controller 分发的 `examples/node-client.mjs` 默认只列出设备；增加 `--execute` 才调用模型。

```sh
node .local/device/installation/launch.cjs stop
```

停止通过设备受保护的本地 socket 执行。关闭控制端连接不会停止设备上的执行；升级、回滚与日志读取见 [设备维护](device.md)。
