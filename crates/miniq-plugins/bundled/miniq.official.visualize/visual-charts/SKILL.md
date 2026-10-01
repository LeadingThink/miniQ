---
name: visual-charts
displayName: 单文件交互图表
description: 当用户想把数据（CSV/Excel/JSON/表格/描述）做成可交互图表、KPI 仪表盘或数据报告网页，或想直观看懂“变化、对比、分布”时使用；输出单文件 HTML，并经静态检查与浏览器截图自检。
version: 1
---

# 单文件交互图表

## 何时用、何时不用
- **适用**：
  - “把这份销售 CSV 画成月度趋势图”“做一个 KPI 仪表盘”“对比三款方案的指标”。
  - 用户想拖动参数，看结果怎么变。
- **不用画图的情况**：
  - 用户要的是表格：直接回复 Markdown 表格。
  - 只有几个数字：一句话说完。
  - 静态结构（节点和连线就能讲清楚）：用 Mermaid 代码块，或交给 `visual-diagrams`。
- **项目内的开发需求**（给某个网站或组件加图表）：直接在项目代码里实现，不要生成独立文件。
- 图形只有在明显帮助理解时才做，不为了“有图”而做。

## 前置条件
- 库默认从 jsDelivr 加载，并锁定版本。离线或需要长期归档时，改为内联（见步骤 3）。
- 读取数据：xlsx/csv/docx/pdf 用 doc_read，文本文件用 file_read。清洗和聚合用 shell_run 调 `python3`。
- **browser_automation 不支持 `file://`**。预览必须通过 `viz.py serve` 起本地 http 服务。

## 步骤
1. **读懂数据**：
   - 数值必须来自数据本身，不能编造。缺失值、异常值要在页面上注明。
   - 数据很大时，先聚合、分箱或降采样，保证文件 ≤1MB。
2. **选图与选库**：见 `references/chart-guide.md`。
   - 趋势用折线。
   - 类别比较用条形；类别多时用横向条形。
   - 占比：≤6 类时用环图，否则用堆叠条形。
   - 分布用直方图或箱线图。
   - 相关性用散点图。

   | 需求 | 推荐 |
   |---|---|
   | 常规商业图表、仪表盘 | ECharts `https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js` |
   | 轻量、体积小 | Chart.js `https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js` |
   | 定制、统计图、动画讲解 | D3 `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` |
3. **生成 HTML**。二选一：
   - **快速仪表盘**：以 `scripts/chart_template.html` 为起点，替换 `{{TITLE}}`、`{{SUBTITLE}}`、`{{SOURCE}}` 和 `DATA`。
   - **自由构图**：只写正文片段，即 `<div id="唯一id">…</div>` 加 `<script>`，然后运行下面的命令。它会内联设计令牌和工具类（`assets/viz-base.css`），生成整页：
     ```bash
     python3 "<本技能目录>/scripts/viz.py" wrap 片段.html -o 输出.html --title "标题"
     ```
     - 可用的工具类和颜色令牌（`--viz-series-1..6`、`.card`、`.viz-grid`、`.viz-stat` 等）见 `references/design-system.md`。
     - 要写原样的 HTML 标记。**不要**把 HTML 塞进 Python 或 shell 字符串再写出，否则会产生字面量 `\n`、`\"`。
   - 保存位置：用户指定的位置；未指定时用 `<工作区>/visuals/<英文小写-连字符标题>.html`。已存在同名文件时先询问。
   - 离线：执行 `curl -sL <CDN> -o lib.js`，把内容内联进页面。文件会大约增加 1MB，事先告诉用户。
4. **静态检查**：
   ```bash
   python3 "<本技能目录>/scripts/viz.py" check 输出.html
   ```
   检查内容包括：体积、CDN 白名单、禁止网络请求和 `file://`、id 引用、转义残留。出现错误必须修正。
5. **渲染自检**：
   1. 后台启动服务：`python3 "<本技能目录>/scripts/viz.py" serve 输出.html`（shell_run 设 `runInBackground`），用 process_output 读出预览地址。
   2. browser_automation 依次执行：`open` 预览地址 → `wait` 约 1000ms → `screenshot`。再 `resize` 到 1280×800 和 390×844，各截一张。
   3. 用 view_image 检查截图，逐项确认：
      - 图形真的渲染出来了，不是空白。
      - 文字没有重叠或截断。
      - 坐标轴带单位，图例正确。
      - 深色和浅色模式下都可读。
      - 主要交互（悬停、筛选、滑块）确实能更新图形。
   4. 页面空白时，通常是 CDN 加载失败或 JS 报错。用 snapshot 查看页面上的错误提示，修正后再截图，直到通过。
   5. 完成后用 process_kill 结束服务，并关闭标签页。
6. **交付**：见下方“交付格式”。

## 隐私与安全
- 页面只引用白名单 CDN，不加载统计、广告等第三方脚本，不发送网络请求，数据全部内联。
- 数据中有个人信息时，先问用户要不要脱敏。不要把数据上传到在线图表服务。
- 用户数据插入 DOM 时用 `textContent`，或者先转义，防止 XSS。
- 覆盖已有文件之前，先询问用户。

## 交付格式
- 文件的绝对路径，一行。
- 2–4 条基于数据的关键结论。只写图上不容易直接看出来的，不要复述全部数据。
- 渲染自检结果（例如“1280/390 宽度与深色模式均已检查”），需要时附截图。
- 已知限制，例如“3 月数据缺失”。
