# 设备安装与维护

执行设备当前支持 macOS arm64 + Codex，需要 Node.js 22.19+ 和已登录的原生 Codex。普通用户使用匹配平台的 daemon 运行包，不需要 Git 或 pnpm。

## 安装

私下领取本设备的 device-pairing.json，保持文件仅属主可读写。应用凭据与设备凭据分别发放，不要混用。

```sh
mkdir -p "$HOME/harness-work"
node daemon/dist/cli.js setup \
  --cwd "$HOME/harness-work" --home "$HOME/.harness-dock/.local/device" \
  --pairing /private/device-pairing.json --bundle ./daemon
```

setup 安装到独立版本目录并启动设备；相同身份可以继续 setup，配置冲突拒绝覆盖。首次安装如需用户登录自启，显式增加 `--autostart`。

以下命令使用固定安装入口：

```sh
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" doctor
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" status
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" logs
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" stop
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" start
```

doctor 默认不发送模型。connected 只表示 server 连接，安装、原生 ACP、模型执行和工具可用性分别确认。管理通过设备受保护的本地 socket 完成，不按保存的 PID 发送信号。

## 自启

```sh
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" autostart
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" autostart --disable
```

自启使用当前用户的 macOS LaunchAgent，在用户登录后生效；不提供登录前系统服务或唤醒休眠设备。正常 stop 不会被异常重启策略立即拉起。关闭自启会在安全停机后移除本设备注册，不删除配置或 Provider 数据。

## 升级与回滚

从可信来源领取匹配平台的 daemon 包，核对来源、版本和摘要：

```sh
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" upgrade --bundle /absolute/new/daemon
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" status
# 显式切回 previous：
node "$HOME/.harness-dock/.local/device/installation/launch.cjs" rollback
```

活动执行、维护或 unknown 会阻止版本切换。不要清库、强杀或标记成功来绕过；先按原身份查询未确认执行。

升级校验并暂存产物，再由拥有者检查空闲并切换。启动失败会报告是否确认恢复原版本，结果未确认时查 status/logs，不重发任务。回滚仅切换程序，不回滚数据库、用户文件或已发生的外部效果；协议/状态格式不兼容时拒绝。

保持配置和安装路径稳定，不在封存的版本目录运行包管理器。替换 Node 时使用 `upgrade --node /absolute/node` 更新固定入口。原生 home、登录、配置、会话与用户工作目录独立于程序版本。

## 本机网络依赖

设备配置的 providers.codex.environment 仅接受 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY 及其小写形式，以及 NODE_EXTRA_CA_CERTS、SSL_CERT_FILE、SSL_CERT_DIR、REQUESTS_CA_BUNDLE、CURL_CA_BUNDLE。每值最多 16 KiB 且不含 NUL；配置文件须由当前用户持有且无组/其他用户权限。

TLS 私有 CA 使用初始化的 `--ca-file`。不关闭证书验证，不复制整个终端环境，不将临时原生宿主端点写入自启配置。
