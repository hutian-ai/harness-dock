# 界舟 · Harness Dock 文档站

产品文档的唯一内容来源是 `src/content.json`；静态生成器不依赖第三方运行时。README 负责项目入口，文档站负责完整使用路径，本文件只说明内容维护与发布。

## 内容怎么组织

先帮助读者判断产品是否适合，再按正在做的事引导。不要要求设备用户先理解 ACP、Daemon、receipt 或发行验收。

| 导航 | 面向谁 | 页面 |
| --- | --- | --- |
| 快速了解 | 首次了解产品的人 | 首页、产品介绍、版本与支持范围 |
| 使用 App | 执行电脑的持有人 | 安装与连接、App 使用指南、模型测试、常见问题 |
| 接入产品 | 应用、Agent 与自动化开发者 | SDK 接入、任务与断线处理 |
| 管理服务 | 自托管服务管理员 | 部署 Server、邀请与访问权限 |
| 开发与参考 | 项目开发者与维护者 | 后台升级、架构、驱动、验证、构建发行、文档部署 |

写作规则：先说用户要完成什么，再给准备条件、步骤、成功后的下一步。每页有明确读者；不把源码候选、旧版按钮、测试结论和当前操作穿插叙述。技术约束放在影响操作的位置，完整实现细节链接到参考页。已存在的公开锚点应保留，避免外部链接失效。

当前设备指南对应 **App v0.1.3、macOS 15+、Apple 芯片**。旧 Swift App v0.1.2 保留 macOS 13+ 下载。SDK 继续独立发行 `sdk-v0.1.2`；源码新增 API 不得写成该 SDK 下载已有的能力。Windows 仍为待实机验收的 CLI/Daemon 源码路径，没有桌面发行。

## 本地预览

需要 Node.js 22+，不需要 npm install：

```sh
node apps/docs-site/build.mjs
node apps/docs-site/check.mjs
node apps/docs-site/serve.mjs
```

打开 http://localhost:4173。输出位于 ignored `dist/`。修改 `src/content.json` 更新正文与页面元数据，`build.mjs` 维护导航顺序，`src/shell.html` 维护公共布局，`public/` 维护资源。保持现有黑白与绿色视觉系统，支持浅深色、键盘导航和窄屏。

交付前检查首页角色入口、App 首次连接、SDK 首个任务、支持范围和下载地址；实际查看桌面与窄屏、亮色与暗色、搜索与页内目录。不要仅以链接检查代替内容和页面审阅。

## GitHub Pages

`.github/workflows/docs-pages.yml` 在 main 上的文档变更、PR 或手动触发时构建和检查；只有 main、非 PR 且仓库变量 `DOCS_PAGES_ENABLED=true` 时部署。仅上传静态站点，不上传源码运行数据、配置、账号或 `.local/`。

Pages 来源使用 GitHub Actions。默认地址为 https://hutian-ai.github.io/harness-dock/，实际发布结果以对应 Actions run 为准。未启用变量时只检查，不代替已部署的证明。

其他静态托管可直接发布 `dist/`，站点支持仓库子路径。搜索应通过 HTTP 使用，不用 file://。

## 页面索引

### overview

产品价值、适用场景和任务路径。只用“产品 → Server → 所选电脑”解释关系，内部层次放到 architecture。

### quickstart

普通设备用户四步：安装 → 输入管理员邀请 → 核对服务器和执行目录 → 回到调用方产品。说明已有设备 config.json 不是配对文件。

### app

App 当前界面的唯一操作指南。覆盖侧栏、只读原生配置、模型目录、执行状态和用量、刷新周期、停止/移除、登录连接与 Finder 日志。`preview-connect` 等既有锚点保留；打包器从这段生成随包离线帮助，名字不代表候选功能。

### usage

解释可选模型响应测试与业务任务验收的区别；复杂的真实 Harness 检查归 verification。

### support

集中维护 App/SDK 版本、最低系统、Harness 状态和未支持平台。安装被发现不表示就绪；本机覆盖后的原生默认也不等于出厂默认。

### sdk

应用开发者从 `quick-connect` 开始，使用固定 SDK 发行完成第一个任务；`first-task` 保留同机完整体验。`source-observation` 明确属于尚未独立发行的源码 API。不要修改已发布 SDK 示例去调用新源码接口。

### server

管理员通过 SDK 发行的 Server 归档部署 Linux 服务，优先使用随包 Dockerfile、Compose、docker.sh，宿主不要求 Node。部署后分发设备邀请与独立应用凭据。命令核对不代表生产部署已验收。

### pairing

设备邀请与应用访问是不同身份。维护邀请生成、授权、转移、轮换与加载状态检查，不把设备本地配置当作新配对文件。

### installation

维护者安装独立后台、升级与回滚；保留用户身份、配置、历史与工作文件。Windows 实验路径和旧安装恢复明确标注，不夹在普通 App 首次连接中。

### lifecycle

面向开发者的执行、会话、断线、产物和恢复契约。缺少终态证据保持 unknown；不自动重派 prompt、工具或审批决定。

### troubleshooting

按可观察问题给出下一步：没有邀请、文件选错、未连接、Harness 不可用、任务待确认、停止被拒绝、原生权限与更新。工具诊断不调用模型。

### architecture

明确 SDK、Server、设备后台与具名 Driver 的职责；业务和原生权限所有权不迁入 Dock。

### drivers

Codex 使用固定 ACPX/Codex ACP；dsh 使用具名薄适配。保留安装/home、回调、原生模型标识和权限的实际约束。

### verification

验收要求与通过记录分开。确定性测试、离线分发、真实 Harness、实际 GUI、独立设备和生产部署是不同证据。原始输入、地址、日志、输出与配置只留 ignored `.local/`；公开内容使用示例。

### distribution

App `v*` 与 SDK `sdk-v*` 独立工作流；从干净固定提交构建，附依赖许可、摘要与来源元数据，下载读回后发布。SDK workspace 保持 private，不发布 npm。源代码提交不等于发布、模型能力或目标设备已验收。

### deploy-docs

文档站本身的构建与部署参考，不出现在普通设备用户的使用路径中。
