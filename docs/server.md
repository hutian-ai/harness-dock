# 部署 server

server 是自托管的配对与转发服务。设备和应用均主动连接 server；Provider 登录与执行留在设备。远程访问要求可信 TLS 和节点身份校验。

## 初始化与部署文件

从 Linux 候选产物取得 server 运行目录和镜像，准备域名、证书及 Docker Compose。示例中的地址和目录需替换为自己的值。

```sh
node server/dist/cli.js init .local/control --public-endpoint wss://dock.example.com/
node server/dist/cli.js deploy .local/control/server.json \
  --output .local/deployment --image harness-dock-server:<固定版本或提交>
```

init 分别生成 server.json、device-pairing.json 和 client.json。只将设备文件交给设备所有者、应用文件交给应用所有者；server.json 保留在部署端，文件权限为 0600。

deploy 在新目录生成 Compose、环境文件、Nginx 片段和说明，不安装软件、不启动服务或修改现有反代。按生成说明设置配置绝对路径、属主 UID/GID、域名和证书；配置文件属主应与容器用户一致，不放宽文件权限。

## 镜像与启动

使用候选镜像归档时，核对摘要后通过 `docker load -i <image.tar>` 导入。也可在 Linux 构建机以 portable server 目录为上下文构建：

```sh
docker build -t harness-dock-server:<固定版本或提交> server
```

构建上下文只含 server 运行包，不包含源码工作区、Provider 依赖、配置或凭据。镜像可通过私有方式传输，不自动推送 registry。

在生成的部署目录中检查并启动：

```sh
docker compose config --quiet
docker compose up -d
docker compose ps
docker compose logs --tail 50
```

Nginx 片段放在受管理的 http 上下文中，经配置检查后启用。server 回环监听，Nginx 提供公开 WSS；单独维护证书续期。Compose 使用非 root UID/GID、只读根文件系统、受限能力及只读配置挂载。host network 共享宿主网络，不构成网络沙箱。

```sh
node server/dist/cli.js doctor .local/control/server.json
curl --fail https://dock.example.com/healthz
```

doctor 分别验证传输、协议和已加载配置摘要；healthz 不公开配对清单或凭据。健康和设备在线不代表模型执行成功。

## 配对与凭据轮换

```sh
node server/dist/cli.js pair .local/control/server.json list
node server/dist/cli.js pair .local/control/server.json device-add --output /private/new-device.json
node server/dist/cli.js pair .local/control/server.json client-add --output /private/new-client.json
node server/dist/cli.js pair .local/control/server.json grant --node-id <设备UUID> --client <应用UUID>
node server/dist/cli.js pair .local/control/server.json device-rotate --node-id <设备UUID> --output /private/rotated-device.json
```

完整参数由 `node server/dist/cli.js help` 列出。接收方使用不同公开入口时，在 export 或 rotate 指定 `--endpoint`，不将监听地址当作连接地址。

配对命令需要配置属主可写的管理目录以创建临时锁，包括 list。不要在只读配置挂载的运行容器中执行 pair；可在主机或指定同一属主 UID/GID 的独立管理容器中操作。

配置修改返回 pending_restart，表示配置已保存，尚未确认运行服务加载。维护窗口中确认设备和调用方无活动/未决执行，再执行 `docker compose restart server`，运行 doctor 并验证旧凭据被拒绝。不要以删除配置文件代替撤权验证。

## 更新与恢复

更新固定镜像引用后使用 `docker compose up -d`；保留旧镜像和受保护的配置备份以便恢复。切换会断开连接，不自动重派执行或审批。

删除 server 配对只移除接入授权，不删除设备上的执行记录、原生会话或用户文件。生产地址、部署清单和配对文件保存在私有运维目录。
