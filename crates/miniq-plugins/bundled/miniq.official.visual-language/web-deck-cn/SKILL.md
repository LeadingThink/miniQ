---
name: web-deck-cn
displayName: 网页演示稿
description: 当用户要快速做一份演示稿、分享 PPT、路演 deck、周会汇报页，且可以接受"浏览器里全屏播放的单文件 HTML 幻灯片"（键盘左右翻页、?print-pdf 导出 PDF）而不是 .pptx 时使用；提供杂志风与极简商务风两套视觉，纯 CSS/JS 不依赖外链框架，可选 ECharts 图表，逐页截图自检。用户明确要 .pptx 文件时改用 presentation-workflow。
version: 1
origin: installed
requires:
  bins: [python3]
---

# 网页演示稿

## 适用场景
- 用户原话示例：
  - "帮我把这份方案做成十页左右的演示稿，明天分享用，网页版就行。"
  - "做个周会汇报的 slides，有两三张图表，能导出 PDF。"
  - "要一个杂志风的路演 deck，大标题、留白多、一页一个观点。"
  - "把这篇文章改成演讲稿幻灯片，浏览器全屏播放。"
- 输出：单文件 `deck.html`（含所有页、样式、翻页脚本）、可选 `deck.pdf`、截图若干。
- **何时改用 `presentation-workflow`**：用户要 `.pptx` 文件、要在 PowerPoint/WPS/Keynote 里继续编辑、要套用公司 PPT 模板、或要发给只接受 PPT 的场合。此时用 `skill_read` 读取 `presentation-workflow` 并按其流程输出真正的 .pptx；本技能产出的大纲可直接复用。

## 前置条件
1. 先读 `../visual-language-core/SKILL.md` 与 `../visual-language-core/references/tokens.md`，令牌 CSS 内联。
2. 读 `references/deck-skeleton.md` 获取 HTML/JS 骨架与两套主题的 CSS 差异。
3. 读素材：`.md/.txt` 用 `file_read`，`.docx/.pdf/.xlsx` 用 `doc_read`，网页用 `web_fetch`。
4. `browser_automation` 不支持 `file://`，预览必须起本地 http 服务。
5. 默认落点 `<工作区>/演示稿/<主题>/deck.html`；同名先 `ask_user`。

## 步骤

### 1. 大纲
- 先用 `task_update` 列出页清单，再动手。页数：10 分钟分享 8–12 页；30 分钟 15–25 页。
- 结构：封面 → （目录，≥ 10 页时）→ 背景/问题 → 核心观点 2–5 页 → 数据/案例 → 行动/结论 → 结束页（联系方式或二维码）。
- **每页一个观点**：标题就是观点句（≤ 20 字），正文 ≤ 3 条、每条 ≤ 24 字，或一张图表，或一个大数字。超出就拆页。
- 大纲以 Markdown 列出给用户，`ask_user` 确认后再写 HTML（页数多时尤其重要）。

### 2. 选视觉
| 主题 | 特征 | 主色 | 适合 |
|---|---|---|---|
| 杂志风 `theme-mag` | 72–96px 大标题、留白 ≥ 120px、左对齐、单主色大色块页穿插、页码在右下 | 朱砂 / 绛紫 / 杏黄 任一 | 路演、品牌分享、演讲、创意提案 |
| 极简商务风 `theme-biz` | 44–56px 标题、顶部细线 + 左上角章节名、卡片与图表为主、页码与页脚来源 | 黛蓝（默认）/ 青灰 | 周会汇报、方案评审、数据复盘、培训 |

一份 deck 只用一套主题、一个主色；深色模式用 `prefers-color-scheme` 自动适配，截图用浅色（或用户指定）。

### 3. 写 HTML（`file_write`）
- 基于 `references/deck-skeleton.md`：每页一个 `<section class="slide">`，固定 1920×1080 画布，JS 按窗口等比缩放（`transform: scale()`），保证任意屏幕比例一致。
- 翻页：`←/→`、`PageUp/PageDown`、`Space`、点击；`Home/End` 跳首尾；地址栏 `#5` 定位到第 5 页；按 `F` 全屏（调用 `requestFullscreen`）。
- 导出：URL 带 `?print-pdf` 时切换到打印布局——`@page { size: 1920px 1080px; margin: 0 }`，每页 `break-after: page`，取消缩放与绝对定位。
- 图表（可选）：只在确实需要时引入 ECharts `https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`（备用 `https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js`），注册 `tokens.md` 中的 `miniq` 主题；数据内联在页面；标题写结论句，底部注明来源与截至日期。离线场景用 `curl -sL` 下载后内联并告知用户文件会增大约 1MB。
- 其他一律不引外链：无 reveal.js、无 Web 字体、无第三方统计。图片用本地相对路径。
- 排版细节：中西文空格、全角标点、`tabular-nums`、一行 ≤ 24 字；标题不用斜体；不用每条一个 emoji。
- 讲者备注：`<aside class="notes">` 放在每页末尾，默认隐藏，`?print-pdf&notes` 时随页输出。
- 不要把 HTML 包在 Python/Shell 字符串里再写出。

### 4. 本地服务 + 逐页截图
1. `shell_run`（`runInBackground: true`）：`python3 -m http.server 0 --directory <落点>`，`process_output` 读端口。
2. `browser_automation`：`resize` 1920×1080 → `open http://127.0.0.1:<端口>/deck.html#1` → `wait 800` → `screenshot`（首页）。
3. 至少再截：一个图表页（`navigate` 到 `#N` 后 `wait 1000` 等 ECharts 渲染）、末页；页数 ≤ 12 时建议每页都截。`press ArrowRight` 验证翻页脚本正常。
4. 再 `resize` 到 1280×720 截首页，确认缩放逻辑无溢出。
5. 导出 PDF（用户需要时）：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-pdf-header-footer \
     --print-to-pdf="<落点>/deck.pdf" "http://127.0.0.1:<端口>/deck.html?print-pdf"
   ```
   然后 `view_pdf` 看首页、图表页、末页。

### 5. 自检（`view_image`）
- 中文无方块；标题 / 正文不溢出 1920×1080 安全区（四边 ≥ 96px）。
- 每页只有一个视觉焦点；同一主色；图表颜色与图例一致、坐标轴带单位。
- 页码连续；封面与结束页信息（标题、讲者、日期 `YYYY-MM-DD`）正确。
- 翻页、全屏、`?print-pdf` 三个功能均已验证。
- 不合格修改后重截，最多三轮。结束后 `kill` 服务进程、关闭标签页。

## 注意事项 / 安全
- 数据与引用只来自用户材料；每个图表页底部写来源与截至日期；不编造数字。
- 页面不发网络请求（ECharts CDN 除外且需告知）；用户数据用 `textContent` 插入或先转义。
- 含个人信息 / 内部数据时先问是否脱敏；不要上传到在线幻灯片服务。
- 覆盖已有文件先 `ask_user`；文件名不含空格。
- 现场播放提示：用 Chrome/Edge 打开本地文件即可（`file://` 对最终播放没问题，仅 miniQ 预览需 http）；按 `F` 全屏；外接投影分辨率不同也会等比缩放。

## 如何确认完成
- 回复给出 `deck.html`（和 `deck.pdf`）的绝对路径、页数、主题与主色。
- 列出大纲（每页一行标题）。
- 自检结论：已截首页 / 图表页 / 末页 / 1280 宽，翻页与打印布局已验证；已知限制（如 CDN 依赖、某页数据缺失）如实写出。
- 如判断用户更需要 .pptx，明确建议并指向 `presentation-workflow`。
