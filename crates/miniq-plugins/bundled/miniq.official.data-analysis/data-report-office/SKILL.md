---
name: data-report-office
displayName: 报告导出为 Word / PPT
description: 当用户需要把数据分析报告导出为 Word（docx）或 PowerPoint（pptx）等可编辑的办公文档时使用，包括把 Markdown 报告转成文档、把结论做成汇报幻灯片，以及检查导出后的版式；可替代在线文档或在线幻灯片
version: 1
---

# 报告导出为 Word / PPT

## 触发场景
- “导出成 Word 发给领导”“做几页 PPT 汇报这个分析”“要能继续编辑的版本”
- 用户原本想要 Google Docs / Slides、飞书文档等在线格式：先生成 docx/pptx，再说明如何导入对应平台（在线文档均支持导入 docx/pptx）

## 前置条件
- 已定稿的 Markdown 报告（通常来自 `data-report` 的 `deliverables/report/report.md`）及其引用的图片
- 可选 `python-docx`、`python-pptx`。docx：缺库时脚本用纯标准库直接生成合法 docx，功能基本一致；pptx：缺 python-pptx 时降级为单文件 HTML 幻灯片 `<名>.slides.html`（退出码 2，可翻页、可打印成 PDF）。安装需征得同意：`python3 -m pip install --user python-docx python-pptx`
- 版式规范见 `references/deck-and-doc-guide.md`；脚本参数见 `references/scripts-usage.md`

## 分步流程
1. **确认格式与受众**：Word（阅读型、细节完整）还是 PPT（汇报型、每页一个观点）；是否需要公司模板。不确定时 `ask_user`。
2. **准备源稿**：
   - Word：直接使用报告 Markdown。
   - PPT：`file_write` 另写 `deliverables/report/slides.md`，以 `##` 分页，每页一个结论句标题 + ≤5 条要点或 1 张图；按 `references/deck-and-doc-guide.md` 组织故事线。
3. **导出**：`shell_run`
   - `python3 <技能目录>/scripts/export_office.py deliverables/report/report.md -o deliverables/report/report.docx`
   - `python3 <技能目录>/scripts/export_office.py deliverables/report/slides.md -o deliverables/report/slides.pptx`
   - 需要稳定复现或排查依赖问题时加 `--pure`（或环境变量 `MINIQ_DA_PURE=1`）。支持的 Markdown 元素以 `references/scripts-usage.md` 为准（不支持嵌套列表、行内图片、SVG 图片——先转 PNG）。
   - 退出码：0 成功；1 输入或校验失败；2 pptx 已降级为 HTML 幻灯片（告知用户并提供安装命令）。脚本导出后会自动做结构校验并打印统计。
4. **验证**：
   - `doc_read` 读取生成的 docx/pptx，核对标题层级、表格、数字与源稿一致
   - 版式抽查：如有 LibreOffice（`soffice`），`shell_run` 执行 `soffice --headless --convert-to pdf` 后用 `view_pdf` 检查；否则说明需用户打开确认
5. **套用模板**（可选）：用户提供 `.dotx/.potx` 或样例文档时，说明脚本输出为标准样式（标题 1/2/3、正文、表格），可在 Word/PPT 中一键应用模板样式；需要程序化套用时用 python-docx 基于模板文档另写脚本。
6. **交付**：给出文件路径、页数/章节概要、导入在线文档的方法。

## 工具与参数要点

- `file_read`：确认 Markdown 定稿及其引用的图片路径都存在
- `shell_run`：`python3 <本技能目录>/scripts/export_office.py deliverables/report/report.md -o deliverables/report/report.docx [--format docx|pptx] [--title 标题] [--pure]`
- docx 缺 python-docx 时用纯标准库生成，退出码 0。pptx 缺 python-pptx 时降级为 `<名>.slides.html`，退出码 2；`--pure` 强制走降级路径
- 退出码 1 表示输入错误或校验失败，查看 stderr
- `doc_read`：回读生成的 docx/pptx，核对标题、表格和图片数量。版式可转成 PDF 后用 `view_pdf` 检查
- 安装可选依赖前先 `ask_user`：`python3 -m pip install --user python-docx python-pptx`

## 质量检查
- 标题层级正确（标题 1/2/3），目录可生成
- 表格完整、数字与报告一致；图片清晰不变形
- PPT 每页标题是结论句，文字不溢出，图表可读（字号 ≥ 14pt）
- 文件可被 `doc_read` 正常解析
- 中文字体显示正常（脚本为东亚文字设置字体）

## 失败回退
- python-docx 缺失：纯标准库路径（自动，效果基本一致）
- python-pptx 缺失且用户不同意安装：交付 HTML 幻灯片，说明可在浏览器中演示或打印为 PDF；需要可编辑 PPT 时请用户安装后重跑
- 纯标准库路径下某些元素不支持（如复杂嵌套列表）：简化源稿，或安装依赖后重试
- 无法做视觉检查：交付时说明“已结构校验，未做视觉校验”
- 用户需要 PDF：交给 `data-report-pdf`

## 交付格式
- `deliverables/report/report.docx`、`deliverables/report/slides.pptx`
- 对话中：文件路径、结构概要、校验方式与结果、导入在线平台的说明
