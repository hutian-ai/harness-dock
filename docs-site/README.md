# harness-dock 文档站

Nuxt 风格的独立静态文档，位于 harness-dock 仓库的 `docs-site/`。中性黑白底、绿色强调、两层导航、图标侧栏和三栏阅读布局。仍使用 Node.js 静态生成，无第三方运行时依赖。

## 本地预览

从 `docs-site/` 目录执行，需要 Node.js 22+，无需 npm install：

```sh
npm run build
npm run check
npm run preview
```

打开 http://localhost:4173。也可以从仓库根目录执行 `node docs-site/build.mjs`、`node docs-site/check.mjs`、`node docs-site/serve.mjs`。生产产物在 `docs-site/dist/`。

## GitHub Pages

仓库根目录的 `.github/workflows/docs-pages.yml` 会在 main 上的文档变更、相关 PR 或手动触发时构建并检查文档。Pages 部署使用单独的 job，仅上传文档站静态文件，不上传产品源码、.local、运行配置或依赖。

首次启用：

1. 确认仓库可使用 GitHub Pages：公开仓库可用免费 Pages；当前私有组织仓库的套餐需要升级才能启用。
2. Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
3. Settings → Secrets and variables → Actions → Variables 添加 `DOCS_PAGES_ENABLED`，值为 `true`。
4. 在 main 推送文档更新，或在 Actions 手动运行 Docs Pages。

部署变量默认未设置，因此当前仍可构建检查，不会触发已知无法使用的 Pages 部署。启用后默认入口预期为 https://hutian-ai.github.io/harness-dock/，以实际 Actions 部署输出为准。

本次配置不会修改仓库可见性、账户套餐或 GPT Sites 部署。

## 其他托管

- 静态托管：构建后上传 dist/ 的全部内容。
- Netlify / Vercel：项目根目录选择 docs-site，使用附带配置。
- Cloudflare Pages：根目录 docs-site；构建 npm run build；发布 dist；Node 22。
- Docker：在 docs-site 中运行 `docker build -t harness-dock-docs .`，然后 `docker run --rm -p 8080:80 harness-dock-docs`。

每页都是独立 HTML，导航、资源和搜索使用相对路径，支持仓库子路径。通过 HTTP 预览搜索，不要用 file:// 打开。

## 修改内容

- src/content.json：页面、分组、摘要和正文 HTML。
- src/shell.html：布局与头部导航。
- public/style.css：视觉系统与响应式布局。
- public/app.js：搜索、菜单、复制和主题。
- build.mjs：静态页面、目录、导航、搜索索引和 .nojekyll。

内容依据为仓库 README、quickstart、SDK、device、server 和 support 文档。支持范围为 macOS arm64 + Codex Developer Alpha，其他 Harness 尚未支持。文档站不包含真实地址、设备身份或凭据。

构建、链接检查和页面 QA 不替代产品的真实设备安装、模型执行或部署验收。
