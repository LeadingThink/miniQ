---
name: data-visualize
displayName: 数据可视化
description: 当用户需要把数据做成图表时使用，包括选择合适图型、生成清晰准确的 PNG 或 SVG 静态图、交互式 HTML 图表，以及检查已有图表是否误导，适用于分析过程出图和报告看板配图
version: 1
---

# 数据可视化

## 触发场景
- “画个趋势图”“做个各地区对比图”“这个数据用什么图表示最好”
- 为报告、看板、幻灯片准备配图
- 审查已有图表是否清晰、准确、不误导

## 前置条件
- 已整理好的数据（CSV/JSON，或在分析脚本中的聚合结果）以及要表达的“一句话结论”
- 可选 matplotlib（有则输出 PNG，缺失自动降级为纯 SVG；需要时征得同意 `python3 -m pip install --user matplotlib`）
- 图型选择见 `references/chart-selection.md`；样式与中文字体见 `references/style-guide.md`；脚本参数见 `references/scripts-usage.md`

## 分步流程
1. **先写结论**：每张图对应一句要传达的信息（如“华东贡献了 62% 的增长”）。没有结论的图只是数据展示，放附录。
2. **选图型**：按 `references/chart-selection.md`：趋势→折线；类别对比→条形（排序）；构成→堆叠条/100% 堆叠；分布→直方图/箱线图；关系→散点；变化分解→瀑布；漏斗→漏斗条；矩阵→热力图。饼图最多 5 个扇区。
3. **准备数据**：聚合到图所需粒度，保存 `analysis/figures/<图名>.csv`，保证图可复现。
4. **生成**：
   - 快速标准图：先 `file_read references/scripts-usage.md` 了解字段；用 `file_write` 写规格 `analysis/figures/<名>.json`（`type` 可选 line/bar/hbar/stacked_bar/area/scatter/histogram/pie/heatmap/waterfall/funnel/boxplot；数据可内联 `categories`+`series`，也可用 `csv`+`x`/`y`/`series`/`agg` 直接聚合；`title` 写结论句，可加 `target`、`annotations`、`highlight`、`number_format`）；然后 `shell_run` `python3 <技能目录>/scripts/make_chart.py analysis/figures/<名>.json --validate` 校验，再运行 `python3 <技能目录>/scripts/make_chart.py analysis/figures/<名>.json -o analysis/figures/<名>.png [--backend auto|matplotlib|svg]`。退出码 2 表示规格有误，按 stderr 修正
   - 复杂定制：`file_write` 写 matplotlib 脚本，遵循 `references/style-guide.md`
   - 交互图：写自包含 HTML（内联 SVG + 原生 JS 实现悬浮提示/筛选），不引用 CDN；多图组合优先交给 `data-dashboard`
5. **检查渲染**：PNG/SVG 用 `view_image`（SVG 不支持时用 `browser_automation` 打开 `file://` 截图）；HTML 用 `browser_automation` 打开并截图。逐项核对下方质量检查。
6. **交付**：返回图片路径与每张图的一句话解读；嵌入报告时交给 `data-report`。

## 工具与参数要点

- `file_write`：写 JSON 规格（type、title、数据或 csv 聚合字段）。完整字段见 `references/scripts-usage.md`
- `shell_run` 校验：`python3 <本技能目录>/scripts/make_chart.py spec.json --validate`。退出码 2 表示规格有误，按提示修正
- `shell_run` 出图：`python3 <本技能目录>/scripts/make_chart.py spec.json -o analysis/figures/x.png [--format png|svg|pdf] [--backend auto|matplotlib|svg] [--dpi 200] [--width W --height H]`。规格可以从 stdin 传入（`-`）
- 后端：auto 在有 matplotlib 时使用它，否则走纯 SVG。`MINIQ_DA_PURE=1` 强制走 SVG，png/pdf 输出会改为 `.svg`。指定 `--backend matplotlib` 但缺库时退出码为 3
- `view_image`：每张图生成后都要检查中文显示、坐标轴、标注和截断。检查 SVG 时，可用 `browser_automation` 打开后截图
- 支持 12 种图型：line/area/bar/hbar/stacked_bar/pie/waterfall/scatter/histogram/heatmap/boxplot/funnel

## 质量检查
- 标题是结论句；副标题写口径/时间范围；注明数据来源与截至日期
- 条形/面积图 y 轴从 0 开始；折线图可不从 0 但不能夸大波动
- 轴标签与单位清楚；数字格式合适（千分位、%、万/亿）
- 中文正常显示（无方块）；文字不重叠、不被截断
- 同一实体在多图中颜色一致；突出重点用强调色，其余灰色
- 类别按数值排序（时间除外）；类别过多时取 Top N + 其他
- 避免 3D、双 y 轴（除非必要并清楚标注）、彩虹色图
- 色盲友好：不只靠红绿区分

## 失败回退
- matplotlib 缺失或出错：`--backend svg` 输出纯 SVG（`--backend matplotlib` 在缺库时退出码 3）；需要 PNG 且用户同意时安装 `python3 -m pip install --user matplotlib`
- 中文字体缺失：脚本自动尝试常见 CJK 字体；仍失败时改用 SVG（由浏览器渲染字体），或标签用英文并说明
- 数据点过多（>1 万）：先聚合或抽样；散点图用透明度或六边形分箱
- `view_image` 无法显示 SVG：用 `browser_automation` 打开

## 交付格式
- 图片：`analysis/figures/*.png|svg`，附同名 CSV 数据
- 对话中列出：图片路径、一句话结论、口径说明
