# Changelog

## Unreleased

当前为开发者 Alpha，尚无公开 Release 或 npm 发布。package 版本不代表已发布。

- 独立 server、设备 Daemon 和 TypeScript client SDK，设备与应用主动连接控制方。
- 设备配对、应用访问授权、凭据轮换、分层诊断和独立安装入口。
- 公开执行方法、能力及原生审批/工具回调类型。
- 持久执行身份、会话隔离、有界并行、结果查询与连接恢复不重派。
- Codex 原生环境复用，经固定 ACPX / Codex ACP 执行、续接和只读查回。
- 独立运行目录、离线 SDK、带来源和摘要的候选归档及 Linux server 镜像构建。
- 当前设备支持范围为 macOS arm64 + Codex。

### Changed

- 产品与维护文档统一迁至 `apps/docs-site`，移除重复文档和开发过程快照。
- 收敛为 Codex 最小版本：移除其他 Provider、闲置 ACP 执行/探测逻辑、设备容器实验和交互演示控制台。
- 设备配置只接受正式字段和 Codex 条目，删除旧配置的宽松兼容；应用通过 SDK 执行任务，CLI 用于安装、诊断和验收。
