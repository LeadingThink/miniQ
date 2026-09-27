---
name: dropbox-files
description: 当用户要读取 Dropbox 文件内容，或把本地文件、刚生成的文档（方案、报告、图片）保存或上传到 Dropbox 时使用；按需先定位文件，写入前确认路径与同名处理方式。
version: 1
---

# Dropbox 文件读取与保存

## 触发场景
- “把这份方案保存到我的 Dropbox 的 /工作/提案 下”“把刚生成的周报上传到 Dropbox”“读一下 Dropbox 里那份合同并总结”。
- 如果只是查找或浏览文件，请用 `dropbox-find`；如果要查看元数据或共享情况，请用 `dropbox-inspect`。

## 前置条件
- 插件启用后会自动接入 MCP 服务器 `dropbox`（`mcp-remote` → `https://mcp.dropbox.com/mcp`）。首次调用时会在浏览器中弹出 Dropbox OAuth 授权，请用户登录并授权后重试。
- 先执行 `mcp_call {server:"dropbox", tool:"tools/list"}` 确认可用工具和参数 schema，工具名以返回结果为准。
- MCP 不可用时，按 `references/mcp-and-rest.md` 的顺序退回：先用本地同步目录（`~/Library/CloudStorage/Dropbox*` 或 `~/Dropbox`），再用 HTTP API（需要用户自行在环境变量中设置 `DROPBOX_ACCESS_TOKEN`，miniQ 不索要、不回显）。
- MCP 目前没有上传工具。保存时按以下优先级：**本地同步目录** → **HTTP API**（需要 `files.content.write` 权限的令牌）。

## 分步流程
1. **定位**：读取文件时，路径不明确就先按 `dropbox-find` 的流程搜索，并让用户确认是哪一个文件。
2. **读取内容**：`mcp_call {server:"dropbox", tool:"fetch", arguments:{...}}`；需要元数据时用 `get_file_metadata`。二进制文件（PDF、图片）若 fetch 无法解析，可以从同步目录读取，或用 HTTP 下载到 `/tmp/miniq-dropbox/`，再用 `doc_read`/`view_pdf`/`view_image` 查看。
3. **准备保存**：确认本地源文件（生成的内容先用 `file_write`/`doc_create` 写到本地，例如 `/tmp/miniq-dropbox/out/方案.docx`）、目标目录，以及同名文件的处理方式（自动改名、覆盖或取消）。目标目录不存在时，按 `dropbox-organize` 的流程在确认后创建。
4. **查重**：用 `list_folder` 或 `get_file_metadata` 检查目标路径是否已有同名文件，把结果告诉用户。
5. **确认**：`ask_user` 展示“本地文件 → Dropbox 目标路径、大小、同名处理方式”。
6. **写入**：
   - 同步目录可用时：用 `shell_run` 执行 `cp` 到 `~/Library/CloudStorage/Dropbox*/<目标>`，等待客户端同步完成。
   - 否则用 HTTP 上传：`ARG=$(python3 <本技能目录>/scripts/dropbox_api_arg.py upload "/工作/提案/方案.docx" --mode add --autorename)`，再执行 `curl "${H[@]}" -X POST https://content.dropboxapi.com/2/files/upload -H "Dropbox-API-Arg: $ARG" -H "Content-Type: application/octet-stream" --data-binary @<本地文件>`。超过 150MB 时改用分块上传（见参考文档）。
7. **回读验证**：用 `get_file_metadata`（MCP）确认文件路径、大小和修改时间；如果触发了自动改名，要告诉用户实际的文件名。
8. **分享（仅在用户要求时）**：交给 `dropbox-share`，不要主动创建链接。
9. **清理**：询问是否删除 `/tmp/miniq-dropbox` 中的临时文件。

## 工具与参数要点
- `dropbox_api_arg.py` 用法：`<操作> <路径> [--mode add|overwrite] [--autorename] [--extra JSON]`，输出纯 ASCII 的 JSON。操作可选 `download`/`upload`/`export`/`get_metadata`。
- 覆盖（`--mode overwrite`）只能在用户明确要求时使用。
- 详见 `references/mcp-and-rest.md`。

## 质量检查
- 回读得到的大小与本地文件一致；最终路径与用户意图一致。
- 读取总结类任务要注明文件路径和修改时间，引用内容不超出原文。

## 失败回退
- OAuth 失败或 MCP 不可用：使用同步目录或 HTTP API；两者都不可用时，把文件保存在本地，并告诉用户手动上传的路径。
- 401 `expired_access_token`：请用户重新生成令牌；409 `path/conflict`：再次确认同名处理方式；403 或权限不足：说明缺少的应用权限。
- 429：按 `Retry-After` 退避后重试。

## 交付格式
- 读取：文件（路径 | 大小 | 修改时间）+ 内容摘要或答案。
- 保存：`已保存到 /工作/提案/方案 (1).docx（24 KB，2025-06-01 10:02）`，并注明是否自动改名、采用的方式（同步目录或 API）。
