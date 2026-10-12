# 用 Docker Compose 运行云端 server

## 范围与切换方案

Linux 云端 server 可由 Docker Compose 管理。设备上的 Daemon 与 Provider 继续宿主机运行；不改变协议、配对凭据、执行恢复或审批语义。Nginx 和证书续期由宿主机管理。本文的目录、项目名和域名均为可替换示例，实际配置留在私有运维记录中。

- Docker 使用 `restart: unless-stopped`，不叠加 PM2 或另一个管理同一应用的 systemd 服务；Docker 服务本身须随系统启动。
- 服务无数据库和运行态目录，只读挂载 0600 server.json，容器使用配置所属的非 root UID/GID。
- 使用 Linux host network，应用仅绑定 127.0.0.1:48518/48519，Nginx 提供公网 WSS。该容器共享宿主网络，不宣称具备网络沙箱隔离。不挂载 Docker socket，除 server.json 外不挂载宿主目录。
- 限制内存 384 MiB、进程 64、日志 3×10 MiB；只读根文件系统、移除 Linux capabilities、禁止提权。
- healthcheck 只标记健康状态；普通 Compose 不会仅因为 unhealthy 自动重启。进程退出才触发 restart policy。手动停止的容器也不会因 Docker 重启自动恢复。
- 迁移已有服务时，先在临时回环端口启动同一镜像验证健康和权限，再停旧服务并启动正式容器。失败时停容器并恢复旧 systemd 服务；成功后禁用旧服务，避免重启时抢占端口。无需为了切换重启主机或 Docker。
- 切换会短暂断开连接；设备保留执行所有权，连接恢复不自动补发 prompt 或审批。切换前确认设备空闲，远程 WSS 保持 TLS 与节点身份校验。

## 构建

在受信任的构建机器上，使用目标平台的官方 Node 镜像。server 的现有依赖为纯 JavaScript，构建上下文仅使用 portable server bundle，不把整个仓库或本地凭据发送给 Docker。

```sh
DOCK_RELEASE_TAG=release-example
pnpm bundle .local/docker-release
# ARM 构建机部署到 x86_64 主机时显式选择 linux/amd64。
docker build --platform linux/amd64 -f deploy/server.Dockerfile \
  -t "harness-dock-server:$DOCK_RELEASE_TAG" .local/docker-release/server
```

镜像只通过私有方式传到目标机器，不推公共 registry。跨机器可使用 `docker save` / `docker load`；传输前后核对归档 SHA256。

## 配置与启动

例如，将 deploy/compose.yaml 放到 `/opt/harness-dock/compose/compose.yaml`。在相邻 `.env` 文件中设置镜像 tag、宿主配置文件的 UID/GID 和路径；它不包含 token：

```dotenv
DOCK_IMAGE_TAG=<版本标识>
DOCK_UID=<配置文件所属普通用户 UID>
DOCK_GID=<配置文件所属用户 GID>
DOCK_CONFIG_FILE=/etc/harness-dock/server.json
```

server.json 须 host=127.0.0.1，端口 48518/48519。镜像默认 node 用户，Compose 用配置文件的属主覆盖；不要通过放宽配置文件权限解决容器读取问题。

```sh
cd /opt/harness-dock/compose
docker compose -p harness-dock config --quiet
docker compose -p harness-dock up -d
docker compose -p harness-dock ps
docker compose -p harness-dock logs --tail 50
curl --fail https://dock.example.com/healthz
```

更新镜像后修改 `.env` 中版本，再运行 `up -d`。修改挂载配置后用 `restart server`。执行 `stop` 为有意停止，重新开启用 `up -d`。

若已有 `harness-dock-server.service` 宿主机应用服务，首次切换前应停止它；验收完成后禁用它。旧安装目录留作回退，若需要回退，先 `docker compose -p harness-dock down`，再 `systemctl enable --now harness-dock-server`，两者不可同时监听相同端口。

## 证据

项目既有部署验证与限制见 [验证记录](validation.md)，通用步骤见 [ECS 部署](ecs-deployment.md)。实际服务器地址、用户、镜像标识、配对信息和原始运维输出应留在服务器或忽略的 `.local/`，仓库只记录去标识结果与边界。
