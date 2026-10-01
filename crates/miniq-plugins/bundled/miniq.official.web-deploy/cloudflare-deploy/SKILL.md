---
name: cloudflare-deploy
displayName: Cloudflare 部署
description: 当用户要把静态站点部署到 Cloudflare Pages，或把 Worker 脚本部署到 Cloudflare Workers 时使用，基于 wrangler 命令行
origin: installed
requires:
  bins:
    - wrangler
---

## 适用场景

用户提到 Cloudflare Pages / Workers、`wrangler`，或希望把站点放到 Cloudflare 上。先区分两类：纯静态/前端产物用 Pages；带 `wrangler.toml`（或 `wrangler.jsonc`）且有 `main` 入口的是 Worker。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `wrangler --version` 与 `wrangler whoami`；未登录请用户自己在终端运行 `wrangler login`，不要让用户粘贴 API Token。
2. 用 `file_glob` 查找 `wrangler.toml` / `wrangler.jsonc`，用 `file_read` 查看 `name`、`main`、`compatibility_date`、绑定（KV、D1、R2）等配置，判断走 Pages 还是 Workers。
3. 本地验证：
   - Pages：`npm run build`，确认输出目录（如 `dist`）。
   - Workers：`wrangler dev` 本地试跑（后台运行后用 `web_fetch` 访问本地地址验证，再停止进程）；或 `wrangler deploy --dry-run` 检查打包。
4. 机密与变量：用 `file_grep` 找出代码使用的环境变量名；机密请用户自行执行 `wrangler secret put <NAME>` 输入，普通变量写在配置文件的 `[vars]` 中（修改前先确认）。
5. 预览部署：
   - Pages：`wrangler pages deploy <输出目录> --project-name <项目名> --branch preview`，得到预览 URL。
   - Workers：`wrangler versions upload` 上传新版本但不切流量（若账号/版本不支持，说明情况后再决定）。
6. 用 `browser_automation` 或 `web_fetch` 验证预览地址。
7. 用户确认上线后：Pages 用 `wrangler pages deploy <输出目录> --project-name <项目名> --branch <生产分支>`；Workers 用 `wrangler deploy`。
8. 排错：Workers 可用 `wrangler tail` 查看实时日志。

## 注意事项 / 安全

- 生产部署、修改路由/自定义域名、改动 D1 数据库（`wrangler d1 execute --remote`）都必须先向用户确认。
- 不要执行 `wrangler delete`、删除 KV/R2/D1 资源，除非用户明确要求并再次确认。
- 不要把机密写进 `wrangler.toml` 或提交到仓库。
- `compatibility_date` 变更可能改变运行时行为，不要随意改动。

## 如何确认完成

预览（或经确认的生产）地址可访问且返回预期内容；向用户汇报部署类型、项目名与 URL。
