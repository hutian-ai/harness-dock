# 支持范围

当前为开发者 Alpha。项目代码采用 MIT，workspace package 保持 private，以源码与独立候选包分发，尚未发布 npm 包或公开 Release。

| 范围 | 支持状态 |
| --- | --- |
| macOS arm64 + Codex | 当前受支持的执行设备 |
| Linux server | 支持自托管配对与转发；可使用 Docker Compose |
| Node.js | 22.19+ |
| 源码构建 | pnpm 12.15.0；运行预构建包不需要 pnpm |
| Windows、macOS Intel、Linux 执行设备 | 未支持 |
| 其他 Harness | 未支持，需具名适配与独立验收 |
| Provider 容器执行 | 不属于当前版本范围 |

固定原生适配依赖以 [Driver 清单](../packages/drivers/package.json) 为准。模型目录、登录、可用额度和原生工具由目标设备的 Harness 决定。

## 能力边界

- 文本执行、原生同 thread 续接、MCP、原生审批与送达确认支持逐项验收。
- inventory ready 表示协议探测成功，不能推导模型或全部工具可用。
- 原生 options、form/url 按能力报告并保留原始选项和作用域。
- 浏览器、桌面、插件、skills 和 memory 依赖原生环境；不承诺所有环境或所有插件均可用。
- 独立 LaunchAgent 的部分桌面宿主能力受原生进程链授权限制，宿主拒绝如实报告。
- SDK 连接恢复不重派。Daemon 重启后未完成执行保持 unknown，旧待批决定不自动恢复。
- 同 thread 普通续接不等于桌面应用重启后的同 thread 续接。

独立设备首装、干净用户、实际注销/登录、自启和升级/回滚须在目标环境分别验收。单机实跑与合成测试不能替代另一台机器的证明，见 [验证方法](validation.md)。
