# scripts 使用说明：html_to_pdf.py

把 HTML 或 Markdown 报告导出为 PDF。仅依赖 Python 3.9+ 标准库；渲染引擎按 **Chrome/Chromium → wkhtmltopdf → WeasyPrint** 顺序自动探测。三者都不可用时，降级输出带“打印”按钮的 HTML，由用户在浏览器中手动另存为 PDF。

## 快速开始

```bash
S=scripts/html_to_pdf.py
python3 $S --detect                          # 查看本机可用引擎
python3 $S report.html                       # 输出 report.pdf（A4 纵向，边距 12mm）
python3 $S report.md -o out/report.pdf       # Markdown 先转 HTML 再导出
python3 $S wide.html --paper Letter --landscape --margin 8
```

## 参数

| 参数 | 说明 |
|---|---|
| `input` | `.html`/`.htm`/`.md` 文件 |
| `-o, --output` | 输出 PDF 路径，默认与输入同名 |
| `--paper A4\|Letter` | 纸张，默认 A4 |
| `--landscape` | 横向 |
| `--margin MM` | 页边距（毫米），默认 12 |
| `--engine auto\|chrome\|wkhtmltopdf\|weasyprint\|none` | 指定引擎；`none` 直接走降级。也可以用环境变量 `MINIQ_PDF_ENGINE` 设置 |
| `--timeout S` | 单个引擎的超时秒数，默认 60 |
| `--title` | Markdown 转换时使用的文档标题 |
| `--keep-html` | 保留中间文件 `<名>.miniq-print.html`，便于排查问题 |
| `--detect` | 只打印引擎探测结果 |

可以用环境变量 `MINIQ_CHROME` 或 `CHROME_PATH` 指定浏览器可执行文件。

## 退出码

- `0`：PDF 已生成并通过校验（%PDF 文件头、%%EOF 结尾、大小 > 1KB），同时打印大小和粗略页数
- `1`：输入错误，或生成的 PDF 未通过校验
- `2`：已降级为 `<输出去掉 .pdf>.print.html`（如 report.pdf → report.print.html）。页面顶部有打印按钮；URL 加上 `#print` 会自动弹出打印对话框

## 工作方式

1. 注入 `@page`（纸张/方向/边距）与 `@media print` 样式：避免表格行、图片和标题跨页断开，表头在每页重复，打印时保留背景色。
2. Chrome 使用 `--headless=new --print-to-pdf --no-pdf-header-footer`，失败时回退到旧版 headless 参数。每次运行使用独立的临时用户目录。
3. 部分 Chrome 版本写完 PDF 后不会退出，脚本检测到 PDF 完整且大小稳定后会主动结束 Chrome 进程。

## 常见问题

- **图表空白**：ECharts/Plotly 动画还没结束就开始打印了。请关闭动画（`animation:false`），或改用静态图片。
- **中文方块字**：系统缺少中文字体。安装 Noto Sans CJK，或在 CSS 中指定本机已有的字体。
- **外部 CDN 资源**：离线时会加载失败。建议先用 `data-publish-html/scripts/package_html.py` 内联本地资源。
- 安装引擎：macOS 装 Google Chrome，或 `brew install --cask wkhtmltopdf`；Linux 用 `apt install chromium`；也可用 `python3 -m pip install --user weasyprint`（需要系统有 pango）。

## 已知限制

- 页数通过统计 `/Type /Page` 得出，只是估计值。
- 内置的 Markdown 转换较简单：不支持嵌套列表、脚注和数学公式。复杂文档建议先自行转为 HTML。
- WeasyPrint 不执行 JavaScript，JS 渲染的图表会是空白。wkhtmltopdf 的内核较旧，对现代 CSS/JS 支持有限。
