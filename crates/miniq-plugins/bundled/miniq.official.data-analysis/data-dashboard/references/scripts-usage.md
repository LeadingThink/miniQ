# build_dashboard.py 使用说明

`scripts/build_dashboard.py` 把一份 JSON 规格（spec）渲染成**单个自包含的 HTML 看板**：CSS、JS、SVG 图表全部内联，不引用任何 CDN、字体或图片 URL，可离线打开、作为附件发送或打印成 PDF。

- 仅依赖 Python 3.9+ 标准库（不需要 pandas / matplotlib）。
- 中文使用系统字体栈（PingFang SC / Microsoft YaHei / Noto Sans CJK 等），无需额外字体。
- 所有文本都会做 HTML 转义；嵌入页面的 JSON 数据会转义 `</`，防止 `</script>` 注入。

## 快速开始

```bash
S=<插件目录>/data-dashboard/scripts/build_dashboard.py

# 1) 只校验规格，打印摘要，不写文件
python3 "$S" spec.json --validate

# 2) 生成看板
python3 "$S" spec.json --out deliverables/dashboard/index.html
```

| 参数 | 说明 |
|---|---|
| `spec` | 规格 JSON 路径（必填）。规格中的相对路径（CSV、scorecard JSON）一律**相对 spec 文件所在目录**解析 |
| `--out` / `-o` | 输出 HTML 路径，默认是 spec 同目录下的 `index.html`；父目录会自动创建 |
| `--validate` | 只校验并打印摘要（KPI/图表/表格/筛选器数量、外部引用检查结果、预计 HTML 大小），不生成文件 |
| `--quiet` / `-q` | 成功时不打印摘要（警告和错误仍输出到 stderr） |

建议流程：先 `--validate`，确认没有错误和意外的警告后再生成，最后在浏览器中打开检查一遍。

## 完整示例

目录结构：

```
work/
├── spec.json
└── data/
    ├── sales.csv        # 月份,区域,渠道,营收,订单数,退款率
    ├── stores.csv       # 门店,区域,客单价,复购率,评分
    └── scorecard.json   # kpi_scorecard.py 的输出
```

`spec.json`：

```json
{
  "title": "2024 经营看板",
  "subtitle": "按月汇总，含线上/门店/分销三个渠道",
  "as_of": "2024-12-31",
  "source": "ERP 订单表导出（2025-01-02）",
  "kpis": "data/scorecard.json",
  "datasets": {
    "sales": "data/sales.csv",
    "stores": {"csv": "data/stores.csv"}
  },
  "filters": [
    {"column": "区域", "label": "区域"},
    "渠道"
  ],
  "charts": [
    {"id": "trend", "type": "line", "title": "月度营收趋势", "data": "sales",
     "x": "月份", "y": "营收", "series_col": "渠道", "agg": "sum",
     "format": "currency", "target": {"value": 600000, "label": "月目标"}, "width": "full"},
    {"type": "stacked_bar", "title": "各区域营收构成", "data": "sales",
     "x": "区域", "y": "营收", "series_col": "渠道", "sort": "desc", "format": "currency"},
    {"type": "donut", "title": "渠道占比", "data": "sales", "x": "渠道", "y": "营收", "format": "currency"},
    {"type": "hbar", "title": "区域平均退款率", "data": "sales", "x": "区域", "y": "退款率",
     "agg": "mean", "format": "percent"},
    {"type": "area", "title": "订单数（按月）", "data": "sales", "x": "月份", "y": "订单数", "format": "integer"},
    {"type": "bar", "title": "季度对比", "x": ["Q1", "Q2", "Q3", "Q4"],
     "series": [{"name": "2023", "values": [1200000, 1350000, 1500000, 1600000]},
                {"name": "2024", "values": [1300000, 1500000, 1480000, 1900000]}],
     "format": "currency"},
    {"type": "scatter", "title": "门店客单价 vs 复购率", "data": "stores",
     "x": "客单价", "y": "复购率", "series_col": "区域", "label_col": "门店",
     "x_label": "客单价（元）", "y_label": "复购率", "format": "percent"}
  ],
  "tables": [
    {"title": "门店明细", "data": "stores", "sort_by": "评分", "sort_desc": true,
     "columns": ["门店", "区域", {"key": "客单价", "format": "currency", "unit": "元"},
                 {"key": "复购率", "format": "percent"}, "评分"],
     "page_size": 20},
    {"title": "销售 Top 50", "data": "sales", "sort_by": "营收", "sort_desc": true, "limit": 50}
  ],
  "caveats": ["12 月数据截至 12-31 零点，不含跨年退款", "退款率为订单口径"]
}
```

生成：

```bash
python3 "$S" work/spec.json --validate
python3 "$S" work/spec.json --out deliverables/dashboard/index.html
```

## 字段说明

### 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 看板标题 |
| `subtitle` / `description` | 否 | 副标题 |
| `as_of` | 建议 | 数据截至时间；缺失时会警告，页面显示“未注明” |
| `source` / `sources` | 否 | 数据来源（字符串或字符串数组），显示在页脚 |
| `kpis` | 否 | KPI 数组，或 scorecard JSON 路径，或 `{"file": "...", "ids": [...]}` |
| `datasets` / `data` | 否 | 命名数据集，供图表、表格、筛选器共用（见下文） |
| `charts` | 否 | 图表数组 |
| `tables` | 否 | 表格数组 |
| `filters` | 否 | 筛选器数组 |
| `notes` / `caveats` | 否 | 口径说明，两种写法都接受（可同时写，会合并），显示在页脚 |
| `columns` | 否 | 图表网格列数，1–4，默认 2（窄屏始终单列） |
| `kpi_title` | 否 | KPI 区标题 |

未知的顶层字段会给出警告但不报错。

### 数据集 `datasets`

```json
"datasets": {
  "sales":  "data/sales.csv",
  "stores": {"csv": "data/stores.csv", "sep": ","},
  "mini":   [{"城市": "上海", "销量": 120}, {"城市": "北京", "销量": 98}],
  "grid":   {"columns": ["城市", "销量"], "rows": [["上海", 120], ["北京", 98]]}
}
```

- CSV 编码先按 `utf-8-sig` 读取，失败再回退 `gb18030`；`.tsv` / `.tab` 自动按制表符分隔。
- 数值列自动识别：允许千分位逗号；`""、na、n/a、nan、null、none、-、—、#n/a` 视为缺失值。
- 页面中只嵌入实际被图表、表格、筛选器用到的列，以控制文件体积。
- 图表/表格也可以不引用数据集，直接写 `"csv": "path.csv"` 或 `"rows": [...]`。

### KPI 卡片 `kpis`

| 字段 | 说明 |
|---|---|
| `label`（或 `name` / `title`） | 指标名 |
| `value` | 数值；也可只给 `formatted`（已格式化的字符串） |
| `format` | `number`（默认）/ `integer` / `currency` / `percent` |
| `decimals`、`unit`、`compact` | 小数位、单位、是否用“万/亿”缩写（大数默认缩写） |
| `delta` / `change_pct` / `change` | 变化值；`delta_type` 为 `relative`（相对，显示 %）或 `absolute`（绝对；百分比指标显示 pp） |
| `compare_label` / `delta_label` | 对比口径文字，如“较上期”；`delta_label` 为已格式化的变化文字时直接显示 |
| `good_direction` | `up` / `down` / `neutral`，决定**变化方向的颜色**：例如退款率、成本 `down` 为好，下降显示绿色、上升显示红色；`neutral` 显示灰色 |
| `status` | `正常` / `关注` / `风险`，也接受 `good` / `warn` / `bad`；决定卡片左边框和角标颜色 |
| `target`、`attainment` | 目标值和达成率（显示进度条） |
| `status_reasons`、`definition`、`notes` | 鼠标悬停提示与卡片备注 |
| `sparkline` / `trend` | 可选的数值数组，在卡片内绘制迷你趋势线 |

数值格式规则与 `kpi_scorecard.py` 保持一致（缺值显示 “—”）：percent ×100 保留 1 位加 `%`；currency 默认 ¥ 前缀、千分位（给了 `unit` 时改为后缀）；integer 千分位；其他 2 位小数。

### 图表 `charts`

通用字段：`type`、`title`、`subtitle`、`format`（数值格式，同 KPI）、`decimals`、`unit`、`colors`（数组或 `{系列名: 颜色}`）、`height`（120–1200 px）、`width: "full"`（占满一行）、`x_label` / `y_label`、`note`、`filterable`（默认 true）。

两种数据写法：

1. **内联**：`"x": [...]` 加 `"series": [{"name": ..., "values": [...]}]`；单系列可简写为 `"values": [...]`；散点图用 `"points": [{"x":..,"y":..,"label":..}]`。
2. **数据集/CSV**：`"data": "sales"`（或 `csv` / `rows`），配合
   - `x`：分类列；
   - `y`：数值列，可为数组（多系列）；`y_labels` 为各系列改名；
   - `series_col`：按某列拆分成多个系列（不能与多个 `y` 同时使用，饼图不支持）；
   - `agg`：`sum`（默认）/ `mean`（`avg`）/ `count` / `min` / `max` / `median`；
   - `sort`：`none` / `x` / `asc` / `desc`（折线、面积图默认按 x 排序，柱状图默认按值降序）；
   - `limit`（或 `top`）：只保留前 N 个分类，其余可用 `other: true` 合并为“其他”（`other_label` 改名）。
- `target`：数值或 `{"value": ..., "label": ...}`（也可用 `target_label` 单独写标签），在折线/柱状/条形图上画一条目标参考线。
- `y_zero`：纵轴是否从 0 开始（柱状图总是从 0 开始）。

### 表格 `tables`

| 字段 | 说明 |
|---|---|
| `data` / `csv` / `rows` | 数据来源 |
| `columns` | 列名数组，或 `{"key": 列名, "label": 显示名, "format": ..., "decimals": ..., "unit": ...}` |
| `sort_by`、`sort_desc` | 初始排序 |
| `limit` | 只保留前 N 行（Top N，应配合 `sort_by`，否则会警告） |
| `page_size` | 每页行数，默认 50，最小 5 |
| `search` | 是否显示搜索框，默认 true |
| `width` | `"half"` 为半宽，默认全宽 |

超过 200 行且未设 `limit` 时会分页显示并给出警告。页面中点击表头排序（再次点击切换升/降序），搜索框对所有列做包含匹配。

### 筛选器 `filters`

写法为列名字符串，或 `{"column": ..., "label": ..., "options": [...], "default": ..., "all_label": "全部"}`。列必须存在于某个被使用的数据集中。选项默认取数据中出现的全部取值（超过 300 个会警告）。

## 图表类型

| type | 说明 | 别名 |
|---|---|---|
| `line` | 折线图，适合时间趋势 | — |
| `area` | 面积图；多系列时堆叠显示 | `stacked_area` |
| `bar` | 纵向柱状图（多系列分组） | `column` |
| `stacked_bar` | 纵向堆叠柱状图 | `stacked` |
| `hbar` | 横向条形图，适合长类目名、排名 | `barh` |
| `stacked_hbar` | 横向堆叠条形图 | — |
| `pie` | 饼图 | — |
| `donut` | 环形图，中心显示合计 | `doughnut`、`ring` |
| `scatter` | 散点图，`series_col` 分组着色，`label_col` 用于悬停提示 | — |

配色采用对色觉障碍较友好的 Okabe-Ito 风格调色板；同一系列名在筛选前后保持同一颜色。

## 与 kpi_scorecard 的衔接

`kpi-scorecard` 技能的 `kpi_scorecard.py` 输出的 JSON 可以**直接**作为 KPI 来源：

```json
{ "kpis": "out/scorecard.json" }
```

或只挑选部分指标（按 `id`，同时决定显示顺序）：

```json
{ "kpis": {"file": "out/scorecard.json", "ids": ["gmv", "refund_rate"]} }
```

也可以把 scorecard 的 `kpis` 数组直接粘贴进 spec。scorecard 中的 `label`、`value`、`format`、`unit`、`decimals`、`change_pct` / `change_abs` / `delta` / `delta_type` / `delta_label`、`compare_label`、`good_direction`、`target`、`attainment`、`status`、`status_reasons`、`definition`、`notes` 会被识别；未使用的字段（如 `components`、`thresholds`、`projected`）会被忽略。KPI 区标题旁会按各卡片的 `status` 统计显示“正常 N · 关注 N · 风险 N”（与 scorecard 的 `summary` 口径一致）；若 spec 未写 `as_of` 而 scorecard 有 `period.end`，会用它作为数据截至时间并给出警告。

推荐流程：

```bash
python3 kpi-scorecard/scripts/kpi_scorecard.py ... > work/data/scorecard.json
python3 data-dashboard/scripts/build_dashboard.py work/spec.json --out deliverables/dashboard/index.html
```

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功（`--validate` 通过，或 HTML 已生成） |
| `2` | 规格错误：文件不存在、不是合法 JSON、缺少必填字段、未知图表类型、CSV 找不到、列不存在或非数值、筛选列不存在、生成结果含外部引用等。错误信息以 `[错误]` 开头、中文说明位置和原因，会一次列出所有可发现的问题 |
| `1` | 其他运行错误（如输出文件无法写入） |
| `130` | 被用户中断（Ctrl+C） |

警告（`[警告]`）不影响退出码，例如缺少 `as_of`、表格超过 200 行、未知字段等。

## 已知限制

- **筛选只在前端生效，且只作用于引用了数据集/CSV 的图表和表格**，这些模块右上角会显示“筛选：列名”标记；内联数据的图表显示“不受筛选影响”；**KPI 卡片是静态的，不随筛选变化**（KPI 应由 kpi_scorecard 按口径预先计算）。
- 筛选器的列不在某个数据集中时，该数据集的图表/表格不受这个筛选器影响。
- 聚合在浏览器中基于嵌入的明细行完成，数据行数很大时 HTML 会变大、渲染变慢；生成超过约 5 MB 时会警告，建议先在 Python 侧预聚合或只保留需要的列/行。
- 表格为客户端分页，不支持虚拟滚动；搜索为简单的“包含”匹配。
- 图表为轻量 SVG 实现：不支持双纵轴、对数轴、地图、缩放/拖拽等交互；类目过多时 x 轴标签会自动抽稀。
- 打印时（`@media print`）隐藏按钮、搜索框和分页，筛选栏以静态文字显示当前选择，表格显示全部行，图表按当前筛选状态打印。
- 页面需要浏览器启用 JavaScript 才能绘制图表和表格。

## MINIQ_DA_PURE 说明

设置 `MINIQ_DA_PURE=1` 时，数据分析插件的脚本会避免使用 pandas 等第三方库。`build_dashboard.py` **本身只使用标准库**，因此在该模式下行为和输出完全一致（仅页脚“生成时间”不同），无需额外处理：

```bash
MINIQ_DA_PURE=1 python3 "$S" spec.json --out deliverables/dashboard/index.html
```
