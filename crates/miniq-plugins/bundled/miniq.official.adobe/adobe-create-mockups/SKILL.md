---
name: adobe-create-mockups
displayName: 品牌样机生成（Adobe Firefly）
description: 当用户想把 logo、草图或设计稿放到马克杯、T 恤、名片、手机屏、海报等产品上生成一整套品牌样机，或先从零设计/润色 logo 再出样机时使用；基于 Adobe Firefly 生成。
version: 1
---

# 品牌样机生成（Adobe Firefly）

## 触发场景
- “把这个 logo 做成一套样机：杯子、帽衫、名片”“我手绘了个草图，帮我润色后出几张产品效果图”。
- 还没有设计稿，想先生成一个 logo，再出样机。
- 只改图片尺寸请用 `adobe-create-social-variations`；套用模板排版请用 `adobe-design-from-template`。

## 前置条件
- MCP：`adobe-creativity` 已连接并登录（见 `adobe-creativity-cloud`），调用方式为 `mcp_call {"server":"adobe-creativity","tool":"...","arguments":{...}}`。
- **工具名以 `tools/list` 为准**。常见名称：
  - `image_generate`（Firefly 生图，支持 `options.referenceImage`）
  - `boards_create_new_board`、`boards_add_items_to_board`、`asset_share_link`（Firefly 看板）
  - 本地设计稿需要先上传，用 `asset_initialize_file_upload` / `asset_finalize_file_upload`
- 这是生成式功能，会消耗 Firefly 生成额度；需告知用户并获得同意。
- 回退：Firefly 不可用时，可用 miniQ `edit_image`（以设计稿为输入，描述产品场景）或 `generate_image` 生成近似样机；也可用 Photoshop 智能对象样机模板配合 `adobe-desktop-scripting` 替换内容。

## 分步流程
1. **初始化**：先 `tools/list`；若有 `adobe_mandatory_init`，传 `{"skill_name":"adobe-create-mockups","skill_version":"1"}`。
2. **获取设计稿**：
   - 用户已提供：用上传流程拿到云端 URL，记为 `designAssetUrl`。
   - 没有设计稿：`ask_user` 选择“上传已有设计 / 从零设计”。从零设计时先问品牌名、风格、颜色，再调用：
     `image_generate {options:{prompt, aspectRatio:"1:1", n:1, promptReasoner:"quality"}, outputFileType:"png"}`
     反复迭代直到用户满意。
3. **品牌画像**：尽量推断，少提问。
   - 品牌色：从设计稿中提取；无法判断时用中性色 `#FFFFFF`、`#111111`、`#E8E4DC`。
   - 调性：极简 / 活泼 / 奢华 / 大胆 / 自然。
   - 品牌名：只有用户明确说出时才能写进画面。
   - 产品清单和画幅：用户没指定时，一次 `ask_user` 同时问“产品（按品牌类型推荐 4–5 个，见参考）+ 画幅（方形 / 横 / 竖 / 自动）”。
4. **草图审阅**（仅限手绘或模糊稿）：询问“直接使用 / 先润色”。润色调用：
   `image_generate {options:{prompt:"<保留原构思的干净矢量风 logo 描述>", referenceImage:designAssetUrl, n:1, promptReasoner:"quality"}, outputFileType:"png"}`
   用户认可后，把新图作为 `designAssetUrl`。
5. **先写全部提示词**：按 `references/mockup-scenes.md` 的模板，为每个产品写场景提示词（内部使用，不展示给用户）。全套共用同一组品牌色、光线和材质，保证风格统一。
6. **试产 1 张**：
   - 调用 `image_generate {options:{prompt, referenceImage:designAssetUrl, n:1, promptReasoner:"quality"}, outputFileType:"png"}`。
   - **带 `referenceImage` 时不要传 `aspectRatio`/`size`**，画幅写进提示词里。
   - 展示结果，请用户从 场景/光线、logo 位置与大小、整体调性 三方面确认。未获认可前不要继续。
7. **批量生成**：
   - 用户没有修改意见：原样使用第 5 步的提示词。
   - 用户有修改意见：更新所有提示词，并连同试产那张一起重做。
   - 每轮最多并行 5 个；遇到限流就减小批量继续。
8. **看板（可选）**：
   - `boards_create_new_board {doc_name:"<品牌> 样机"}` → `boards_add_items_to_board {board_id, ...}`（每次最多 12 项）→ `asset_share_link` 生成分享链接。
   - 失败时只注明看板不可用，样机照常交付。
9. **下载与交付**：`curl -L -o adobe/out/mockups/<品牌>_<产品>.png <URL>`，用 `view_image` 自查后一次性展示全套。

## 质量检查与失败回退
- 逐张检查：
  - logo 是否保持原样（形状、配色没有被改写）
  - 是否贴合在产品表面（透视、材质、褶皱）
  - 尺寸是否合理，没有悬浮或过大
  - 有没有凭空出现文字或假品牌名
- 不合格的单张用加强版提示词重生成一次，比如补充“logo 印在正面中央，约占 30%，随布料褶皱自然起伏”。
- 失败处理：
  - 试产失败，或整批全部失败：停止，说明可能是套餐或登录问题，**不要改为纯文字描述设计来凑合**。
  - 部分产品失败：跳过并明确列出。
  - 401：请用户重新登录。
  - 看板 5xx：重试一次。

## 输出交付格式
```
✅ 已生成 <N> 张样机（调性：<极简/…>，品牌色：#xxxxxx …）
| 产品 | 文件 | 状态 |
| 马克杯 | adobe/out/mockups/acme_mug.png | ✅ |
| 帽衫 | — | ❌ 生成失败（已跳过） |
Firefly 看板：<分享链接或“不可用”>
可继续：换场景 / 换调性 / 增加产品 / 调整 logo 大小
```
