---
name: cn-typography
displayName: 中文排版美化
description: 当用户要把 Markdown、纯文本或 docx 内容排版成美观、可打印的 HTML、PDF 或 docx（公文、工作报告、合同、学术论文、营销文案）时使用；包含文体判断、主色与版式选择、中文细节检查（中西文空格、全角标点、孤行、数字格式）与截图自检。不用于做图表、信息图、海报或幻灯片。
version: 1
origin: installed
requires:
  bins: [python3]
---

# 中文排版美化

## 适用场景
- 用户原话示例：
  - "把这份 Markdown 排成能打印的 PDF，要像正式报告。"
  - "这个合同 docx 太丑了，帮我重新排版。"
  - "帮我把这篇公众号文案做成好看的网页版，手机上看也行。"
  - "按公文格式排一下这个通知，红头、落款都要。"
- 输入：`.md`、`.txt`、`.docx`、对话中粘贴的文字。输出：HTML（必有）、PDF 和/或 docx（按需）。
- 不适用：做数据图表（`visual-charts`）、信息图（`infographic-cn`）、海报（`poster-cn`）、幻灯片（`web-deck-cn`）。

## 前置条件
1. 先读 `../visual-language-core/SKILL.md` 与 `../visual-language-core/references/tokens.md`，令牌 CSS 直接内联到 HTML。
2. 读本技能 `references/genres.md`，确认五种文体的版式参数。
3. 读源文：`.md`/`.txt` 用 `file_read`；`.docx`/`.pdf` 用 `doc_read`。
4. 导出 PDF 需要本机有 Chromium 内核浏览器（Chrome/Edge/Chromium）；用 `shell_run` 检查：
   `ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null || which chromium chromium-browser google-chrome`
5. 字体：macOS 自带 PingFang SC；Linux 用 `fc-list :lang=zh | head` 检查，为空则提示安装 `fonts-noto-cjk`。
6. 默认落点 `<工作区>/排版/<文件名>.html|.pdf|.docx`，用户另有指定则遵从；同名文件存在时先 `ask_user`。

## 步骤

### 1. 判断文体
按内容特征归入一种文体，不确定时 `ask_user` 让用户选：

| 文体 | 特征 | 默认主色 | 页宽 / 字号 |
|---|---|---|---|
| 公文 | 通知、函、请示、红头、落款、附件 | 朱砂 `#C8323B`（仅红头与分隔线） | A4，正文 16px 仿宋/宋体风格，正文居中对齐标题 |
| 报告 | 摘要、章节编号、图表、结论建议 | 黛蓝 `#2B4C7E` | 820px，正文 16px |
| 合同 | 甲乙方、条款编号、签章区 | 青灰 `#6C7A89` | A4，正文 15px，条款两端对齐 |
| 学术 | 摘要、关键词、参考文献、脚注 | 青灰或黛蓝 | A4，正文 15px，参考文献 13px |
| 营销文案 | 短句、金句、分段小标题、行动号召 | 用户品牌色，否则杏黄 `#E8A33D` | 680px，正文 17px，移动端优先 |

细节参数（页边距、标题样式、页眉页脚、段距）见 `references/genres.md`。

### 2. 选主色与版式
- 一份文档只用一个主色；主色只用在标题、强调、分隔线、页眉。
- 用户给了品牌色就用品牌色，否则按文体默认。
- 决定是否需要：封面页、目录、页眉页脚页码、落款签章区、附件列表。

### 3. 生成 HTML
1. 文字转 HTML：Markdown 用 `shell_run` 执行 `python3 -c "import markdown"` 检查库是否存在，有则用 `markdown` 转换，无则手写语义化 HTML（`h1–h3`、`p`、`ol/ul`、`table`、`blockquote`）。docx 用 `doc_read` 得到结构化文本后重排。
2. 用 `file_write` 写单文件 HTML，`<style>` 中依次内联：`tokens.md` 的令牌 CSS → 文体专属 CSS（见 `references/genres.md`）→ 打印样式：
   ```css
   @page { size: A4; margin: 25mm 20mm; }
   @media print {
     body { background: #fff; color: #000; }
     h1, h2, h3 { break-after: avoid; }
     p, li { orphans: 3; widows: 3; }
     table, figure, blockquote { break-inside: avoid; }
     a { color: inherit; text-decoration: none; }
   }
   ```
3. 正文容器 `max-width` 按文体表设置；`text-align: justify` 只用于合同、学术；`word-break: break-all` 禁止，用 `overflow-wrap: anywhere` 处理长 URL。
4. 不引用任何外链字体和脚本，保证离线可打开。

### 4. 中文细节检查（必做）
用 `shell_run` 跑一遍 `python3` 正则检查并修正，或人工核对：
- 中西文之间加一个空格：`销售额1200万元` → `销售额 1,200 万元`；但全角标点与西文之间不加。
- 标点全角：`,.:;!?()` 在中文句中换成 `，。：；！？（）`；省略号 `……`，破折号 `——`，引号 `""''`。
- 数字：千分位或"万/亿"（`12,345` 或 `1.2 万`），百分号与数字之间不加空格，单位与数字之间加空格；日期 `YYYY-MM-DD` 或 `YYYY 年 M 月 D 日`，一份文档只用一种。
- 孤行：段落末尾不留单字成行，必要时微调措辞或容器宽度；标题不落在页底（已由 `break-after: avoid` 处理）。
- 层级：标题最多三级；编号风格统一（`一、` `（一）` `1.` 或 `1.1`）；公文用 `一、（一）1.（1）`。
- 一行正文 40–50 个汉字；行高 1.7–1.8；段间距 1em，不首行缩进（公文除外，公文首行缩进 2 字符）。

### 5. 导出
- **HTML**：步骤 3 的产物即交付物。
- **PDF**（二选一）：
  - `shell_run` 调 Chromium headless（路径按步骤前置条件的检查结果替换）：
    ```bash
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
      --no-pdf-header-footer --print-to-pdf="<工作区>/排版/文件名.pdf" "file://<绝对路径>/文件名.html"
    ```
    需要页码时去掉 `--no-pdf-header-footer`，并在 CSS 中用 `@page { @bottom-center { content: counter(page); } }`（Chromium 支持有限，页码不出现时改用 JS 分页器或在交付时说明）。
  - 或用 `browser_automation`：`shell_run`（`runInBackground: true`）执行 `python3 -m http.server 0 --directory <目录>` 并用 `process_output` 读端口 → `open` 地址 → `press` `Meta+P`（macOS）打开打印对话框，由用户选择"存储为 PDF"。此路径需要用户参与，优先用上面的命令行方式。
- **docx**：用 `doc_write` 写 `.docx`，`content` 用 Markdown 标题结构传入；docx 的字号、颜色由 `doc_write` 默认样式控制，无法完全复现 HTML 版式，交付时说明"docx 为可编辑版，视觉以 PDF 为准"。

### 6. 截图自检
1. 本地服务（同上）→ `browser_automation` `open` → `wait 800` → `screenshot`；`resize` 到 390×844 再截一张（营销文案必做）。
2. PDF 用 `view_pdf` 看首页、任一跨页处、末页。
3. `view_image` 逐项核对：中文无方块、标题不落页底、表格不被截断、页边距均匀、只有一个主色、公文红头与落款位置正确。
4. 不合格修改后重截，最多三轮。
5. 结束后台服务进程（记下 PID，`shell_run` 执行 `kill <PID>`）并关闭标签页。

## 注意事项 / 安全
- 不改写用户原文内容和数据；只调整格式、标点与空格。改了措辞（为消孤行）要在交付时列出。
- 合同、公文属于正式文件：排版后提醒用户逐条核对条款编号、金额、日期、落款；不要擅自补写缺失条款。
- 覆盖已有文件前 `ask_user`；文件名禁止空格。
- 文档含个人信息（身份证号、手机号）时，询问是否脱敏后再生成 PDF。
- 不要把 HTML 塞进 Python/Shell 字符串再写出，用 `file_write` 直接写原样 HTML，避免产生 `\n`、`\"` 字面量。

## 如何确认完成
- 回复中给出各产物绝对路径（HTML 必有；PDF/docx 按用户要求）。
- 一句话说明：判定的文体、采用的主色、页宽与正文字号。
- 中文细节检查结果：修正了多少处空格/标点/数字格式。
- 自检结论：桌面 / 移动端 / PDF 哪几项已查看；未解决的限制（如 docx 版式差异、页码缺失）如实写出。
