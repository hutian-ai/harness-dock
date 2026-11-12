# 贡献指南

harness-dock 把原生 Harness 接入产品，让任务在调用方所选设备上执行。它作为 AI Infra 提供跨设备接入、连接与执行管理；业务交互、业务授权与结果验收归调用方应用，内部工具与原生权限归 Harness。先阅读 [架构](apps/docs-site/README.md#architecture)、[支持范围](apps/docs-site/README.md#support) 和 [构建与分发](apps/docs-site/README.md#distribution)。设备发行包含 macOS arm64 和独立的 Windows 11 x64 Developer Alpha。App `v0.1.3` 使用 GPUI Kit，要求 macOS 15+ arm64；旧 Swift App `v0.1.2` 保留 macOS 13+ 下载。独立 SDK 仍为 `sdk-v0.1.2`。Windows 客户端与附带后台由 v0.1.3-windows.1 单独发行；新增 SDK API 仍是源码能力，不由构建成功推导目标设备验收完成。

## 开发环境

使用 Node.js 22.19+、pnpm 12.15.0：

```sh
npm install --global pnpm@12.15.0
pnpm install --frozen-lockfile
pnpm check
pnpm smoke:source
```

pnpm check 构建 workspace、检查脚本/测试类型并运行确定性控制边界测试。不要并行构建共享工作区，或直接修改现用 daemon 的运行目录。使用 TypeScript ESM、显式相对扩展名和 type-only imports。

`pnpm smoke:source` 使用隔离的 `.local/` 目录、临时回环端口和禁用的 Codex/dsh，验证源码 CLI、配对、后台启停/重启、SDK 连接、托管文件和诊断。它不使用原生账号，不执行模型，也不证明独立设备或原生工具可用。

提交前安装 Gitleaks（macOS 可用 `brew install gitleaks`），再运行 `pnpm check:privacy`。该检查覆盖当前源码（含未提交改动）、本地可达 Git 历史、误提交的本地运行文件、个人主目录和 URL 中的非示例 IP；扫描输出遮盖密钥。CI 固定 Gitleaks 版本与下载摘要，并取得完整提交历史。真实域名、上下文和第三方许可仍须人工复核，不把扫描通过当作全部脱敏证明。

真实 Codex 检查为 `pnpm accept:codex`；dsh 实验适配检查为 `pnpm accept:dsh`，首个适配版本为原生 `@deepseek-ai/dsh 0.1.2-rc.1`。两者都需要本机原生登录和模型额度，须显式执行，不在 CI 配置 Provider 凭据。

`accept:dsh` 通过本机隔离的 SDK / Server / DeviceHost fixture 验证六类场景：MCP 成功、MCP 错误、调用方与原生项目 skills 共存，以及原生审批允许、拒绝、取消后旧决定失效。允许用例还验证一次性授权不会扩大后续写权限。fixture 只为原生子进程选择 read-only，不修改用户 settings 或已安装 Daemon；必须实际观察到原生只读拒绝和审批回调，未触发审批不能计通过。MCP 错误在原生投影为 failed 时，送达状态保守保持 unknown。

上述本机 fixture 不替代独立 Daemon 进程、独立设备、发行包或业务验收。设备面板是持有人的轻量接入、状态和维护入口，正常使用回到调用方应用。当前 App 从侧栏打开 Harness 只读配置与模型信息，概览集中展示执行记录、用量与连接诊断。旧 Swift App 操作按旧版本说明。Codex 测试使用原生确认的只读模式，dsh 实验回显沿用原生权限配置，不提供只读保证。工具活动或额外审批不会判定通过；安装发现也不代表模型就绪。环境核验不阻挡首次邀请接入，自启和版本操作留在维护区。源码摘要、输入、回调与结果留在 ignored `.local/`；独立离线分发检查见 [验证](apps/docs-site/README.md#verification)。

## 设计边界

- Daemon 管理 Provider 进程与审批处理，执行所有权独立于连接；等待应用响应的审批或工具请求可能因失联失败或被拒绝。恢复连接不重派 prompt、工具或权限决定。
- 缺少完成证据保持 unknown；取消请求或观察文本不证明终态。
- Harness 拥有原生工具、插件、skills、memory 与权限，dock 使用具名薄适配连接原生环境。
- 公共 wire 类型位于 protocol/client，调用方不依赖 daemon/drivers 或设备凭据。
- 配置、会话、日志、服务地址、个人标识和验证原始产物留在 ignored 的 .local/。
- package 保持 private，公开发布、服务部署与仓库可见性变更分别授权。

## 变更与报告

使用合成内容复现问题，说明源码提交、平台、Node/pnpm、预期/实际行为和能力限制。不要附完整配置、日志、原生认证或私人 prompt。漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

优先用最短真实使用路径、必要编译和相关既有检查验证变更；用户未明确要求时不新增测试代码、fixture、框架或矩阵。修改协议、能力和失败语义时同步更新文档，明确区分确定性、离线安装、真实 Provider 与实际部署证据。

提交使用仓库本地配置、与贡献者自己的 GitHub 账号关联的身份，以及该账号由 GitHub 提供的 noreply 邮箱；不使用未关联的通用维护者邮箱或个人邮箱。保留第三方许可和补丁来源；只提交有权按项目 MIT 许可贡献的内容，保留历史，除非用户明确授权重写。
