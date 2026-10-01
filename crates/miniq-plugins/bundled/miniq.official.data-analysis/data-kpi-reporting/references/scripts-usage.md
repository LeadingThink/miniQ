# 脚本用法：kpi_scorecard.py（KPI 记分卡）

路径：`scripts/kpi_scorecard.py`。纯标准库，支持 Python 3.9 及以上，不需要安装任何依赖。设置 `MINIQ_DA_PURE=1` 时行为不变。

## 用途

根据 KPI 定义 JSON，对指定期间计算每个 KPI 的：实际值、对比值、变化、目标达成率、状态（正常/关注/风险），以及判定依据。
支持环比（prior）、同比（yoy）和自定义基期，也支持期内进度（pacing）外推。
输出 JSON 中的 `kpis` 数组可以直接交给仪表盘生成器使用。

## 命令行

```bash
python3 scripts/kpi_scorecard.py kpis.json --period 2024-02 --compare prior \
  --json-out scorecard.json --md-out scorecard.md

python3 scripts/kpi_scorecard.py kpis.json --period 2024-03 --compare yoy
python3 scripts/kpi_scorecard.py kpis.json --period 2024-03 --pacing --as-of 2024-03-20
python3 scripts/kpi_scorecard.py kpis.json --period 2024-02-01:2024-02-15 --compare 2024-01-01:2024-01-15
```

| 参数 | 说明 |
|---|---|
| `definitions` | KPI 定义 JSON 文件 |
| `--period` | 当期：`2024-03`、`2024-Q1`、`2024`、`2024-03-01:2024-03-31` |
| `--compare` | `prior`（上一期，默认）、`yoy`（去年同期），或自定义基期（写法同 `--period`） |
| `--pacing` | 启用期内进度：截至 as-of 的可加指标按天数线性外推到期末，再与目标比较 |
| `--as-of` | pacing 的截至日期。默认取该 KPI 数据在当期内的最大日期 |
| `--title` / `--json-out` / `--md-out` / `--stdout md\|json\|none` | 标题与输出设置 |

"上一期"的推算规则：月对应上月，季度对应上季度，年对应上年，自定义区间对应紧邻其前、长度相同的区间。

## 定义 JSON 示例

```json
{
  "title": "经营 KPI 记分卡",
  "data": "sales.csv",
  "date_col": "date",
  "thresholds": {"attainment": {"watch": 0.95, "risk": 0.85}, "change": {"watch": -0.05, "risk": -0.15}},
  "kpis": [
    {"id": "revenue", "name": "收入", "definition": "sum(revenue)", "agg": "sum", "column": "revenue",
     "format": "currency", "good_direction": "up", "target": 2000000},
    {"id": "orders_east", "name": "华东订单", "agg": "sum", "column": "orders", "filters": {"region": "华东"},
     "format": "integer", "good_direction": "up", "target": 5000},
    {"id": "cvr", "name": "转化率", "agg": "ratio", "numerator": "orders", "denominator": "visits",
     "format": "percent", "good_direction": "up", "target": 0.06,
     "thresholds": {"change_basis": "abs", "change": {"watch": -0.002, "risk": -0.01}}},
    {"id": "aov", "name": "客单价", "agg": "ratio",
     "numerator": {"agg": "sum", "column": "revenue"}, "denominator": {"agg": "sum", "column": "orders"},
     "format": "number", "decimals": 1, "unit": "元", "good_direction": "neutral", "target": 100},
    {"id": "users", "name": "下单用户", "agg": "distinct", "column": "user_id", "format": "integer"},
    {"id": "complaint", "name": "投诉率", "values": {"2024-02": 0.012, "2024-01": 0.009},
     "format": "percent", "good_direction": "down", "target": 0.01},
    {"id": "nps", "name": "NPS", "value": 42, "compare_value": 45, "good_direction": "up", "target": 40,
     "thresholds": {"min": 30}}
  ]
}
```

字段说明：

- **数据来源**：
  - 从文件读取：`data`（CSV，相对路径以定义文件所在目录为基准，可在顶层或单个 KPI 中设置）+ `date_col`。
  - 内联值：`value` / `compare_value`，或 `values: {期间键: 值}`。期间键可以是 `--period` 的原始写法、`YYYY-MM`、`YYYY`、`YYYY-Qn`、`A:B`；对比期也可以使用 `current` / `compare` 这两个键。内联值不参与 pacing。
- **agg**：`sum` / `mean` / `median` / `min` / `max` / `count`（不填 column 时统计行数，填了则统计非空值个数）/ `distinct` / `ratio`。
  - `ratio` 需要 `numerator` 和 `denominator`。两者可以写成列名（默认求和），也可以写成 `{agg, column, filters}`。
  - `scale` 为可选的结果乘数，例如填 1000 表示千分比。
- **filters**：`{列: 值}` 或 `{列: [值1, 值2]}`，按等值匹配。
- **good_direction**：`up`（越高越好，默认）、`down`（越低越好）、`neutral`（越接近目标越好，变化越小越好）。
- **target** 或 **targets**（`{期间键: 目标}`）。
- **format**：`number` / `integer` / `currency` / `percent`（值用小数表示，0.05 即 5%）。可另设 `decimals`、`unit`。
- **thresholds**：可在顶层和单个 KPI 中设置，KPI 级的设置会覆盖顶层（按键合并）：
  - `attainment.watch/risk`：达成率低于该值时判为关注/风险，默认 0.95 / 0.85。neutral 指标改为比较偏离目标的幅度。
  - `change.watch/risk`：朝有利方向的变化低于该值时判为关注/风险，默认 −5% / −15%（相对变化）。neutral 指标比较变化幅度的绝对值。
  - `change_basis`：`relative`（默认，按相对变化判定）或 `abs`（按绝对变化判定，percent 格式的单位为 pp；阈值同样用小数填写，0.01 表示 1pp）。
  - `min` / `max`：硬性边界，越界直接判为风险。

## 状态判定

对每条规则分别判定，最终状态取其中最差的一个，每条规则的结论都写入 `status_reasons`：

1. **目标达成率**：up 指标为 实际/目标；down 指标为 目标/实际；启用 pacing 时用期末预测值代替实际值。
2. **对比变化**：先按 good_direction 把变化换算为"有利方向的变化"，再与阈值比较。
3. **硬边界**：min/max。
4. **当期无数据**：判为关注。

## pacing（期内进度）

启用 pacing 且 as-of 早于期末时：

- 当期只统计到 as-of；对比期也只截取相同的前 N 天，保证口径可比。
- 可加聚合（sum/count）的期末预测 = 截至值 × 总天数 / 已过天数，同时给出 `expected_to_date = 目标 × 已过天数 / 总天数`。
- 非可加聚合（ratio/mean/distinct 等）不做外推，期末预测直接取当前值。

## 输出

- JSON 顶层：`title`、`period`、`compare`（mode/label/start/end）、`pacing`、`summary`（正常/关注/风险计数）、`kpis[]`。
- `kpis[]` 中供仪表盘使用的字段：`label`、`value`、`format`、`delta`、`delta_label`、`good_direction`、`target`、`definition`。
  - `delta`：percent 格式的指标为绝对变化（小数，`delta_type=absolute`，例如 −0.017 表示 −1.7pp）；其他格式为相对变化（`delta_type=relative`）。
  - `delta_label` 的写法如 `较上期 +2.1%`、`较去年同期 -1.7pp`。
- 其他字段：`id`、`unit`、`decimals`、`compare_value`、`change_abs`、`change_pct`、`attainment`、`projected`、`pacing`、`status`、`status_reasons`、`notes`、`components`（ratio 的分子/分母）、`thresholds`、`source`、`agg`。
- Markdown：汇总行，加上"KPI | 实际 | 对比 | 变化 | 目标 | 达成率 | 状态 | 判定依据"表格，以及指标口径列表。

## 局限

- 期间按自然日切分，不支持财务周、工作日或节假日调整。pacing 采用按日历天数的线性外推，不考虑周内或月内的季节性。
- filters 只支持等值匹配。更复杂的口径请先预处理数据，或改用内联值。
- 同比遇到 2 月 29 日时会取 2 月 28 日。
- 目标为 0 时无法计算达成率（down 指标的实际值为 0 时，达成率记为 9.99）。
- 状态判定的阈值只是经验默认值，应根据业务波动水平调整。
