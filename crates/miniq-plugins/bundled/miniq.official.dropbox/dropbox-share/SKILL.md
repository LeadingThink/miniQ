---
name: dropbox-share
description: 当用户明确要求分享 Dropbox 内容时使用：为指定文件或文件夹创建共享链接（例如 PDF 分享链接），查看已有链接和链接元数据；优先复用已有链接，从不自动创建，成员邀请需到网页端操作。
version: 1
---

# Dropbox 共享链接

## 触发场景
- “给这份 PDF 生成一个分享链接”“这个文件已经有分享链接了吗”“这个链接谁能看、什么时候过期”。
- 用户没有明确要求分享时不要使用本技能；只想了解共享情况时用 `dropbox-inspect`。

## 前置条件
- 插件启用后会自动接入 MCP 服务器 `dropbox`（`mcp-remote` → `https://mcp.dropbox.com/mcp`）。首次调用时会在浏览器中弹出 Dropbox OAuth 授权，请用户登录并授权后重试。
- 先执行 `mcp_call {server:"dropbox", tool:"tools/list"}` 确认可用工具和参数 schema，工具名以返回结果为准。
- MCP 不可用时，按 `references/mcp-and-rest.md` 的顺序退回：先用本地同步目录（`~/Library/CloudStorage/Dropbox*` 或 `~/Dropbox`），再用 HTTP API（需要用户自行在环境变量中设置 `DROPBOX_ACCESS_TOKEN`，miniQ 不索要、不回显）。

## 分步流程
1. **定位对象**：确认要分享的是哪一个文件或文件夹（`dropbox-find`），并用 `get_file_metadata` 核实。
2. **查已有链接**：`list_shared_links`（传入路径）；有 `has_more` 时用 cursor 继续获取，直到取完。已有符合要求的链接就直接复用，不重复创建。
3. **确认**：没有可用链接时，`ask_user` 说明：分享对象、可见范围（默认按账户策略，常见为“有链接即可查看”）、风险（任何拿到链接的人都可能访问，文件夹链接会暴露其中全部内容）。用户需要密码或过期时间时，要说明 MCP 是否支持这些参数（以 schema 为准）。
4. **创建**：用户同意后调用 `create_shared_link`。
5. **核验**：用 `get_shared_link_metadata` 确认链接指向和可见范围与预期一致。
6. **交付**：给出链接及其设置；如果用户要把链接发给他人，只提供链接文本，不代为发送。
7. **撤销**：MCP 没有撤销工具。需要撤销时，指导用户在网页端的“共享”→“链接”中关闭；有令牌时也可以用 HTTP `sharing/revoke_shared_link`（需确认）。

## 工具与参数要点
- 按邮箱把文件夹共享给指定成员（协作者邀请）目前不可用，需指导用户在 Dropbox 网页端或客户端操作。
- 不修改已有链接的可见范围，除非用户明确要求并确认。
- 团队可能禁止对外公开链接，遇到这种报错时如实说明。

## 质量检查
- 没有在用户未要求的情况下创建任何链接；复用的链接与创建的链接都经过元数据核验。
- 对文件夹链接、敏感文件给出显著的风险提示。

## 失败回退
- 创建失败（策略限制或权限不足）：说明原因，建议使用团队内链接或网页端的高级设置。
- MCP 不可用：使用 HTTP `sharing/list_shared_links`、`create_shared_link_with_settings`（返回 `shared_link_already_exists` 时改为列出已有链接），需要 `sharing.write` 权限。

## 交付格式
```
已为 /合同/2025-报价.pdf 提供共享链接（复用已有 / 新建）：
https://www.dropbox.com/...
可见范围：有链接者可查看｜过期：无｜密码：无
提示：拿到链接的任何人都可以查看；撤销方法：……
```
