# scripts 使用说明：package_html.py

把 HTML 报告打包为可离线打开、可静态托管的单文件，并做发布前检查。仅依赖 Python 3.9+ 标准库。

## 快速开始

```bash
S=scripts/package_html.py
python3 $S report.html --check-only                 # 只检查，不写文件
python3 $S report.html                              # → report.packaged.html
python3 $S report.html -o dist/report.html --fix-meta
python3 $S report.html --out-dir site --fix-meta    # → site/index.html，并打印部署提示
python3 $S report.html --out-dir site --serve 8000  # 打包后在 http://127.0.0.1:8000/ 本地预览
```

## 参数

| 参数 | 说明 |
|---|---|
| `-o, --output` | 输出单文件，默认为 `<名>.packaged.html`（不会覆盖输入文件） |
| `--out-dir DIR` | 输出 `DIR/index.html`，适用于 GitHub Pages / Netlify / Vercel / Cloudflare Pages / Nginx |
| `--check-only` | 只输出检查报告 |
| `--fix-meta` | 自动补上 `<meta charset="utf-8">` 和 viewport |
| `--max-inline MB` | 单个资源的内联上限，默认 10MB，设为 0 表示不限；超出的资源保持原样并在报告中列出 |
| `--strict` | 存在外部资源、缺失的本地文件或缺少 charset 时，退出码为 3（适合 CI 门禁） |
| `--json PATH` | 另外输出一份 JSON 报告 |
| `--serve PORT` | 使用 `http.server` 预览，只监听 127.0.0.1，按 Ctrl+C 结束 |

## 内联范围

- `<link rel=stylesheet>` 会转为 `<style>`；CSS 中本地的 `@import` 会递归内联，`url()` 会转为 data URI（相对路径以该 CSS 文件所在位置为基准）
- `<script src>` 会转为内联脚本（其中的 `</script` 会被转义）
- `<img>`/`<source>`/`<video poster>`/`<audio>`/`<track>`/`<embed>` 的 `src`，以及 `<link rel=icon>`，都会转为 data URI
- `style="...url(...)"` 行内样式同样处理
- 本地 `srcset` 不内联，会被移除（保留 `src`），并在报告中注明

## 检查项

- **残留外部资源**：`src`/`href`/`poster`/`data` 以及 CSS 中的 `@import`、`url()`，凡以 `http://`、`https://` 或 `//` 开头的都会列出。它们在离线或网络受限时会失效，建议下载到本地后重新打包
- **外链**：`<a href>` 和 canonical 等导航类链接单独列出，属于正常情况
- 缺失的本地文件、文件大小（超过 5MB 给出警告；超过 25MiB 会提示超出 Cloudflare Pages 单文件上限）、`meta charset`、viewport、`<title>`、`<!DOCTYPE html>`

## 退出码

- `0`：成功（可能带警告）
- `1`：输入错误
- `3`：在 `--strict` 模式下发现问题

## 已知限制

- 基于正则表达式处理 HTML，而不是完整的 DOM 解析。遇到非常规写法（例如属性值中含 `>`）时可能漏处理
- 不会下载外部 CDN 资源，只做报告；JS 中动态拼接的资源路径无法识别
- 同一张图片被多次引用时会重复内联，体积随之增大
