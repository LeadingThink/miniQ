---
name: product-design-share
description: 把本地原型或设计产出分享给别人：本地预览地址、局域网访问、打包 zip、导出截图与 PDF 汇总，或在用户明确要求时部署到其已有的静态托管服务；用户要发给同事、分享链接、打包或部署原型时使用
version: 1
---

# 分享原型与设计产出

默认**本地优先**：先给本地预览和可离线打开的压缩包；只有用户明确说“部署/上线/生成公网链接”时才部署，并且只用用户自己的账号与服务。

## 触发场景

- “发给同事看看”“怎么分享这个原型”“打个包”“导出截图/PDF”
- “部署一下”“给我一个公网链接”（明确部署意图）
- 其他技能交付时的一句分享提示被用户接受

## 前置条件

- 已有原型或设计产出（`design/prototype/`、`design/directions/`、`design/audit/` 等）。
- 原型已通过 `product-design-qa`（未通过时先说明，并由用户决定是否仍然分享）。
- 分享方式对照见 `../product-design-router/references/local-preflight.md` 与本文件下方表格。

## 分步流程

1. **确认对象与方式**：从上下文判断要分享什么；方式不明确时用 `ask_user` 问一次，选项：
   - 本机预览（默认）
   - 同一局域网内的其他设备
   - 打包 zip（离线打开）
   - 截图/PDF 汇总
   - 部署到我已有的托管服务
2. **本机预览**：`shell_run` 后台运行 `python3 ../product-design-prototype/scripts/serve.py --dir design/prototype --port <空闲端口>`，给出地址。
3. **局域网访问**：提醒“同一 Wi‑Fi 下的设备可访问，公司网络可能拦截”；`shell_run` 执行 `python3 -m http.server <端口> --bind 0.0.0.0 --directory design/prototype`，并用 `ipconfig getifaddr en0`（macOS）或 `hostname -I`（Linux）取本机 IP，给出 `http://<IP>:<端口>/`。分享结束后停止服务器。
4. **打包 zip**：确认原型只用相对路径、无外部依赖（Vite 项目先 `npm run build` 并在 `vite.config` 设 `base: './'`）；`shell_run` 执行 `cd design && zip -r prototype-<日期>.zip prototype -x "*/node_modules/*" "*/.DS_Store"`。说明对方解压后双击 `index.html` 即可。
5. **截图/PDF 汇总**：`browser_automation` 按视口逐屏截图到 `design/share/`，`view_image` 核验；需要单文件时用 `doc_write` 生成 docx（每屏一节，附说明），或写一个汇总 HTML 用浏览器打印为 PDF。
6. **部署（仅在明确要求时）**：
   - 先用 `shell_run` 检查用户已安装并登录的工具（如 `vercel --version`、`netlify --version`、`gh auth status`），或询问用户使用哪个服务。
   - 用 `ask_user` 确认：部署到哪个服务/账号、链接将公开可访问、内容中无敏感信息。确认后才执行。
   - 部署静态目录（如 `vercel deploy design/prototype`、`netlify deploy --dir design/prototype`、或推送到 GitHub Pages 分支）；不代替用户登录、不索要密码或令牌。
   - 部署后用 `browser_automation` 打开公网链接截图，`view_image` 确认与本地一致。
7. **交付**。

## 工具与参数要点

- `shell_run`：服务器后台运行并记录进程，分享结束后停止；打包排除 node_modules 与隐藏文件。
- `ask_user`：部署前必须确认；局域网共享前提醒网络范围。
- `browser_automation` + `view_image`：部署或打包后都要实际打开验证一次。
- `doc_write`：生成带截图说明的 docx 汇总。

## 质量检查

- 分享出去的版本与 QA 通过的版本一致（打包/部署前重新截一张首屏核对）。
- zip 解压后可离线打开：无绝对路径、无 localhost 请求、图片可加载。
- 部署链接可访问，首屏截图已核验；已告知用户链接是公开的。

## 失败回退

- 没有 zip 命令：用 `python3 -m zipfile -c design/prototype-<日期>.zip design/prototype`。
- 未安装或未登录部署工具：不代为登录，改为提供 zip 包，并告诉用户登录后可再让我部署。
- 局域网访问不通：多半是防火墙或网络隔离，改用 zip 或截图汇总。
- 原型依赖开发服务器（Vite 未构建）：先构建；构建失败则分享截图汇总并说明原因。

## 交付格式

- 一句话：分享物是什么、在哪里（地址 / 文件路径 / 公网链接）。
- 1–2 条注意事项（有效期、公开性、如何打开）。
- 恰好一个下一步。
