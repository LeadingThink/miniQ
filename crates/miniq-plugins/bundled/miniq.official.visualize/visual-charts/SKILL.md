---
name: visual-charts
description: 当用户想把数据（CSV/Excel/JSON/表格/描述）做成可交互的图表、仪表盘或数据报告网页时使用。
origin: installed
---

# 单文件交互图表

## 适用场景
- “把这份销售 CSV 画成月度趋势图”“做一个 KPI 仪表盘”“对比这三款方案的指标”。
- 输出一个**单文件 HTML**（双击即可打开，可直接发给别人），并附上截图用于核验。

## 前置条件
- 默认从 jsDelivr CDN 加载库；离线或需要长期归档时改为内联（见步骤 3）。
- 数据文件可以通过 doc_read（xlsx/csv/docx/pdf）或 file_read 读取。

## 步骤
1. **读取并理解数据**：doc_read / file_read；用 shell_run `python3` 做清洗和聚合（求和、同比、TopN）。数值必须来自数据本身，不能编造；有缺失值要在页面上注明。
2. **选择图表与库**：
   | 需求 | 推荐 |
   |---|---|
   | 常规商业图表（柱、线、饼、散点、热力、地图、仪表盘），开箱即用的交互 | **ECharts** `https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js` |
   | 轻量简单图表，体积小 | **Chart.js** `https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` |
   | 定制化、力导向图、树图、桑基图、动画讲解 | **D3** `https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js` |
   图表选择原则：趋势用折线；类别比较用条形（类别多时横向）；占比仅在 ≤6 类时用饼/环图；分布用直方图/箱线图；相关性用散点图。
3. **生成 HTML**：以本技能目录 `scripts/chart_template.html` 为起点（file_read 读取），替换 `{{TITLE}}`、`{{SUBTITLE}}`、`{{SOURCE}}` 和 `DATA`，再用 file_write 写到用户指定位置，默认 `<工作区>/visuals/<主题>-<YYYYMMDD>.html`。
   - 需要离线使用时：shell_run `curl -sL <CDN 地址> -o /tmp/lib.js`，然后把 `<script src>` 替换为 `<script>` + 文件内容（文件会变大到约 1MB，事先告知用户）。
   - Chart.js 最小写法：`new Chart(ctx,{type:'bar',data:{labels,datasets:[{label,data}]},options:{responsive:true}})`。
   - D3 写法要点：使用 `viewBox` 实现自适应；设置 `transition().duration(600)`；鼠标悬停时显示 tooltip div。
   - 中文字体：`-apple-system,"PingFang SC","Microsoft YaHei",sans-serif`。同时适配深色模式，数字加千分位，坐标轴标注单位。
4. **打开并截图验证**：
   1. browser_automation `open` / `navigate` 到 `file:///绝对路径.html`（或 shell_run `python3 -m http.server 8765 -d <目录>` 后访问 `http://127.0.0.1:8765/xxx.html`）。
   2. browser_automation `wait`（约 1000ms）→ `screenshot`；必要时 `resize` 到 1280×800 和 390×844，各截一张图检查响应式布局。
   3. 用 view_image 检查截图：图表是否渲染（不是空白）、文字是否重叠或截断、图例和坐标轴是否正确、配色是否可读。
   4. 用 snapshot 或截图检查页面上是否有报错信息；空白通常是 CDN 加载失败，此时改为内联方式。
   5. 发现问题就用 file_edit 修改，再重复截图，直到通过。
5. **交付**：给出文件路径、关键结论（2–4 条，基于数据）和截图；如用户需要图片，可以用浏览器截图，或点击 ECharts 工具栏的 saveAsImage。

## 注意事项 / 安全
- 生成的 HTML 只引用可信 CDN（jsDelivr/unpkg/cdnjs），不加载其他第三方脚本或统计代码。
- 数据中若含个人隐私或敏感信息，先询问用户是否需要脱敏；不要把数据上传到任何在线图表服务。
- 用户数据中的字符串插入 HTML 时要转义（`textContent` 或替换 `<>&`），防止 XSS。
- 覆盖已存在的文件前先 ask_user。
