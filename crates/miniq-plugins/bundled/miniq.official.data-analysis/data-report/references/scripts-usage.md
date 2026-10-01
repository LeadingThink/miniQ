# build_report.py 使用说明

把 Markdown 报告（可以附带一份 assets JSON）渲染成一个单文件、自包含的 HTML。本地图片会以 base64 内联，内置目录和打印样式，可以直接用浏览器打开，也可以交给 `data-report-pdf` 转成 PDF。脚本只用 Python 3.9+ 标准库，`MINIQ_DA_PURE=1` 时行为不变。

## 命令行

```
python3 <本技能目录>/scripts/build_report.py <report.md | -> [--out report.html] [--title 标题]
        [--assets assets.json] [--no-inline] [--no-toc] [--toc-depth 3]
```

| 参数 | 说明 |
|---|---|
| `input` | Markdown 文件；传 `-` 时从标准输入读取，相对路径按当前目录解析 |
| `--out/-o` | 输出 HTML 路径，默认与输入同名、扩展名为 `.html`。不能与输入相同，也不能是目录 |
| `--title` | 文档标题。优先级：本参数 > front matter 的 `title` > 第一个一级标题 |
| `--assets` | assets JSON 文件，为 `{{chart:id}}` 和 `{{kpis:id}}` 占位符提供数据 |
| `--no-inline` | 不内联本地图片，保留相对链接（相对于输出文件所在目录） |
| `--no-toc` / `--toc-depth` | 不生成目录；或指定目录收录的最深标题级别（默认 3） |

**退出码**：0 表示成功；1 表示输入错误，此时不会生成文件；2 表示已经生成，但有警告，例如图片找不到、占位符 id 不存在、数据不是数值，警告会逐条打印到 stderr。退出码为 2 时必须逐条处理警告，或在报告中说明原因。

## Markdown 支持范围

- 标题（`{#自定义id}` 可指定锚点）、段落、粗体/斜体/行内代码、链接、自动链接、图片、引用、有序/无序/嵌套列表、代码块、分隔线、GFM 表格。表格中的数值列会自动右对齐。
- 提示框：在引用块的第一行写 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`，也可以用中文 `[!说明]`、`[!提示]`、`[!重要]`、`[!注意]`、`[!警告]`。
- 分页：单独一行写 `<!-- pagebreak -->`（也可以写 `page-break` 或 `分页`），打印或转 PDF 时从这里换页。
- 原始 HTML 会被转义，不会执行，因此可以安全渲染不可信的文本。

## front matter

文件开头可以写：

```
---
title: 2024 年 6 月经营分析
subtitle: 结论先行版
author: 数据分析组
date: 2024-07-03
source: 订单宽表、CRM
period: 2024-06-01 ~ 2024-06-30
version: v1.2
---
```

author、date、source、period、version 会显示在标题下方的元信息栏中。date 缺省时取今天的日期。

## assets JSON

```json
{
  "meta": {"source": "front matter 未写时作为补充"},
  "kpis": {
    "core": {"title": "核心指标（6 月）", "note": "口径见附录", "kpis": [
      {"label": "GMV", "value": 12850000, "target": 12000000, "delta": 0.083, "status": "ok"},
      {"label": "转化率", "value": 0.032, "format": "percent", "delta": -0.002, "delta_type": "absolute",
       "good_direction": "up", "definition": "支付订单 / 访客"}
    ]},
    "scorecard": "analysis/kpi/scorecard.json"
  },
  "charts": {
    "trend": {"type": "line", "title": "GMV 连续 3 个月增长", "x": ["4月","5月","6月"],
              "series": [{"name": "2024", "data": [1150, 1120, 1285]}], "y_label": "万元", "labels": true,
              "source": "订单宽表"},
    "mix": {"type": "stacked", "x": ["Q1","Q2"], "series": {"服饰": [30,35], "数码": [20,22]}},
    "fig": {"image": "analysis/figures/funnel.png", "title": "转化漏斗", "caption": "由 make_chart 生成"}
  }
}
```

- **KPI 组**：
  - 组对象包含 `title`、`note` 和 `kpis` 数组。
  - 组的值也可以是一个 JSON 文件路径，文件内容可以是 `kpi_scorecard.py --json-out` 的输出，脚本会自动识别其中的 value、target、change_pct、status 等字段。
- **KPI 卡片字段**：
  - `label`/`name`、`value`、`format`：format 可选 number、integer、percent、currency。
  - `decimals`、`unit`、`compact`：compact 默认 true，数值会自动换算成万或亿。
  - `currency_symbol`、`target`、`attainment`。
  - `delta`（比例）、`delta_type`：delta_type 为 relative 或 absolute；percent 类指标用 absolute 时显示为 pp。
  - `delta_label`、`good_direction`：good_direction 为 up、down 或 neutral，决定涨跌显示红色还是绿色。
  - `status`：可选 ok、watch、risk，也可以写中文"正常、关注、风险"。
  - `note`、`definition`：definition 会显示为悬浮提示。
- **图表**：
  - 内置的纯 SVG 图表支持 `type`：line、area、bar、stacked、hbar；bar 加 `"stacked": true` 等同于 stacked。
  - 数据写法：`x` 或 `categories` 是类别，`series` 可以是 `[{name,data}]`，也可以是 `{名称:[...]}`，还可以直接写 `y` 数组；`null` 表示缺失值。
  - 可选字段：`format`、`labels`（显示数据标签）、`zero`、`y_min`、`y_max`、`width`（默认 720）、`legend`、`title`、`subtitle`、`y_label`、`caption`、`source`、`as_of`。
  - 其他图型：先用 `data-visualize` 的 make_chart.py 生成图片，再通过 `{"image": "路径"}` 引用；值直接写成字符串路径也可以。

## 在 Markdown 中引用

单独一行写 `{{chart:trend}}` 或 `{{kpis:core}}`，会生成块级图表或 KPI 卡片组。id 不存在时占位符按原文保留，退出码为 2；占位符必须单独成行，写在行内会按普通文本保留并告警；assets 中未被引用的条目只打印提示。

## 示例

```
python3 <本技能目录>/scripts/build_report.py deliverables/report/report.md \
  --assets deliverables/report/assets.json --out deliverables/report/report.html
# 生成后用 browser_automation 打开 file:// 路径并截图检查；需要 PDF 时交给 data-report-pdf
```

## 已知局限

- 不支持脚注、数学公式和 Mermaid。需要复杂图表时，先生成图片再引用。
- 内置 SVG 只支持 5 种图型，不支持双轴。
- 远程图片（http/https）不会下载内联，而是保留链接，离线打开时无法显示。
