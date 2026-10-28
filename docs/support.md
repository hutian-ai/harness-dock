# 首版支持范围

当前状态：**开发者 Alpha 候选，尚未公开发布**。项目代码采用 MIT，workspace
package 继续保持 private；源码与独立构建包是首版分发方式，无 npm 发布。
**当前唯一受支持的 Provider 是 Codex，设备端环境为 macOS arm64。** 下表中的
其他 Provider 均未支持；保留源码和历史实验不构成支持承诺。
正式定位与行为契约归 [standalone-v1.md](standalone-v1.md)，逐轮真实证据归
[validation.md](validation.md)。本页汇总当前承诺，历史记录不自动扩大支持范围。

## 环境与 Provider

| 范围 | 首版定位 | 当前证据与限制 |
| --- | --- | --- |
| macOS arm64 + Codex | 当前唯一受支持的 Provider/设备组合 | 本机已登录安装的 SDK/server/独立 Daemon 真实链路、仓外安装通过；另一台设备及干净用户首装待验收 |
| macOS Intel | 待验证 | 未完成当前候选的目标平台安装与真实 Provider 验收 |
| Linux server | 自托管 server | 历史 ECS Docker Compose/WSS 具名证据有效；当前候选须另做目标版本部署验收 |
| Linux 设备端 | 实验性 | CI 中的构建/合成测试不代表原生 Provider 执行或设备管理已验收 |
| Windows 设备端 | 未支持 | 当前候选安装、后台管理与 Provider 真实链路未验收 |
| Lobi / DeepSeek | 未支持 | 仅保留源码与具名历史实验，不提供当前安装或使用支持 |
| ZCode | 已移除 | 历史记录只描述当时实现 |
| Provider Docker/Podman | 后置实验 | 不作为 v1 门禁；云端 server 的 Docker 部署单独成立 |

预构建运行包需要 Node.js 22.19+，安装入口见[独立安装与首次验证](quickstart.md)；只有源码维护/构建需要 Git 和 pnpm 12.15.0。Codex 使用本机所选安装/home 和已有登录。
固定适配依赖为 ACPX / Codex ACP，版本以 [Driver 依赖](../packages/drivers/package.json) 为准，补丁边界见
[patches/README.md](../patches/README.md)。模型可用性与额度属于原生账户条件。

## 能力证据

| 能力 | 当前边界 |
| --- | --- |
| inventory ready | 协议探测成功，不代表模型、浏览器或插件执行通过 |
| 原生审批/提问 | Codex 有具名 options/form/url Local 证据；保持原始 optionId 和作用域 |
| 同 thread 冷续接 | 独立 Daemon/Codex 两轮具名链路通过；不能外推为桌面应用重启后原 thread 续接 |
| 浏览器 | 有具名 Local 证据；依赖原生工具、宿主连接与权限，不是全部环境承诺 |
| 独立 LaunchAgent 的桌面 MCP | 存在原生进程链授权拒绝；如实报告，不绕过或另建 dock 授权 |
| 插件、skills、memory | 由 harness 原生发现和执行；尚未逐项验收全部功能 |
| 安装/升级/回滚 | macOS Local 隔离验收；独立旧版设备升级、实际注销/登录仍须单独验证 |
| 断线/重启 | 不重派；缺失完成证据保留 unknown。待批审批不承诺跨 Daemon 重启恢复 |

## 获取帮助

普通问题按 [贡献指南](../CONTRIBUTING.md) 提供去标识复现；漏洞走
[安全报告渠道](../SECURITY.md)。诊断前先区分程序运行、server 已连接、Provider
协议就绪和实际执行成功。不要用重新发送原请求探测未知任务是否已经执行。
