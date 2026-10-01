---
name: dropbox-inspect
description: 当用户要了解某个 Dropbox 文件或文件夹的详情时使用：查看元数据（大小、修改时间、ID、内容哈希）、已有共享链接及其可见范围，并读取内容做摘要或回答问题。
version: 1
---

# Dropbox 文件详情检查

## 触发场景
- “这个文件什么时候改的、有多大”“这个文件夹有没有被分享出去”“这个共享链接指向什么、谁能访问”“帮我看看这份文档讲了什么”。

## 前置条件
- 插件启用后会自动接入 MCP 服务器 `dropbox`（`mcp-remote` → `https://mcp.dropbox.com/mcp`）。首次调用时会在浏览器中弹出 Dropbox OAuth 授权，请用户登录并授权后重试。
- 先执行 `mcp_call {server:"dropbox", tool:"tools/list"}` 确认可用工具和参数 schema，工具名以返回结果为准。
- MCP 不可用时，按 `references/mcp-and-rest.md` 的顺序退回：先用本地同步目录（`~/Library/CloudStorage/Dropbox*` 或 `~/Dropbox`），再用 HTTP API（需要用户自行在环境变量中设置 `DROPBOX_ACCESS_TOKEN`，miniQ 不索要、不回显）。

## 分步流程
1. **确定对象**：拿到路径、ID 或共享链接。只有名字时，先按 `dropbox-find` 的流程定位并确认。
2. **元数据**：`get_file_metadata` → 类型、大小、`server_modified`、`client_modified`、`id`、`content_hash`、共享信息（如 `sharing_info`、只读标记）。
3. **共享情况**：用 `list_shared_links`（传入路径，遇到 `has_more` 时用 cursor 取完所有页）列出链接，并给出可见范围（公开、团队、密码保护）、过期时间和访问级别；用户给出的是链接时，用 `get_shared_link_metadata` 解析它指向的内容和设置。
4. **内容**：需要时用 `fetch` 读取，进行摘要或问答；大文件只读取相关部分，图片和 PDF 按 `dropbox-files` 的方式在本地查看。
5. **风险提示**：发现公开链接、没有过期时间、指向包含敏感信息的文件夹时，提醒用户，并建议通过 `dropbox-share` 或网页端调整（本技能不做修改）。
6. **输出**：按交付格式汇总。

## 工具与参数要点
- 文件夹的“大小”需要递归统计，只有用户明确需要时才做，并且要限制范围。
- 版本历史：MCP 暂不提供，如有需要可以用 HTTP `files/list_revisions`（需要令牌），或让用户在网页端查看。

## 质量检查
- 时间统一换算成用户时区并注明；共享链接必须分页取完，不遗漏。
- 摘要忠于原文，关键数字附带原文位置。

## 失败回退
- 链接已失效或无权访问：如实说明，不猜测内容。
- MCP 不可用：使用同步目录（只能看到本地元数据）或 HTTP `files/get_metadata`、`sharing/list_shared_links`。

## 交付格式
```
### /项目/报价单.xlsx
- 大小 84 KB｜修改 2025-05-30 18:20（UTC+8）｜ID id:xxxx
- 共享链接：2 个（公开 1，无过期 ⚠；团队 1）
- 内容摘要：……
- 建议：……
```
