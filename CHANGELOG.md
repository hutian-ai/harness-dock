# Changelog

## Unreleased

以下为当前源码尚未通过新 Release 分发的变更。已有 [v0.1.0 Developer Alpha 客户端](https://github.com/hutian-ai/harness-dock/releases/tag/v0.1.0)支持 Codex；该公开下载尚未更新为包含 dsh 的新包。workspace package 保持 private，不发布 npm 包。

### Added

- macOS arm64 上 dsh 的具名 ACP SDK 实验适配，复用本机安装、原生 home、登录与配置；首个适配版本为 `@deepseek-ai/dsh 0.1.2-rc.1`。
- dsh 原生模型与 effort 选择、会话续接、审批 options 转发、MCP 与叠加的调用方命名 skills root。
- 新构建候选的面板收敛为设备持有人的轻量接入、状态和维护入口：首页显示连接、后台、执行数量与需要处理事项；环境列表、固定回显及诊断移入“检查本机环境”，自启和版本操作集中在“设置与维护”。首次引导先连接这台 Mac，环境核验不阻挡邀请接入。
- 本机环境检查按后台发现结果展示条目（当前支持 Codex/dsh），分别保留固定测试历史；测试运行或启动收据待确认时禁止切换环境和维护后台。
- `pnpm accept:dsh` 本机 SDK / Server / DeviceHost fixture，覆盖 MCP 成功/错误、调用方与原生项目 skills 共存、审批允许/拒绝/取消后旧决定失效，以及一次性授权作用域。

### Fixed

- 忘记会话时一并清理对应 dsh 派生目录，保留其他会话与原生用户目录。
- GUI helper 与 LaunchAgent 保留 dsh 的本机发现选择器；使用 Daemon 自带 Node 启动选定的 dsh JavaScript 入口，避免依赖 GUI 的 Node PATH。

### Scope

- dsh 暂无精确最终答案识别与只读结果查回，缺少完成证据保持 unknown，不自动重派。MCP 错误在原生投影为 failed 时，送达状态保守保持 unknown。
- Codex 面板测试使用原生确认的只读模式；dsh 面板测试为实验固定回显，沿用原生权限配置，不提供只读保证，工具与应用授权分别验收。现有公开 v0.1.0 下载仍只提供“测试 Codex”；源码与新构建候选的功能不表示独立 Daemon 进程、独立设备或发行包已完成 dsh 验收。

## 已有能力与历史变更

以下保留项目已有能力与此前收口过程，作为历史说明，不代表本次新增或另行发布。

- 独立 server、设备 Daemon 和 TypeScript client SDK，设备与应用主动连接控制方。
- 设备配对、应用访问授权、凭据轮换、分层诊断和独立安装入口。
- 公开执行方法、能力及原生审批/工具回调类型。
- 持久执行身份、会话隔离、有界并行、结果查询与连接恢复不重派。
- Codex 原生环境复用，经固定 ACPX / Codex ACP 执行、续接和只读查回。
- 独立运行目录、离线 SDK、带来源和摘要的候选归档及 Linux server 镜像构建。
- 既有公开版本的设备支持范围为 macOS arm64 + Codex。

### 历史调整

- 曾补充从 GitHub 源码启动、独立设备连接已有 server、诊断和真实两轮验收的步骤；当前客户端入口见 README。
- CI 增加不使用原生账号的源码冒烟、密钥扫描和本地运行数据隐私检查。
- 产品与维护文档统一迁至 `apps/docs-site`，移除重复文档和开发过程快照。
- 曾收敛为 Codex 最小版本，移除其他 Provider、闲置 ACP 执行/探测逻辑、设备容器实验和交互演示控制台。
- 当时设备配置仅接受正式字段和 Codex 条目，删除旧配置的宽松兼容；当前源码已加入具名 dsh 条目。应用继续通过 SDK 执行任务，CLI 用于安装、诊断和验收。
