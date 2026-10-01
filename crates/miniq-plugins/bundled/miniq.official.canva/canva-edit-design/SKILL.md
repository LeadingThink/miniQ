---
name: canva-edit-design
description: 当用户要修改某个已有 Canva 设计时使用：改错字、替换或翻译文字、换图/插图/删元素、调整字号粗细颜色对齐行距列表、移动或缩放元素、改标题。这是其他 Canva 技能共用的安全编辑引擎（事务 → 操作 → 预览 → 确认后提交）
version: 1
---

# Canva 设计编辑（事务式安全编辑引擎）

## 触发场景
- “把第 2 页标题改成‘双十一狂欢’”“把所有 2024 改成 2025”。
- “换掉封面图”“删掉右下角的二维码”“标题加粗、改成红色、居中”。
- “把 Logo 往左移一点、放大 20%”“改一下设计名称”。
- 其他技能（`canva-implement-feedback`、`canva-translate-design`、`canva-brand-check` 的修复环节）需要写入设计时，也按本技能的协议执行。

## 前置条件
- `canva` MCP 已启用并登录（见 `canva-design-studio`）。
- 用户对该设计有编辑权限（仅查看的分享链接无法编辑）。
- 需要读 `references/operations.md`（操作的 JSON 结构）和 `references/limits.md`（能力边界、响应式页面限制）。

## 事务协议（固定顺序）
1. `start-editing-transaction`（`design_id`）→ 记住 `transaction_id` 和返回的 `pages` 数组，后续调用都要带上；**把返回的缩略图展示给用户**。
2. `perform-editing-operations`（`transaction_id`、`pages`、第一个被修改页的 `page_index`、`operations` 数组）→ 能合并的操作一次提交。
3. `commit-editing-transaction`（`transaction_id`）→ 保存。提交后该 `transaction_id` 失效，再改需要新事务。
4. `cancel-editing-transaction` → 放弃草稿（用户不满意，或只是打开看一眼）。

未提交的草稿会**永久丢失**；只要开了事务，结束时必须提交或取消其一，并告诉用户结果。

## 分步流程
1. **定位设计**：按 `canva-design-studio/references/design-resolution.md`。
2. **开事务并检查**：`start-editing-transaction`，展示缩略图；从返回的 `richtexts`（文字元素）与 `fills`（图片/视频填充）里找到要改的 `element_id`，记下每个元素所在页、当前文字、位置尺寸。
   - 只是查看 → 立刻 `cancel-editing-transaction` 结束。
3. **核对能力边界**：对照 `references/limits.md`：
   - 在 CANNOT 列表里的需求（换字体族、加新文本框、改背景色、增删/重排页面、动画、编组、改形状颜色）→ 直接告诉用户需在 Canva 编辑器手动完成，不要变通尝试。
   - 目标页 `is_responsive: true` → 只允许 `update_title`、`replace_text`、`find_and_replace_text`、`update_fill`、`delete_element`；其他操作不要发出，改为告诉用户。
4. **确认范围**：`find_and_replace_text` 可能命中多处时，先列出命中位置问用户要改哪些；`delete_element` 或大范围替换同样先确认。
5. **构造并执行操作**：按 `references/operations.md` 组 JSON，一次 `perform-editing-operations`。替换图片先有 `asset_id`（本地图片需先有公网 URL → `upload-asset-from-url`，上传前确认）。
6. **预览**：展示返回的新缩略图 + 一个“改动清单”（页码、元素、原值 → 新值）。检查：文字是否溢出/被截断、换行是否难看、图片是否裁切了关键主体、元素是否越出画布。
7. **审批关卡**：问“以上改动保存到设计吗？”，等用户明确同意再 `commit-editing-transaction`。
   - 若调用方技能已在前面取得“一次性批准”（如 `canva-implement-feedback`），视为已覆盖提交，不再重复询问。
   - 用户要微调 → 在同一事务里继续 `perform-editing-operations`，再预览。
   - 用户拒绝 → `cancel-editing-transaction`，并告知草稿已丢弃。
8. **交付**：提交成功后才能说“已保存”，给出编辑链接（`get-design` 的 `urls.edit_url`）。

## 失败回退
- `perform-editing-operations` 报元素不存在 → 重新从 `pages`/`richtexts` 取 ID，不要猜。
- 报操作不支持（常见于响应式页面）→ 去掉该操作重试其余，未完成项列入“需手动处理”。
- 提交失败 → 草稿已丢失；重新开事务重做一遍（改动清单仍在，可直接复用），仍失败则把改动清单交给用户手动完成。
- 事务长时间闲置可能过期 → 重开事务。

## 输出交付格式
```
## 已更新：<设计标题>
| 页 | 元素 | 修改前 | 修改后 |
|---|---|---|---|
| 1 | 主标题 | 夏季促销 | 双十一狂欢 |
编辑链接：<edit_url>
需在 Canva 中手动处理：
1. 第 3 页标题字体改为思源黑体（API 无法修改字体族）→ 选中标题 → 顶部字体下拉 → 选择字体
```
