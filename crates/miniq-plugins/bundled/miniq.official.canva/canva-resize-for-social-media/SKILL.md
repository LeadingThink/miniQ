---
name: canva-resize-for-social-media
description: 当用户想把一个 Canva 设计一次性改成多个社交平台尺寸（Facebook、Instagram、LinkedIn、小红书、抖音、微信公众号等）时使用：按平台预设尺寸并行生成副本，原稿不动，汇总每个版本的编辑链接
version: 1
---

# Canva 多平台社媒尺寸适配

## 触发场景
- “把这张海报改成各个社媒平台的尺寸”“做一套 Instagram 帖子和快拍版本”。
- “这张图还要发小红书和公众号封面”。
- 只要一个尺寸时也可用，但单尺寸复制更简单，可直接用 `canva-design-studio`。

## 前置条件
- `canva` MCP 已启用并登录；当前 MCP 工具列表中存在 `resize-design`（不存在时告诉用户当前连接不支持改尺寸，并建议在 Canva 编辑器用“调整尺寸”功能）。
- 部分账号的改尺寸功能需要 Canva 付费套餐；报权限错误时如实告知。
- 平台尺寸表见 `references/platform-sizes.md`。

## 分步流程
1. **定位源设计**：
   - `D` 开头的 ID → 直接用；完整 URL → 取 `/design/` 后的 ID；短链 → `resolve-shortlink`。
   - 只给名称 → `search-designs`（用用户原话作为 query），多个结果让用户选。
   - 对话中刚创建/编辑过的设计 → 默认用它（一句话确认）。
2. **读取源信息**：`get-design` → 标题、页数、确认可访问；`get-design-thumbnail` 看原始构图（横/竖/方）。
3. **选择平台**：展示默认五种（Facebook 帖子、Facebook 快拍、Instagram 帖子、Instagram 快拍、LinkedIn 帖子）及国内常用平台选项，让用户勾选；用户说“全部/所有社媒”即用默认五种。用户已在请求中明确平台则不再询问。
4. **并行改尺寸**：对每个选中格式调用一次 `resize-design`：
   ```json
   {"design_id": "DAxxxx", "design_type": {"type": "custom", "width": 1080, "height": 1350}}
   ```
   - 尺寸严格取自 `references/platform-sizes.md`；同尺寸的格式（如 Facebook 快拍与 Instagram 快拍）仍各建一份，并告诉用户它们尺寸相同。
   - 各调用互不依赖，可同一轮并发发出。
   - 单个失败不影响其他；记录失败原因。
   - 若工具支持标题参数，命名为“<原标题> - <平台格式>”；不支持则在报告里标明对应关系。
5. **检查结果**：对每个新设计 `get-design-thumbnail` 查看；重点看构图大改的格式（横 → 竖、方 → 超宽）：主体是否被裁、文字是否越出安全区、是否出现大片空白。
6. **可选修正**：发现问题时说明，并提供：
   - 用 `canva-edit-design` 对该副本移动/缩放元素（`position_element`、`resize_element`，响应式页面除外）。
   - 或建议在 Canva 编辑器中手动微调。
7. **可选导出**：用户需要图片文件时，对每个副本 `export-design`（`png`/`jpg`），`curl -L -o out/<平台>.png "<下载链接>"` 下载。
8. **交付**。

本流程中途不需要额外确认（改尺寸只创建副本，不修改原稿），除非出错。

## 质量检查
- 每个格式的尺寸与表中数值一致（`get-design` 返回的宽高核对）。
- 原设计未被修改。
- 失败格式单独列出并附原因。

## 失败回退
- `resize-design` 报不支持该设计类型（如视频、白板、文档）→ 告知并建议在编辑器中处理。
- 报配额/套餐限制 → 停止剩余调用，报告已成功的部分。
- 结果构图严重变形 → 建议从空白尺寸新建，或用 `generate-design` 以原设计文案按新尺寸重新生成。

## 输出交付格式
```
## 已生成 5 个社媒尺寸版本（源：<原标题>）
| 平台格式 | 尺寸 | 编辑链接 | 检查 |
|---|---|---|---|
| Facebook 帖子 | 1200×630 | [在 Canva 中编辑](edit_url) | 正常 |
| Instagram 快拍 | 1080×1920 | [在 Canva 中编辑](edit_url) | 底部文字接近边缘，建议上移 |
| … | | | |
说明：Facebook 快拍与 Instagram 快拍尺寸相同（1080×1920）。
失败：无
```
编辑链接取自 `resize-design` 返回的 `urls.edit_url`（缺失时用 `get-design` 查询）。
