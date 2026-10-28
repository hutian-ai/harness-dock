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
- 移除未发布的私有 Harness 集成，保留通用 Driver/ACP 扩展边界。升级前需要从本地配置中删除已移除 Provider 的条目；设备身份、原生数据与执行记录仍会保留。
