---
name: data-publish-html
displayName: 发布 HTML 报告
description: 当用户需要把 HTML 报告或看板发布、分享或托管为网页时使用，包括把图片样式等资源内联成单文件、检查外部依赖与敏感信息、本地预览，以及给出部署到静态托管或内网的步骤
version: 1
---

# 发布 HTML 报告

## 触发场景
- “把这个报告发成网页”“给个链接让团队看”“部署到内网/静态站点”
- 用户原本想发布到 Google Sites 等在线站点：本技能产出可直接上传的自包含 HTML，并给出各平台的部署指引

## 前置条件
- 已完成并通过检查的 HTML（来自 `data-report`/`data-dashboard`）
- 发布目标与访问范围：公开 / 公司内网 / 仅指定人员。**公开发布前必须用 `ask_user` 获得确认**
- 部署选项见 `references/hosting-guide.md`；发布前检查见 `references/publish-checklist.md`；脚本参数见 `references/scripts-usage.md`

## 分步流程
1. **确认目标**：托管位置、访问权限、是否需要固定链接和后续更新。
2. **敏感信息检查**：按 `references/publish-checklist.md` 检查个人信息、内部数字、明细数据、嵌入的原始数据 JSON；用 `file_grep` 搜索手机号、邮箱、身份证号、密钥等模式。发现问题先处理或向用户确认。
3. **打包**：`shell_run`
   - 仅检查：`python3 <技能目录>/scripts/package_html.py <报告.html> --check-only --strict`
   - 单文件：`python3 <技能目录>/scripts/package_html.py <报告.html> -o deliverables/publish/report.html --fix-meta`
   - 目录形式（适合静态托管）：`--out-dir deliverables/publish/site`（生成 `index.html`）
   脚本会内联本地图片/CSS/JS，列出无法内联的外部资源与缺失文件。
4. **本地预览**：`--serve <端口>` 在 127.0.0.1 启动预览（后台运行），用 `browser_automation` 打开截图检查；检查完后停止进程。
5. **部署**：按 `references/hosting-guide.md` 给出目标平台的步骤。只有在用户明确授权且已有凭据/CLI 登录时，才代为执行部署命令；不要索取或处理密码。
6. **验证发布结果**：拿到链接后用 `browser_automation` 打开，确认页面、图表、中文正常，且访问权限符合预期。
7. **交付**：文件路径、链接（如已部署）、访问范围、更新方法。

## 工具与参数要点

- `shell_run` 检查：`python3 <本技能目录>/scripts/package_html.py <index.html> --check-only [--strict] [--json 结果.json]`，列出外部资源、缺失的本地文件和 meta 问题。`--strict` 下发现问题时退出码为 3
- `shell_run` 打包：`python3 <本技能目录>/scripts/package_html.py <index.html> --out-dir deliverables/publish/site [--fix-meta] [--max-inline MB]`，内联本地资源（单个资源上限默认 10MB，0 表示不限），生成可直接部署的目录
- 本地预览：`--serve 8000` 启动静态服务（`shell_run` 需加 runInBackground），再用 `browser_automation` 访问、截图检查
- 退出码：0 成功，可能带警告；1 输入错误；3 `--strict` 下发现问题
- 公开发布前必须 `ask_user` 确认访问范围，并检查是否含个人信息或内部数据。部署命令见 `references/hosting-guide.md`，由用户在自己的环境执行
- `file_write`：写部署说明 `deliverables/publish/README.md`

## 质量检查
- 打包结果无外部依赖（`--strict` 通过），离线可打开
- 页面有 `<meta charset="utf-8">` 与 viewport，标题正确
- 敏感信息已处理；嵌入数据只保留展示所需的聚合粒度
- 预览截图与原报告一致
- 文件大小合理（建议 < 10MB）

## 失败回退
- 外部资源无法内联（CDN 脚本、远程图片）：下载到本地后重新打包，或替换为本地实现；无法处理时列出并告知用户
- 文件过大：压缩图片、改 SVG、减少嵌入数据
- 无部署权限：交付打包文件 + 平台部署步骤，由用户完成
- 端口占用：换端口重试

## 交付格式
- `deliverables/publish/report.html` 或 `deliverables/publish/site/index.html`
- 对话中：检查结果（外部资源、敏感信息）、预览截图结论、部署步骤或链接
