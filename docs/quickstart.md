# 独立安装与首次验证

当前为未公开发布的开发者 Alpha 候选。使用维护者私下提供的固定版本产物，或经明确触发的 CI candidate artifact；没有公共下载地址，也不需要 npm 发布。设备仅支持 **macOS arm64 + Codex**，server 运行在 Linux。准备 Node.js 22.19+；设备另外安装并登录原生 Codex。普通运行用户不需要 Git、pnpm 或源码构建。

产物中的 `release.json` 标记源码提交、平台、协议和是否属于受支持设备；`SHA256SUMS` 检查传输完整性，不能单独证明发布者身份。macOS 设备包和 Linux server 镜像不能混用。不要在已封存的 daemon 目录运行包管理器。

## 1. server 部署者

解压 server 归档得到 `server/`。准备 Linux、Docker Compose、域名和有效 TLS 证书；本轮采用已有 Nginx 终止 TLS。以下域名、证书和目录都是示例，请替换为自己的值。

```sh
node server/dist/cli.js init .local/control --public-endpoint wss://dock.example.com/
node server/dist/cli.js deploy .local/control/server.json \
  --output .local/deployment --image harness-dock-server:<固定提交或版本>
```

`init` 自动生成设备与应用的独立凭据，两个领取文件直接使用公网 WSS 地址，server 保持回环监听。`deploy` 只生成新目录中的 Compose、`.env`、Nginx 片段和操作说明，**不安装 Docker、不启动或重启服务、不修改现有反代**。

镜像来自 Linux candidate 的 image.tar 时，部署者先用 `docker load -i <image.tar>` 私下导入，按产物记录选择固定镜像。没有镜像归档时，维护者在 Linux 构建机使用 server 包内的 Dockerfile 构建并私下传输；设备用户不承担构建工作。不要把 macOS daemon 的依赖复制到 Linux。

将 `server.json` 私下放到服务器的受保护目录，修改生成的 `.env` 中 `DOCK_CONFIG_FILE`。确认 Compose 的 `user` 与目标主机文件属主 UID/GID 一致，保留 0600 权限。Nginx 片段应放在现有 `http` 上下文中；确认域名和证书路径，检查与既有配置的冲突。非默认证书路径可在生成时传入 `--tls-cert` 和 `--tls-key`。

隔离验收可在 `init` 指定独立的 `--device-port`、`--client-port` 和带端口的公网 WSS 地址。`deploy` 会沿用这三个固定端口，仍要求 server 只监听回环；使用独立 Compose 项目、反代实例和测试身份，不重载现用反代。配置路径中的 `$` 会按 Compose 字面值保留。

准备完成后，由部署者自行选择维护窗口检查 Compose、启动服务及安装/重载 Nginx，再执行：

```sh
node server/dist/cli.js doctor .local/control/server.json
```

`server_transport`、`protocol`、`loaded_configuration` 分别表示传输、协议、当前配对/路由配置摘要匹配；这些均不证明模型已执行。`healthz` 不公开设备、授权清单或凭据。已有旧 server 不提供版本摘要时会明确显示 unknown，不据此推断成功。

## 2. 执行设备用户

私下领取 **本设备的** `device-pairing.json`（0600），不要领取 `server.json` 或应用的 `client.json`。解压匹配的设备包得到 `daemon/`，选择自己的工作目录：

```sh
mkdir -p "$HOME/harness-work"
node daemon/dist/cli.js setup --cwd "$HOME/harness-work" \
  --home "$HOME/.harness-dock/.local/device" \
  --pairing /private/device-pairing.json --bundle ./daemon
```

`setup` 初始化、安装到独立版本目录并启动设备；重新运行相同身份的 setup 可以继续安装流程，不替换身份。选择不同工作目录、配对或 server 时会拒绝覆盖，按原安装入口维护。需要当前用户登录自启时，在首次 setup 显式增加 `--autostart`；它不会变成登录前系统服务，也不唤醒休眠电脑。

```sh
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" doctor
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" status
```

doctor 检查本地配置、Node、平台、工作目录、已有设备连接和 Codex 安装。它不派发模型，不打开第二条同身份设备连接。登录、ACP 协议、模型、浏览器和插件仍分层验证；原生宿主拒绝是限制，不通过改变权限或配置绕过。TLS 验证不关闭；私有 CA 使用设备初始化的 `--ca-file`。

`daemon_configuration` 比对拥有者实际连接的 endpoint 与保存配置；不一致时认证检查也失败。另一个 endpoint 的健康响应不能证明当前 Daemon 已切换成功。

升级、回滚、自启管理继续使用[现有安装与维护流程](home-install.md#升级与回滚)。不要删除状态目录来解决 unknown，也不要按保存的 PID 杀进程。

## 3. 应用开发者与首次执行

领取 **应用的** `client.json`（0600）。解压 controller 包得到 `controller/`，不要向应用分发设备凭据。一个应用身份只允许一个活动连接；首次验证使用专门的应用身份，或在原应用断开后执行。

```sh
node controller/dist/cli.js nodes /private/client.json
node controller/dist/cli.js doctor /private/client.json --node-id <设备UUID>
# 显式探测原生 ACP：可能建立原生协议会话，但不会发送模型 prompt
node controller/dist/cli.js doctor /private/client.json --node-id <设备UUID> --probe
# 显式调用真实模型，会使用原生账户额度
node controller/dist/cli.js test /private/client.json --node-id <设备UUID> --model <原生可用模型>
# 交互式完整测试：两轮上下文 + 无外部副作用的合成工具 + 原生审批投递
node controller/dist/cli.js test /private/client.json --node-id <设备UUID> --model <原生可用模型> --approval
```

审批选项按原生名称列出，用户选择的精确 optionId 原样返回；空输入、非交互终端、失效连接均拒绝。测试不自动允许权限，不验证桌面/浏览器/其他插件。它创建新的合成作业与托管会话，成功后 release/forget；不清理用户文件。失败时输出原 runId，先查询原记录，不能通过再运行 test 重派不明任务：

```sh
node controller/dist/cli.js status /private/client.json --node-id <设备UUID> --run-id <原runId>
```

第三方应用可以安装随包 SDK，无需 registry 或 调用方应用：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /private/harness-dock-sdk-<版本>.tgz
```

可直接查看并运行 `controller/examples/node-client.mjs`，默认只显示节点；`--execute` 才显式进行模型/审批验证。正式应用使用 `ServerClient` 的 `request/onRequest` 接口，并拥有自己的业务准入、原生审批交互和完成收存。公开类型、按能力准入、原执行查回及生命周期见 [SDK 契约](sdk.md)，无需导入 Daemon 或 drivers。

## 4. 后续配对管理

所有命令在配置属主身份下运行。只操作私有文件，不修改正在运行的 server。

```sh
node server/dist/cli.js pair .local/control/server.json list
node server/dist/cli.js pair .local/control/server.json device-add \
  --client <已有应用UUID> --label home-mac --output .local/new-device.json
node server/dist/cli.js pair .local/control/server.json client-add --output .local/new-client.json
node server/dist/cli.js pair .local/control/server.json grant \
  --node-id <设备UUID> --client <目标应用UUID> --from <原应用UUID>
node server/dist/cli.js pair .local/control/server.json device-rotate \
  --node-id <设备UUID> --output .local/rotated-device.json
node server/dist/cli.js pair .local/control/server.json device-remove --node-id <设备UUID>
```

新增应用初始没有设备权限；grant 要求明确提供原控制方，继续保持单控制方。`device-export/client-export` 输出已有接收方文件；`device-rotate/client-rotate` 生成新凭据，要求新的 `--output` 文件。已有文件拒绝覆盖。`client-remove` 只允许删除已经没有设备的应用；先明确转移或取消设备配对。

旧版 server 直接监听公网 TLS、配置中没有 `publicEndpoint` 时，导出/新增/轮换需用 `--endpoint` 指定该接收方的公开 WSS 地址与端口；不会把 `0.0.0.0` 等监听地址当作可连接入口。

输出 `pending_restart` 只表示配置已写入，**撤权尚未确认生效**。在设备活动执行、待审批和 unknown 已妥善处理后，由部署者在维护窗口重启其目标 server，再运行 doctor 比对已加载摘要，并验证旧凭据被拒绝。server 不自动热加载、不自动重派任务；设备端的 Provider、会话和历史不因取消 server 配对而被删除。

## 状态与求助

`doctor --json` 输出可机器读取的分层结果；unknown 不当作成功。server 健康、设备在线、ACP 可用、模型完成和桌面功能是不同状态。默认诊断不附完整日志、私有配置、模型正文、原生 home 或真实服务地址；需要分享时仍应复查去标识内容。

只有维护者开发、从源码构建候选时才需要 Git/pnpm，见 [README](../README.md#本机开始) 和[发布规程](releasing.md)。真实独立设备、干净用户、Linux 当前候选与实际登录自启的验收，分别记录到 [validation.md](validation.md)。
