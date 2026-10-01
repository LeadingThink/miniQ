# make_chart.py 使用说明

根据一份 JSON 图表规格生成单张静态图。可用 matplotlib 时默认输出 PNG；没有 matplotlib 或设置 `MINIQ_DA_PURE=1` 时，用纯标准库输出 SVG。

## 命令行

```
python3 <技能目录>/scripts/make_chart.py <spec.json | -> [-o 输出] [--format png|svg|pdf]
        [--backend auto|matplotlib|svg] [--dpi 150] [--width 900] [--height 520] [--validate]
```

| 参数 | 说明 |
|---|---|
| `spec` | 图表规格 JSON 文件；传 `-` 时从标准输入读取 |
| `-o/--out` | 输出路径。不指定时与规格文件同名，扩展名按格式决定 |
| `--format` | 输出格式。不指定时按 `--out` 的扩展名推断，推断不出则用 png |
| `--backend` | `auto`：有 matplotlib 就用，否则用 SVG；`matplotlib`：必须用 matplotlib，缺失时退出码 3；`svg`：只用纯标准库 |
| `--dpi` | PNG 分辨率，默认 150 |
| `--width/--height` | 画布像素尺寸，会覆盖规格中的同名字段 |
| `--validate` | 只校验规格，打印类型、数据点数和警告数，不出图 |

**退出码**：0 表示成功；2 表示规格无法读取、无效或渲染失败（stderr 会给出中文原因）；3 表示指定了 `--backend matplotlib` 但没有安装 matplotlib。

**降级**：用纯 SVG 后端时，如果要求输出 png/pdf，会自动改成同名 `.svg` 并在 stderr 给出警告。需要 PNG 时，先征得用户同意，再执行 `python3 -m pip install --user matplotlib`。

## 图表类型

`line`、`bar`、`hbar`、`stacked_bar`、`area`、`scatter`、`histogram`、`pie`、`heatmap`、`waterfall`、`funnel`、`boxplot`。

可用别名：`column`→bar，`barh`/`horizontal_bar`→hbar，`stacked`→stacked_bar，`stacked_area`→面积堆叠，`donut`→环形饼图，`scatterplot`→scatter，等等。

## 通用字段

| 字段 | 说明 |
|---|---|
| `type` | 图表类型，默认 bar |
| `title` / `subtitle` | 标题写结论句；副标题写口径和时间范围 |
| `x_label` / `y_label` / `unit` | 坐标轴标题和单位 |
| `source` / `note` | 写在图底部的来源和注释 |
| `number_format` | `int`、`0.00`、`pct`、`pct2`、`pp`、`cny`、`usd`、`wan`、`yi`、`compact`、`en`，也可以写成对象 `{"decimals":1,"prefix":"¥","suffix":"","compact":"wan"}` |
| `x_format` | 散点图 x 轴的数字格式 |
| `show_values` | 是否显示数据标签。pie、funnel、waterfall、heatmap 默认显示 |
| `colors` | 调色板数组；单个系列也可以用 `color` 指定颜色 |
| `highlight` | 需要强调的类别名数组，其余类别置灰 |
| `sort` | `asc` 或 `desc`。line、area、waterfall、funnel 不参与排序 |
| `target` / `targets` | 目标线，可以写数值，也可以写 `{"value":150,"label":"目标","color":"#444"}` |
| `annotations` | 标注数组，格式为 `{"x":"4月","series":"华东","text":"促销上线"}` |
| `legend` | 设为 false 时隐藏图例 |
| `y_zero` | 强制 y 轴从 0 开始。条形图和面积图本来就从 0 开始 |

## 数据写法一：内联

- **类别型图表**（line、bar、hbar、stacked_bar、area、pie、waterfall、funnel）：
  - 写法 A：`categories` 加 `series:[{"name","data":[...],"color"}]`
  - 写法 B：`values:[...]`
  - 写法 C：`values:{"类别":值}`
  - `null` 表示缺失值，折线图会在此断开。
- **stacked_bar**：可以加 `"percent": true` 画成 100% 堆叠。
- **area**：加 `"stacked": true` 画成堆叠面积。
- **pie**：可用字段有 `donut`、`center_label`，以及 `max_slices`（默认 8）。超出部分会合并为 `other_label`（默认"其他"）。
- **waterfall**：
  - `start:{"label","value"}` 是起点，`categories` 加 `values` 是各项增减。
  - `subtotals:["小计"]` 指定的类别显示当前累计值，对应的 values 填 0 即可。
  - `total_label` 是终点名称，`show_total:false` 可以不显示终点。
- **funnel**：各步骤的人数，图上会自动标出步骤间转化率和整体转化率。
- **scatter**：
  - 格式为 `series:[{"name","data":[[x,y,"标签",size], {"x":..,"y":..,"label":..}]}]`，也可以写 `points:[...]`。
  - 加 `"trendline": true` 显示趋势线。
- **histogram**：`values:[...]` 或 `series:[{"name","data":[...]}]`；`bins` 可以写整数或边界数组；`show_mean` 默认为 true。
- **heatmap**：
  - 需要 `x_categories`、`y_categories` 和 `matrix`，其中 matrix 的每一行对应一个 y 类别。
  - `null` 表示空格子。
- **boxplot**：`series:[{"name","data":[...]}]` 或 `categories` 加二维 `values`。

## 数据写法二：从 CSV 或行数据聚合

在规格顶层写 `csv`，也可以写成 `data:{"csv":...}` 或 `data:{"rows":[...],"columns":[...]}`。映射字段如下：

| 字段 | 说明 |
|---|---|
| `csv` | CSV 路径。相对路径会先按规格文件所在目录解析，找不到再按当前目录解析。支持 UTF-8 带 BOM 的文件，分隔符自动识别，也可以用 `delimiter` 指定 |
| `x` | 类别列；heatmap 中是横轴列，boxplot 中是分组列 |
| `y` | 数值列，可以写一个列名，也可以写列名数组（多个系列）。类别型图表省略 `y` 时表示计数；heatmap 中是纵轴维度列 |
| `value` | heatmap 的数值列。省略时表示计数 |
| `series` | 拆分系列用的列，例如"区域" |
| `agg` | `sum`、`mean`、`count`、`min`、`max`、`median`、`first`、`last`、`nunique` |
| `where` | 行过滤条件。格式为 `{"区域":["华东","华南"], "销售额":{"op":">=","value":100}}` |
| `sort_x` | 类别按自然顺序排序，例如 1月、2月…10月 |
| `names` | 列名显示别名，格式为 `{"sales":"销售额"}` |
| `label` / `size` | scatter 的点标签列和气泡大小列 |

示例：
```json
{"type":"bar","title":"3 月起华南、华北持续领先华东","csv":"monthly.csv",
 "x":"月份","y":"销售额","series":"区域","agg":"sum","sort_x":true,"number_format":"wan"}
```

## 典型用法

```
# 1. 先校验规格
python3 <技能目录>/scripts/make_chart.py analysis/figures/trend.json --validate
# 2. 出 PNG；没有 matplotlib 时自动改为 SVG
python3 <技能目录>/scripts/make_chart.py analysis/figures/trend.json -o analysis/figures/trend.png
# 3. 强制纯标准库输出，适合嵌入 HTML 报告
MINIQ_DA_PURE=1 python3 <技能目录>/scripts/make_chart.py spec.json -o analysis/figures/trend.svg
# 4. 从标准输入读规格
echo '{"type":"pie","values":{"A":5,"B":3}}' | python3 <技能目录>/scripts/make_chart.py - -o pie.svg
```

## 已知局限

- 中文字体：matplotlib 后端会依次尝试 PingFang、Hiragino、Noto Sans CJK、Microsoft YaHei、WenQuanYi 等字体；都没有时，中文可能显示成方块，这时改用 SVG 后端，由浏览器负责渲染字体。
- 不支持双 y 轴和交互功能。需要交互时用 `data-dashboard`，或自己写 HTML。
- `pdf` 格式只有 matplotlib 后端支持。
