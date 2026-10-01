---
name: data-report
description: 当用户需要把数据分析整理成正式报告时使用，包括面向管理层的高管摘要版和面向分析师的技术版，含结论先行的叙事、图表、KPI、方法与附录，输出 Markdown 与自包含 HTML，并可继续导出 PDF、Word 或 PPT
version: 1
---

# 数据分析报告

## 触发场景
- “把分析写成报告”“给老板一份结论”“出一份可以发给团队的分析文档”
- 其他分析技能（诊断、KPI、产品分析、市场测算）的最终呈现
- 需要复核后再导出 PDF/Word/PPT 或发布网页

## 前置条件
- 已完成的分析结果（数字、图表、脚本）；若尚未分析，先用对应分析技能
- 明确受众：高管版 或 技术版（不确定时 `ask_user`，默认高管版 + 技术附录）
- 结构规范见 `references/executive-spec.md` 与 `references/technical-spec.md`；写作规范见 `references/writing-guide.md`；脚本见 `references/scripts-usage.md`

## 分步流程
1. **确定受众与目的**：读者是谁、读完要做什么决定、阅读时长（高管 2 分钟 / 分析师 20 分钟）。
2. **收集证据**：`file_glob` 汇总 `analysis/` 下的结果 Markdown、JSON、图表；列出每条候选结论及其证据来源（文件路径、脚本、查询）。没有证据的结论不写。
3. **搭骨架**：按受众选择规范，先写 3–5 条关键结论（金字塔原则：结论 → 支撑 → 证据），再排列章节。
4. **补图表与 KPI**：缺图用 `data-visualize` 生成；KPI 卡片数据来自 `kpi_scorecard.py` 或分析 JSON。每张图配一句解读。
5. **写正文**：`file_write` 写 `deliverables/report/report.md`，按 `references/writing-guide.md`：先答案后细节、数字带口径与对比、事实与推断分开、局限写在结论旁。
6. **渲染 HTML**：`shell_run`
   `python3 <技能目录>/scripts/build_report.py deliverables/report/report.md --out deliverables/report/report.html [--title ...] [--assets data.json]`
   支持目录生成、打印样式、图片内联，以及 `{{chart:id}}`、`{{kpis:id}}` 占位（参数见 `references/scripts-usage.md`）。
7. **自查**：`browser_automation` 打开 `file://` 路径截图检查版式、图表、中文；过 `data-validate-analysis` 清单（至少：关键数字复算、图表规范、结论不过度）。
8. **导出与发布**（按需）：PDF → `data-report-pdf`；Word/PPT → `data-report-office`；网页托管 → `data-publish-html`。
9. **交付**：给出文件路径、3 行摘要、可信度评级与需告知读者的说明。

## 工具与参数要点

- `file_write`：写 `deliverables/report/report.md`（可带 front matter），需要时写 `assets.json`（charts、kpis、meta）
- `shell_run`：`python3 <本技能目录>/scripts/build_report.py deliverables/report/report.md --out deliverables/report/report.html [--assets assets.json] [--title 标题] [--no-inline] [--no-toc] [--toc-depth 3]`
- 占位符 `{{chart:id}}` 和 `{{kpis:id}}` 必须单独成行。kpis 可以引用 kpi_scorecard 的 JSON；复杂图型先用 make_chart.py 生成图片，再在 assets 中写 `{"image": 路径}` 引用
- 退出码：0 成功；1 输入错误，不会生成文件；2 已生成但有警告（图片缺失、占位符未知等），必须逐条处理。脚本纯标准库，`MINIQ_DA_PURE=1` 时行为相同
- `browser_automation`：打开生成的 HTML，截图检查。数字复核用 `file_read` 对照 `analysis/` 下的结果
- 需要 docx/pptx 时交给 `data-report-office`，需要 PDF 时交给 `data-report-pdf`

## 质量检查
- 第一段就回答核心问题，含关键数字与时间范围
- 每条结论都能对应到证据（图、表、脚本输出）
- 术语、指标名称、单位全文一致；百分比与百分点区分
- 图表有标题（结论句）、来源、截至日期
- 局限、假设、未验证项明确列出
- HTML 自包含（图片内联，无外部 URL），打印版式正常

## 失败回退
- 证据不足以支撑某结论：降级为“待验证假设”或删除
- 图片过大导致 HTML 体积过大：压缩或改 SVG；或在 `--no-inline` 模式下引用相对路径并与报告一起打包
- 渲染脚本失败：直接交付 Markdown，并说明错误；或用 `data-report-pdf` 的 Markdown 模式
- 读者需要可编辑格式：交给 `data-report-office`

## 交付格式
- `deliverables/report/report.md` + `report.html`（+ 可选 pdf/docx/pptx）
- 对话中：摘要、文件清单、可信度评级、注意事项
