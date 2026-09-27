# scripts 使用说明：export_office.py

把 Markdown 报告导出为 Word（.docx）或 PowerPoint（.pptx）。导出后会自动校验文件结构。

## 快速开始

```bash
S=scripts/export_office.py
python3 $S report.md                         # → report.docx
python3 $S report.md -o out/report.docx
python3 $S report.md -o out/deck.pptx        # 按扩展名推断格式
python3 $S report.md --format pptx
python3 $S report.md -o r.docx --pure        # 强制纯标准库（等同 MINIQ_DA_PURE=1）
```

## 引擎与降级

| 目标 | 首选 | 降级 |
|---|---|---|
| docx | python-docx | 纯标准库用 zipfile 手写最小合法 docx（样式、编号、表格、图片都会写入），**功能基本一致**，退出码 0 |
| pptx | python-pptx | 生成单文件 HTML 幻灯片 `<名>.slides.html`：←/→ 翻页，Ctrl/Cmd+P 打印时每页一张。退出码 **2**，并提示 `python3 -m pip install --user python-pptx` |

设置 `--pure` 或 `MINIQ_DA_PURE=1` 会强制走降级路径，可用于测试或在无第三方库的环境运行。

## 支持的 Markdown

- `#`/`##`/`###` 标题（更深的层级按 3 级处理）、段落、`**粗体**`、`*斜体*`、`` `代码` ``；链接输出为“文字（URL）”
- 有序和无序列表（单层）、`>` 引用、代码块、`---` 分隔线
- 管道表格（支持 `:---:` 对齐语法；docx 的表头会加粗并填充底色）
- 单独成行的本地图片 `![说明](chart.png)`：支持 PNG/JPEG，相对路径以 Markdown 所在目录为基准；docx 中最大宽度 6 英寸

## pptx 拆页规则

- 第一个 `#` 标题作为封面标题，其后的段落作为副标题（为空时填写当天日期）
- 每个 `#`/`##` 小节生成一页要点页，每页最多 8 条，超出部分放到“（续）”页
- 小节中的每个表格单独成页（最多 15 行数据），每张图片也单独成页并等比居中
- 页面尺寸为 16:9（13.333 × 7.5 英寸）

## 校验输出

- docx：检查 zip 完整性、所有 XML 是否可解析，并统计段落、标题、表格和图片数量
- pptx：检查 zip 完整性和 slide XML，并统计幻灯片、表格和图片数量
- 退出码：`0` 成功；`1` 输入错误或校验失败；`2` pptx 已降级为 HTML

## 已知限制

- 不支持嵌套列表、脚注、数学公式、HTML 片段或行内图片；远程图片会显示为占位文字
- 纯标准库生成的 docx 使用 A4 纸张和固定样式，不支持模板（`--reference-doc`）
- 图片尺寸按 96 DPI 换算，SVG/GIF/WebP 不能嵌入，请先转为 PNG
