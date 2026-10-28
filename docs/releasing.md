# 构建与分发

运行包分别交付 server、daemon、controller 和 SDK 归档。所有 workspace package 保持 private；候选产物不是 npm 发布或公共 Release。

## 从冻结源码构建

使用可信源码提交，在隔离目录中安装并串行运行：

```sh
npm install --global pnpm@12.15.0
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm audit
pnpm bundle .local/bundles/candidate
node --import tsx scripts/accept-bundle.ts .local/bundles/candidate --offline
```

bundle 输出三个完整运行目录及 controller.tgz。依赖由冻结锁文件安装，分发时携带实际依赖，不依赖源码工作区或 registry。运行包带项目许可、第三方索引和 daemon 补丁；封存后不要在其中重装依赖。

设备包必须在目标平台构建，不跨系统复制 node_modules。正式设备范围是 macOS arm64 + Codex；Linux 构建的 daemon 仅为内部检查产物，不构成设备支持。

## 候选归档

```sh
pnpm package:local --bundles .local/bundles/candidate --output .local/distribution/candidate
```

输出 server/controller/daemon 归档、离线 SDK、release.json、README.txt 和 SHA256SUMS。产物去除构建用户属主与 macOS 扩展属性、ACL 和文件标志。来源为实际源码 revision，工作区未提交时明确标记 dirty。

在 Linux 构建 server 镜像并一同导出：

```sh
docker build -t harness-dock-server:<固定提交> .local/bundles/candidate/server
pnpm package:local --bundles .local/bundles/candidate \
  --output .local/distribution/linux-candidate --server-image harness-dock-server:<固定提交>
```

命令只导出已存在的本地 Linux 镜像，不推送 registry、不运行或部署服务。摘要用于完整性检查，不替代源码来源和发布者认证。

## CI

CI 在 main push、pull request 和手动触发时运行 macOS/Linux 构建、类型、确定性测试、独立离线分发及依赖审计，不提供 Provider 凭据。

在 Actions 手动运行 CI 并启用 prepare_artifacts，才额外生成可下载候选包；Linux 作业构建并导出 server 镜像。核对工作流成功状态、源码提交、平台、artifact 摘要和 release.json；配置文件存在不代表实际构建成功。

真实 Codex 模型检查需在已登录的受控设备显式执行，见 [验证方法](validation.md)。设备首装、升级和回滚另按 [设备维护](device.md) 验收。

## 交付检查

- 冻结的源码、版本、依赖和变更说明一致；工作区清洁。
- 运行包和 SDK 在仓库外可安装、编译与启动，许可和补丁完整。
- 真实能力有对应环境证据；不把协议 ready 当作全部工具可用。
- 实际归档、完整待分发历史与软链目标无凭据、私人地址或相邻项目内容。
- 独立设备的安装和升级限制已明确，恢复材料由所有者保存。

密钥扫描与隐私语义复核分别执行。仅分发本仓库，不打包本机 .local/、认证、会话、日志或相邻仓库。仓库可见性、公共 Release、npm/镜像发布和现用服务部署需要各自明确授权。
