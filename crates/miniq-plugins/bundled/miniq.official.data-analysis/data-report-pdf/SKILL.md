---
name: data-report-pdf
description: 当用户需要把数据分析报告导出为 PDF 时使用，包括把自包含 HTML 或 Markdown 报告转成排版良好的 PDF、设置纸张与横竖版、处理分页与中文字体，并对生成的 PDF 做视觉检查
version: 1
---

# 报告导出为 PDF

## 触发场景
- “导出 PDF”“要一份可以打印/归档的版本”“发给外部的定稿”
- 看板或 HTML 报告需要固定快照

## 前置条件
- 输入：自包含 HTML（来自 `data-report`/`data-dashboard`）或 Markdown
- PDF 引擎（脚本自动探测，按顺序）：Chrome/Chromium 无头打印 → wkhtmltopdf → weasyprint。都没有时脚本输出“打印就绪 HTML”，由用户在浏览器中“打印 → 另存为 PDF”
- 分页与打印样式见 `references/print-layout.md`；脚本参数见 `references/scripts-usage.md`

## 分步流程
1. **定稿检查**：确认源 HTML/Markdown 已通过 `data-validate-analysis` 的核心检查；PDF 生成后改动成本更高。
2. **探测引擎**：`shell_run` `python3 <技能目录>/scripts/html_to_pdf.py --detect`。
3. **导出**：`shell_run`
   `python3 <技能目录>/scripts/html_to_pdf.py deliverables/report/report.html -o deliverables/report/report.pdf [--paper A4|Letter] [--landscape] [--margin 12]`
   - 宽表格或看板用 `--landscape`
   - 输入为 Markdown 时脚本先转换为 HTML（可加 `--title`）
   - 排查样式问题时加 `--keep-html` 保留中间文件
4. **检查结果**：
   - 退出码 0：用 `view_pdf` 查看首页、含图表页、含宽表页、末页
   - 退出码 2：无可用引擎，已生成打印就绪 HTML；告诉用户路径与浏览器打印步骤，或征得同意后安装引擎（如 `python3 -m pip install --user weasyprint`，注意其系统依赖）
5. **修正问题**：分页切断表格/图片、页边距、字体缺失等，按 `references/print-layout.md` 在源 HTML 中调整（`file_edit`）后重新导出。
6. **交付**：PDF 路径、页数、检查结论。

## 工具与参数要点

- `shell_run`：`python3 <本技能目录>/scripts/html_to_pdf.py <输入.html|.md> -o deliverables/report/report.pdf [--paper A4|Letter] [--landscape] [--margin 12] [--engine auto|chrome|wkhtmltopdf|weasyprint|none] [--timeout 60] [--title 标题] [--keep-html]`
- `--margin` 单位为 mm（默认 12）。引擎按 auto 的顺序探测：Chrome/Chromium → wkhtmltopdf → weasyprint。可以用环境变量 `MINIQ_CHROME` 指定浏览器路径
- 退出码 0 表示已生成 PDF。退出码 2 表示没有可用引擎（或指定了 `--engine none`），已降级输出 `.print.html`，需要告知用户在浏览器中打印为 PDF
- `view_pdf`：逐页检查分页、表格截断、图片和中文字体。`doc_read` 可抽取文字核对数字
- 输入是 Markdown 时，先用 `<插件目录>/data-report/scripts/build_report.py` 生成 HTML，打印样式效果更好
- 大文档或慢机器上要加大 `--timeout`；超时后改用其他引擎，或走 `.print.html` 降级路径

## 质量检查
- 中文无乱码或方块；图片完整、清晰
- 标题不孤立在页底；表格与图片不被从中间切断（或表头在续页重复）
- 页边距合理，宽表不溢出
- 链接与目录（如有）可用
- 数字与源报告一致（抽查 2–3 处）

## 失败回退
- 没有任何引擎：交付打印就绪 HTML + 手动打印指引（退出码 2 属预期降级）
- Chrome 打印超时：加大 `--timeout`，或检查 HTML 是否引用了无法访问的外部资源（先用 `data-publish-html` 的打包脚本内联资源）
- 字体缺失：在 HTML 的 `font-family` 中加入系统已有的中文字体
- `view_pdf` 不可用：`doc_read` 读取文本做结构检查，并说明未做视觉检查

## 交付格式
- `deliverables/report/report.pdf`（降级时为打印就绪的 `deliverables/report/report.print.html`，退出码 2）
- 对话中：路径、使用的引擎、页数、视觉检查结论
