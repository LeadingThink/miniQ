---
name: dropbox-file-request
description: 当用户要通过 Dropbox 向他人收集文件时使用：创建文件请求（标题、目标文件夹、截止时间），查看已有请求及其状态和收到的文件；创建前确认，只提供链接，不代为发送。
version: 1
---

# Dropbox 文件请求（收集文件）

## 触发场景
- “建一个链接让候选人上传作品集”“向客户收集签署后的合同，放到 /客户/A/回传”“我之前建的文件请求都有哪些，收到了多少文件”。

## 前置条件
- 插件启用后会自动接入 MCP 服务器 `dropbox`（`mcp-remote` → `https://mcp.dropbox.com/mcp`）。首次调用时会在浏览器中弹出 Dropbox OAuth 授权，请用户登录并授权后重试。
- 先执行 `mcp_call {server:"dropbox", tool:"tools/list"}` 确认可用工具和参数 schema，工具名以返回结果为准。
- MCP 不可用时，按 `references/mcp-and-rest.md` 的顺序退回：先用本地同步目录（`~/Library/CloudStorage/Dropbox*` 或 `~/Dropbox`），再用 HTTP API（需要用户自行在环境变量中设置 `DROPBOX_ACCESS_TOKEN`，miniQ 不索要、不回显）。

## 分步流程
1. **查已有请求**：`list_file_requests`，看是否已有同一用途的请求（标题、目标目录、是否开放），避免重复创建；需要详情时用 `get_file_request`。
2. **收集参数**：标题（上传者可见，要清楚描述要收集什么）、目标文件夹（不存在时按 `dropbox-organize` 的流程在确认后创建）、截止时间（可选，注意时区；是否支持以 schema 为准）、说明文字。
3. **确认**：`ask_user` 展示参数和提示：任何拿到链接的人都可以上传；上传者看不到目标目录中的其他文件；收到的文件会占用用户的空间。
4. **创建**：`create_file_request`，记下返回的请求 ID 和链接。
5. **核验**：用 `get_file_request` 确认标题、目标路径、截止时间和开放状态。
6. **跟踪**：之后用 `get_file_request` 查看收件数量，用 `list_folder` 列出目标文件夹中收到的文件（上传者、时间，以 metadata 为准）。
7. **交付**：给出链接和可以直接转发的邀请文案；不代为发送邮件或消息。
8. **关闭或修改**：MCP 没有关闭或修改工具时，指导用户在网页端的“文件请求”页面操作；有令牌时可以用 HTTP `file_requests/update`（需确认）。

## 工具与参数要点
- 目标文件夹建议专用，便于区分和跟踪，不要直接使用包含敏感资料的目录。
- 截止时间要换算成用户时区并注明。

## 质量检查
- 不重复创建同用途的请求；创建后已核验。
- 邀请文案写清楚要交什么、文件格式、截止时间和命名要求。

## 失败回退
- 账户或团队策略禁止文件请求：说明原因。
- MCP 不可用：使用 HTTP `file_requests/create`、`list_v2`、`get`（需要 `file_requests.write/read` 权限）。

## 交付格式
```
文件请求已创建：「请上传签署后的合同」
链接：https://www.dropbox.com/request/...
收件目录：/客户/A/回传｜截止：2025-06-30 18:00（UTC+8）
可转发文案：……
```
