---
name: vercel-deploy
displayName: Vercel 部署
description: 当用户要把前端或全栈项目（Next.js、Vite、静态站等）部署到 Vercel、获取预览链接或发布生产环境时使用
origin: installed
requires:
  bins:
    - vercel
---

## 适用场景

用户说"部署到 Vercel"、"给我一个预览链接"、"把这个站上线"，且项目适合 Vercel 托管。默认先做预览部署，生产部署必须单独确认。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `vercel --version` 和 `vercel whoami` 检查 CLI 与登录状态。未登录时请用户自己在终端运行 `vercel login`，不要索要令牌或密码。
2. 用 `file_read` 读取 `package.json`（scripts、框架依赖）、`vercel.json`（若有），用 `file_glob` 确认是否已有 `.vercel/project.json`（表示已关联项目）。
3. 先在本地验证能构建：用 `shell_run` 执行项目的构建命令（如 `npm run build`）。构建失败先修复或告知用户，不要带着错误部署。
4. 检查环境变量：用 `file_grep` 搜索 `process.env.`、`import.meta.env.`，列出项目依赖的变量名；用 `shell_run` 执行 `vercel env ls` 对比缺失项。缺失的变量请用户自己执行 `vercel env add <NAME>` 录入，不要让用户把值发到对话里。
5. 未关联项目时执行 `vercel link`（交互式，若需要选择团队/项目，把选项告诉用户，由用户在终端完成）。
6. 预览部署：`vercel deploy`（或直接 `vercel`），从输出中提取预览 URL 告诉用户。
7. 可选：用 `browser_automation` 打开预览 URL 做一次冒烟检查（首页能否加载、控制台有无报错）。
8. 用户确认要上线后，才执行 `vercel deploy --prod`；完成后汇报生产 URL。
9. 出问题时用 `vercel inspect <部署URL> --logs` 查看构建日志定位原因。

## 注意事项 / 安全

- 生产部署会影响真实用户，必须先向用户确认；预览部署也会生成可公开访问的链接，提醒用户注意内容。
- 不要把 `.env`、密钥文件提交或上传；检查 `.vercelignore` / `.gitignore` 是否排除了敏感文件。
- 不要执行 `vercel remove`、`vercel env rm` 等删除操作，除非用户明确要求并再次确认。
- Monorepo 需确认部署的是哪个子目录（`--cwd <目录>` 或项目 Root Directory 设置）。

## 如何确认完成

拿到可访问的预览（或经确认的生产）URL，并已在浏览器或通过 `web_fetch` 验证页面能正常返回。
