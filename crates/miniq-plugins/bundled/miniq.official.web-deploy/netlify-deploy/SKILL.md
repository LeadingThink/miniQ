---
name: netlify-deploy
description: 当用户要把静态站点或前端项目部署到 Netlify（草稿预览或正式发布）时使用
origin: installed
requires:
  bins:
    - netlify
---

## 适用场景

用户说"发布到 Netlify"、"用 Netlify 做个预览"。适合静态站、SPA 以及使用 Netlify Functions 的项目。默认先做草稿（draft）部署。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `netlify --version` 与 `netlify status` 检查 CLI 和登录状态；未登录请用户自己在终端运行 `netlify login`。
2. 用 `file_read` 读取 `package.json` 与 `netlify.toml`（若有），确认构建命令和发布目录（常见：Vite 为 `dist`，CRA 为 `build`，Next.js 需 Netlify 适配器）。
3. 用 `shell_run` 在本地执行构建（如 `npm run build`），并用 `file_glob` 确认发布目录下存在 `index.html`。
4. SPA 路由需要回退规则：检查 `netlify.toml` 或 `public/_redirects` 是否有 `/* /index.html 200`，缺失时向用户说明并在同意后用 `file_write` 添加。
5. 站点关联：`netlify status` 显示未关联时，询问用户是关联已有站点（`netlify link`）还是新建（`netlify sites:create`），交互步骤由用户在终端完成。
6. 环境变量：用 `file_grep` 找出代码依赖的变量名，`netlify env:list` 对比；缺失项请用户自行执行 `netlify env:set <NAME> <值>`，不要在对话中传递值。
7. 草稿部署：`netlify deploy --dir=<发布目录>`，从输出提取 Draft URL 告诉用户；可用 `browser_automation` 打开做冒烟检查。
8. 用户确认上线后执行 `netlify deploy --dir=<发布目录> --prod`，汇报正式 URL。

## 注意事项 / 安全

- 正式发布（`--prod`）必须先向用户确认。
- 确认发布目录里没有 `.env`、源码映射中的敏感信息或私有数据文件。
- 不要执行 `netlify sites:delete` 或删除环境变量，除非用户明确要求并再次确认。
- 构建失败时查看 `netlify deploy` 的输出或本地构建日志，不要反复盲目重试。

## 如何确认完成

草稿 URL（或经确认的正式 URL）可访问，主要页面和路由刷新后不出现 404。
