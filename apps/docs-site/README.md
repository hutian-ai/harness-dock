# harness-dock 文档站

Nuxt 风格的独立静态文档，位于 harness-dock 仓库的 `apps/docs-site/`。中性黑白底、绿色强调、两层导航、图标侧栏和三栏阅读布局。仍使用 Node.js 静态生成，无第三方运行时依赖。

## 本地预览

从 `apps/docs-site/` 目录执行，需要 Node.js 22+，无需 npm install：

```sh
npm run build
npm run check
npm run preview
```

打开 http://localhost:4173。也可以从仓库根目录执行 `node apps/docs-site/build.mjs`、`node apps/docs-site/check.mjs`、`node apps/docs-site/serve.mjs`。生产产物在 `apps/docs-site/dist/`。

## GitHub Pages

仓库根目录的 `.github/workflows/docs-pages.yml` 会在 main 上的文档变更、相关 PR 或手动触发时构建并检查文档。Pages 部署使用单独的 job，仅上传文档站静态文件，不上传产品源码、.local、运行配置或依赖。

首次启用：

1. 确认仓库当前可见性与账户套餐允许使用 GitHub Pages。
2. Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
3. Settings → Secrets and variables → Actions → Variables 添加 `DOCS_PAGES_ENABLED`，值为 `true`。
4. 在 main 推送文档更新，或在 Actions 手动运行 Docs Pages。

部署仅在变量开启且来源为 main 时执行；未开启时只构建检查。默认站点路径为 https://hutian-ai.github.io/harness-dock/，是否已部署及实际入口以 Actions 输出为准。

## 其他托管

- 静态托管：构建后上传 dist/ 的全部内容。
- Netlify / Vercel：项目根目录选择 apps/docs-site，使用附带配置。
- Cloudflare Pages：根目录 apps/docs-site；构建 npm run build；发布 dist；Node 22。
- Docker：在 apps/docs-site 中运行 `docker build -t harness-dock-docs .`，然后 `docker run --rm -p 8080:80 harness-dock-docs`。

每页都是独立 HTML，导航、资源和搜索使用相对路径，支持仓库子路径。通过 HTTP 预览搜索，不要用 file:// 打开。

## 修改内容

- src/content.json：页面、分组、摘要和正文 HTML。
- src/shell.html：布局与头部导航。
- public/style.css：视觉系统与响应式布局。
- public/app.js：搜索、菜单、复制和主题。
- build.mjs：静态页面、目录、导航、搜索索引和 .nojekyll。

产品与维护文档统一维护在 src/content.json；不再保留重复的 docs/ 目录。支持范围为 macOS arm64 + Codex Developer Alpha，其他 Harness 尚未支持。文档站不包含真实地址、设备身份或凭据。

构建、链接检查和页面 QA 不替代产品的真实设备安装、模型执行或部署验收。

## 文档索引

文档内容的唯一来源为 [src/content.json](src/content.json)，本地构建与部署共用相同内容。

### quickstart

快速开始：启动预览后访问 `/quickstart/`。

### sdk

SDK 接入：启动预览后访问 `/sdk/`。

### server

服务端部署：启动预览后访问 `/server/`。

### installation

设备安装与维护：启动预览后访问 `/installation/`。

### architecture

架构与执行契约：启动预览后访问 `/architecture/`。

### drivers

Codex 驱动：启动预览后访问 `/drivers/`。

### support

支持范围：启动预览后访问 `/support/`。

### lifecycle

执行生命周期与资源：启动预览后访问 `/lifecycle/`。

### verification

开发与验证：启动预览后访问 `/verification/`。

### distribution

构建与分发：启动预览后访问 `/distribution/`。
