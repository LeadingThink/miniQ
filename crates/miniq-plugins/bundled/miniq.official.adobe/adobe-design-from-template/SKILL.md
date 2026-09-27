---
name: adobe-design-from-template
description: 当用户想用 Adobe Express 模板快速做海报、传单、邀请函、社媒图、名片等设计（搜索模板、填文案、换图、改背景色、加动画、导出 PDF）时使用。
version: 1
---

# 用 Adobe Express 模板做设计

## 触发场景
- “做一张周末咖啡市集的海报”“用模板做个生日邀请函”“帮我出一版招聘传单并导出 PDF”。
- 用户已经有 Express 模板或文档链接，想修改文案、背景色，或做成动画。
- 需要把自己的 logo 放到实物上请用 `adobe-create-mockups`；只需把现成图片改尺寸请用 `adobe-create-social-variations`。

## 前置条件
- MCP：`adobe-creativity` 已连接并登录（见 `adobe-creativity-cloud`），调用方式为 `mcp_call {"server":"adobe-creativity","tool":"...","arguments":{...}}`。
- **工具名以 `tools/list` 为准**。常见名称：`search_design`、`fill_text`、`replace_image`、`change_background_color`、`animate_design`、`download_design`。缺哪个，就不提供对应功能。
- Express 文档存放在 Adobe 云端，通常约 12 小时后会被清理，要提醒用户及时下载或在编辑器中另存。
- 本地回退：没有模板库时，可用 Illustrator/Photoshop 脚本在本地模板里替换文字（见 `adobe-desktop-scripting`），或用 miniQ 的 `generate_image` 生成草图。

## 分步流程
1. **理解需求**：用途、尺寸/平台、主标题、副标题、日期地点、品牌色、语气。先从对话中提取，只用 `ask_user` 问缺的关键项（通常是文案）。
2. **搜索模板**：
   - `search_design {generalQuery:"<英文或中文关键词>", pageSize:10, startIndex:0}`。
   - 关键词写法见 `references/template-fill-rules.md`。无结果时逐步放宽（去掉风格词，只留用途词）。
3. **展示并等待用户选择**：
   - 列出编号、标题、预览链接、是否付费（`isPremium`）。
   - **绝不替用户自动选模板。**
   - 用户说“再来一些”时，用同一关键词、`startIndex += pageSize` 翻页。
   - 返回里有 `importantNote` 时优先遵循。
4. **填文案**：
   - `fill_text {templateURN, description:"<要填入的完整文案与层级>", generalQuery:"<去掉个人隐私的用途描述>"}`。
   - 失败重试一次。
   - 之后的每一步都用**最新返回的 `documentURN`**。
5. **换图（可选）**：
   - `replace_image {templateOrDocumentURN, description:"<要替换哪个元素、换成什么画面>", generalQuery}`。
   - 一次只换一个元素，只接受文字描述，不能直接用用户上传的图或 URL。
   - 这是生成式能力，可能不可用，失败时要告知用户。
6. **改背景色（可选）**：`change_background_color {templateOrDocumentURN, backgroundColor:"#RRGGBB", description, generalQuery}`。若返回多个 `variations`，全部展示让用户挑选。
7. **动画（可选）**：`animate_design {templateOrDocumentURN, description, generalQuery}`。返回动画预设和变体后展示给用户；403 表示当前套餐不含。
8. **导出**：
   - `download_design {documentUrn:"<最新 URN>", format:"application/pdf", pages:"1,3-5"}`，注意参数名大小写以工具 schema 为准。
   - 每页返回一个 `downloadUrl`，可用 `curl -L -o adobe/out/design/<名称>_p1.pdf` 下载。
   - 已加动画的设计请用户在编辑器里导出 MP4/GIF，不导出 PDF。
9. **交付**：给出编辑器链接，方便用户继续手工微调。

## 质量检查与失败回退
- 用 `view_pdf` 或 `view_image` 检查导出结果：文字是否溢出或被截断、中文是否缺字（模板字体可能不含中文，需提示换字体）、日期电话是否与用户给的一致。
- URN 只能来自工具返回，禁止自己拼写或猜测。
- 错误处理：
  - 401：请用户重新登录。
  - 403：该功能不在套餐内，跳过并说明。
  - 搜索无结果：放宽关键词。
  - 单页导出失败：交付成功的页面并注明。
  - 填文案两次失败：给出编辑器链接，请用户手工填写。
- 发给工具的 `generalQuery` 中不要带手机号、住址等个人信息。

## 输出交付格式
```
✅ 设计已完成
模板：<标题>（<免费/付费>）
已做修改：填写文案 / 替换<元素> / 背景色 #xxxxxx / 动画<预设>
在线编辑：<editorUrl>
PDF：第1页 <URL 或 adobe/out/design/xxx_p1.pdf>
⚠️ Express 临时文档约 12 小时后清理，请尽快下载或另存。
```
