---
name: canva-branded-presentation
displayName: Canva 品牌演示文稿生成
description: 当用户要把大纲、会议纪要、简报文档或已有 Canva 文档做成符合品牌的演示文稿（PPT、路演稿、汇报稿）时使用：整理成逐页计划，套用 Canva 品牌工具包生成候选，用户选定后创建可编辑的设计
version: 1
---

# Canva 品牌演示文稿生成

## 触发场景
- “用这份会议纪要做一份 Q1 汇报 PPT，用我们的品牌风格”。
- “把这个大纲做成 10 页路演稿”“把 Canva 里那份文档转成演示文稿”。

## 前置条件
- `canva` MCP 已启用并登录。
- 使用品牌工具包需要账号有品牌工具包（通常为 Canva 团队/企业类套餐）；没有则按普通 `generate-design` 生成，并告知用户。
- query 写法与示例见 `references/presentation-brief.md`。

## 分步流程
1. **获取内容来源**（任一）：
   - 用户直接粘贴的文字/大纲。
   - 本地文件：`doc_read` 读取（docx/pdf/md/txt）。
   - Canva 设计/文档：链接或 `D` 开头 ID → 按 `canva-design-studio/references/design-resolution.md` 定位后 `get-design-content` 读取全文；只有名称 → `search-designs` 查找，多个结果让用户选。
2. **确认要点**（缺失时一次性问清，已给出的不重复问）：受众、用途（汇报/路演/培训）、期望页数、语言、必须出现的数据或页面。
3. **选品牌工具包**：`list-brand-kits` → 只有一个直接使用；多个用 `ask_user` 让用户选；没有或报权限错误 → 说明情况后不带 `brand_kit_id` 继续。
4. **编写逐页计划**：按 `references/presentation-brief.md` 组织为三段：演示简报 → 叙事主线 → 逐页计划。大纲稀疏时主动扩写（每页 3–6 个要点 + 演讲备注），但不得编造数据；缺数据处用“[待补充：xx 数据]”占位并告知用户。
5. **（可选）先给用户过目计划**：页数 ≥ 12 或内容来自用户草稿需大量扩写时，先展示逐页标题列表让用户确认。
6. **生成候选**：`generate-design`，参数 `design_type: "presentation"`、`query: <完整计划>`、`brand_kit_id`（若有）。
7. **展示候选**：列出每个候选的缩略图/预览链接，让用户选一个。
8. **创建设计**：`create-design-from-candidate`（`job_id`、`candidate_id`）→ 得到设计 ID 与编辑链接。
9. **核验**：`get-design-content` 抽查标题与页数是否符合计划；`get-design-thumbnail` 查看首页。明显缺页或内容错位时告知用户，并提供：用 `canva-edit-design` 修正文字，或调整 query 重新生成。
10. **交付**：见下方格式。若用户需要 PPTX/PDF 文件，转 `canva-design-studio` 的导出流程（`export-design` 后 `curl -L -o` 下载）。

## 质量检查
- 页数与计划一致（允许 ±1，需说明）；每页标题与计划对应。
- 所有数字均来自来源材料；占位符已列在交付说明里。
- 语言与用户要求一致；中文稿不混入未翻译的英文模板文字。

## 失败回退
- `generate-design` 不支持 `brand_kit_id` 或报错 → 去掉该参数重试一次，并在 query 的“风格指南”中写明品牌主色与字体（来自用户）。
- 生成结果过短（页数不足）→ 精简 query 中的冗余描述、明确“共 N 页”后重试；仍不足则分两次生成（前半/后半）并告知用户需手动合并。
- 候选都不满意 → 询问偏好（配色、版式密度、图片多少）后重写风格指南再生成。
- 提示：需要按数据批量填充模板属于 `canva-brand-batch`（依赖企业版自动填充），不在本技能范围。

## 输出交付格式
```
## 演示文稿已创建：<标题>
- 页数：12 ｜品牌工具包：<名称 / 未使用>
- 编辑链接：<edit_url>
- 逐页概览：1 封面 ｜2 议程 ｜3 市场现状 …
- 待补充：第 5 页“同比增长率”数据（原材料未提供）
- 下一步可选：导出 PPTX/PDF、评审（canva-design-feedback）、改尺寸或翻译副本
```
