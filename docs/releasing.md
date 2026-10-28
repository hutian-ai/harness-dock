# 发布与独立设备验收

首版定位为 macOS arm64 + Codex 开发者 Alpha。发布准备可以在私有仓库完成；
变更仓库可见性、创建公开 Release 和 npm 发布不是本流程自动执行的操作。
本页是验收与操作规程，勾选项必须对应实际证据。

## 当前发布状态（2026-10-27）

- [x] 项目 MIT 许可证与 package license 声明；第三方原许可独立保留。
- [x] 贡献、安全报告、变更记录与首版支持矩阵已建立。
- [x] CI 工作流已配置为确定性检查和离线分发检查，不配置 Provider 凭据。
- [x] 最终候选的本地 pnpm check、依赖审计与离线分发检查通过并记录；真实模型证据另列。
- [ ] 推送后 GitHub CI 实际成功；配置文件存在不代表已经运行。
- [ ] 独立 macOS 设备安装/旧版升级验收通过。
- [ ] 无 dock 安装的新目录或干净用户环境安装验收通过。
- [ ] 最终源码、完整待发布历史、归档和构建包隐私复核完成。
- [ ] 公共仓库的私密漏洞报告入口已启用并验证。
- [ ] 最终候选已提交，版本、变更记录、标签和源代码一致。

## 在隔离候选中验证

不要对现用 daemon release 执行包管理器，也不要在共享源码中并行构建。先将
当前候选复制到 ignored `.local/` 下的新目录或独立临时目录，不带原 node_modules、
凭据、会话、实验输出和相邻仓库。版本管理中的源码及明确需要的未跟踪源码须一并
冻结，记录文件摘要；不得只对 HEAD 测试后声称验证了工作区。

```sh
npm install --global pnpm@12.15.0
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm audit
pnpm bundle .local/bundles/alpha-candidate
node --import tsx scripts/accept-bundle.ts .local/bundles/alpha-candidate --offline
```

最后一步不启动真实 Provider，不使用模型账户；它检查仓外空缓存 SDK 安装/ci、
公开类型、依赖隔离、补丁、许可证与 CLI。真实模型验收在已登录的独立环境另外执行：

```sh
node --import tsx scripts/accept-bundle.ts .local/bundles/alpha-candidate
```

真实验收会访问模型服务，只使用合成输入和隔离工作目录。将摘要记录到
`validation.md`；原始日志和 evidence.json 留在 ignored `.local/`。原生配置、
已有 unknown 和用户工作文件不作为清理对象。Linux CI 成功只证明该 job 的范围。

## 已有旧版的独立 macOS 设备

1. 通过该设备受保护的固定入口读取 status、版本与日志；只读核对 OS/架构、
   Node、设备协议、server 兼容性、活动执行和 unknown。记录摘要，不公开真实地址或身份。
2. 任一活动执行、维护操作或 unknown 都不进入升级。等待活动任务结束；unknown 按
   原身份查询和人工裁决，不能清库、强杀、重派或自动标记取消来绕过。
3. 先保留原 installation current/previous、程序产物、配置和状态的私有恢复材料。
   在该设备本地构建候选，或传入同 OS/架构的受控构建包；不从其他架构复制 node_modules。
4. 按 [安装与维护](home-install.md) 显式 upgrade。旧版不支持安全停机时使用旧版自己的
   status/stop 完成空闲迁移，拒绝按保存的 PID 发送信号。只在 server 协议兼容后切换。
5. 回读实际启动版本、Node、connected 和 inventory；随后用新 runId 与合成内容验证
   两轮上下文、MCP、原生审批及送达、事件、断线只读查询与 release/forget。记录真实
   cancelled 终态才可声明取消通过；缺少证据保持 unknown，停止后续变更。
6. 所有任务终态明确且安全释放后验证显式回滚和恢复候选，再核对旧身份、配对、配置、
   历史与用户文件。程序回滚不会回滚数据库、任务或已发生的外部效果。实际注销/登录由
   设备所有者在合适时段操作并单独记录，不为验收远程强制注销。

已有设备升级只建立升级证据。全新安装另选没有 dock 状态的目录或干净用户环境：
使用新的测试配对身份、独立端口和工作根，按 README 初始化、安装、执行、停止；
不要让两个 Daemon 同时使用原 nodeId 或同一 SQLite 状态目录。若环境不具备，明确保留待验收。

## 隐私与第三方分发

检查实际待发布内容，包括新文件、历史、归档、软链目标和 license/notice。密钥扫描
与语义复核分别成立：扫描通过不代表公司内部地址、私人部署、个人邮箱、配对信息或
使用状态已脱敏。只发布本仓，排除 `.local/`、`.serena/`、凭据、日志、数据库、
原生会话与相邻项目。真实信息清理不改写已发生的实验结论。

每个运行包须包含项目 LICENSE、THIRD_PARTY_NOTICES.md/json；索引引用的原始许可
文件必须存在，补丁与说明随 daemon 分发。原生依赖升级后重新检查其平台包及上游
NOTICE，不只依赖 package.json 的 SPDX 标签。详见
[第三方说明](../THIRD_PARTY_NOTICES.md)。

## 冻结版本与发布

维护者复核完成后，使用仓库维护身份提交已审查的候选，并确认工作区干净。首个
Alpha 可使用 `0.1.0-alpha.1`，届时同步所有 workspace 版本和锁文件，把 CHANGELOG
的 Unreleased 转成该版本，再运行对应候选的门禁；不可在 dirty 工作区给旧 HEAD
打标签冒充新实现。记录提交、版本、平台、产物摘要和原生依赖版本。

仓库保持 private，直到所有必要验收完成且 Owner 明确授权公开。公开前验证私密
漏洞报告入口，复核最终许可和归档。包继续保持 private；首版不发布 npm。公开
Release、现用服务升级和云端部署各自记录，不由 Git push 或测试通过推导完成。
