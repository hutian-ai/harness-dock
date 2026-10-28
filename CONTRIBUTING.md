# 贡献指南

harness-dock 是跨机器原生 Harness 接入与执行基础设施。先阅读 [架构](apps/docs-site/README.md#architecture)、[支持范围](apps/docs-site/README.md#support) 和 [构建与分发](apps/docs-site/README.md#distribution)。当前受支持的设备为 macOS arm64 + Codex。

## 开发环境

使用 Node.js 22.19+、pnpm 12.15.0：

```sh
npm install --global pnpm@12.15.0
pnpm install --frozen-lockfile
pnpm check
```

pnpm check 构建 workspace、检查脚本/测试类型并运行确定性控制边界测试。不要并行构建共享工作区，或直接修改现用 daemon 的运行目录。使用 TypeScript ESM、显式相对扩展名和 type-only imports。

真实 Codex 检查为 `pnpm accept:codex`，需要原生登录和模型额度；不自动执行，不在 CI 配置 Provider 凭据。独立离线分发检查见 [验证](apps/docs-site/README.md#verification)。

## 设计边界

- Daemon 拥有 Provider 进程和待批审批，独立于连接。恢复连接不重派 prompt、工具或权限决定。
- 缺少完成证据保持 unknown；取消请求或观察文本不证明终态。
- Harness 拥有原生工具、插件、skills、memory 与权限，dock 使用具名薄适配连接原生环境。
- 公共 wire 类型位于 protocol/client，调用方不依赖 daemon/drivers 或设备凭据。
- 配置、会话、日志、服务地址、个人标识和验证原始产物留在 ignored 的 .local/。
- package 保持 private，公开发布、服务部署与仓库可见性变更分别授权。

## 变更与报告

使用合成内容复现问题，说明源码提交、平台、Node/pnpm、预期/实际行为和能力限制。不要附完整配置、日志、原生认证或私人 prompt。漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

测试覆盖可观察控制边界；修改协议、能力和失败语义时同步更新文档，明确区分确定性、离线安装、真实 Provider 与实际部署证据。

提交使用仓库维护身份，不含个人邮箱。保留第三方许可和补丁来源；只提交有权按项目 MIT 许可贡献的内容。
