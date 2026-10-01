# 数据质量脚本使用说明

本目录 `scripts/` 下有两个命令行脚本，以及它们共用的读取模块：

| 文件 | 作用 |
|---|---|
| `profile_data.py` | 数据画像与质量体检：列类型、缺失、分布、异常值、重复、主键和时间覆盖，最后汇总成问题清单 |
| `run_checks.py` | 规则运行器：按 JSON 规则文件逐条校验，输出通过/失败、失败行数和样例 |
| `dq_common.py` | 共用模块，负责读取 csv/tsv/xlsx/json/jsonl、缺失值判定、数值和日期解析（不单独调用） |

运行环境为 Python ≥ 3.9，**只用标准库就能跑**。环境里装了 openpyxl 或 pandas 时会自动用它们提速，结果口径不变。

---

## 1. profile_data.py：数据画像

```bash
python3 scripts/profile_data.py <数据文件> [--sheet 名称或序号] [--encoding 编码] [--max-rows N]
        [--key 列[,列...]] [--date-col 日期列] [--today YYYY-MM-DD] [--top 5]
        [--out-json profile.json] [--out-md profile.md] [--pure]
```

| 参数 | 说明 |
|---|---|
| `path` | 数据文件，支持 `.csv/.tsv/.txt/.xlsx/.xlsm/.json/.jsonl/.ndjson`。旧版 `.xls` 需要先另存为 `.xlsx` 或 `.csv` |
| `--sheet` | xlsx 工作表：可写名称（大小写不敏感），也可写从 1 开始的序号。不指定时读第一个工作表 |
| `--encoding` | 文本编码。不指定时依次尝试 `utf-8-sig → gbk → gb18030`，都失败则按 `latin-1` 降级读取 |
| `--max-rows` | 最多读取的数据行数，适合大文件抽查。报告里会标注“已截断” |
| `--key` | 主键列。逗号分隔表示复合主键，例如 `--key 门店,日期`；参数可以重复传 |
| `--date-col` | 需要做时间覆盖分析的日期列，可以重复传 |
| `--today` | 判定“未来日期”的基准日，默认取今天 |
| `--top` | 每列列出的 Top 值个数 |
| `--out-json` / `--out-md` | 输出文件。两个都不指定时，Markdown 直接打印到标准输出 |
| `--pure` | 强制只用标准库，等同于设置 `MINIQ_DA_PURE=1` |

退出码：`0` 表示成功；`2` 表示文件读取失败或参数错误（例如列名、工作表不存在），此时错误信息会列出可选值。

**检查内容与严重度**

| 类别 | 判定方式 | 严重度 |
|---|---|---|
| 缺失值 | 空单元格、空串，以及占位符 `NA/N/A/#N/A/null/None/NaN/nil/-/--/—/?/空/缺失/无数据`、Excel 错误值等 | 缺失率 >50% 为高，≥5% 为中，其余为低 |
| 全空列 | 整列都没有有效值 | 中 |
| 混合类型 | 主类型占比不足 100%（不足 90% 时推断类型记为“混合”） | 少数类型 ≥5% 为中，否则为低 |
| 数字存成文本 | 带空格、千分位、货币符号、百分号或括号负数的数字；xlsx/json 中以字符串存储的数字 | 中 |
| 异常值(IQR) | 超出 `[Q1-1.5·IQR, Q3+1.5·IQR]`；有效数值少于 8 个或 IQR=0 时跳过 | 异常率 ≥5% 为中，否则为低 |
| 伪重复 | 只因首尾空格或大小写不同而成为不同取值（如 `paid/PAID/Paid`） | 中 |
| 首尾空格 | 值带有前后空白 | 低 |
| 完全重复行 | 所有列都相同 | 重复率 >5% 为高，否则为中 |
| 主键重复 / 主键缺失 | 按 `--key` 判定 | 高；去空格、忽略大小写后才重复的记为“主键伪重复”，严重度中 |
| 常量列 | 非空值只有一种 | 低 |
| 高基数 | 文本列唯一值占比 >95% 且非空值 ≥20 个（主键列除外） | 低 |
| 日期格式 | `--date-col` 中无法解析的值 | 占比 >20% 为高，否则为中 |
| 缺期 | 范围内整月没有记录；日粒度数据缺某些天（只缺周末时记为低） | 中/低 |
| 行数突变 | 月行数偏离“中间月份中位数”50% 以上（首末月可能不完整，不参与判定） | 中 |
| 未来日期 | 日期晚于 `--today` | 中 |
| 列数不齐 | csv/tsv 中某行字段数与表头不一致 | 中 |

说明：以 0 开头的数字串（如 `00123`）和超过 15 位的数字串（证件号、单号）按文本处理，不算“数值”。

**JSON 输出字段**

- `source`：`path`、`format`、`engine`（`pandas` / `stdlib-csv` / `openpyxl` / `stdlib-xlsx` / json）、`encoding`、`delimiter`、`sheet`、`sheets`、`header_row`、`truncated`、`ragged_rows`
- `rows`、`columns`、`generated_at`
- `issue_summary`：`{"高": n, "中": n, "低": n}`
- `issues[]`：`severity`（高/中/低）、`category`、`column`（整表问题为 null）、`message`、`evidence`（含样例行号）
- `duplicate_rows`：`count`、`rate`、`examples[{row, same_as_row}]`
- `key_check`：`columns`、`unique`、`duplicate_keys`、`duplicate_rows_involved`、`duplicate_extra_rows`、`missing_key_rows`、`normalized_extra_duplicates`、`examples`
- `date_checks[]`：`min/max`、`span_days`、`distinct_days`、`day_coverage`、`granularity`（日/月/不规则）、`by_month[{month, rows}]`、`missing_months`、`missing_days_count`、`missing_days`、`month_jumps`、`future_rows`、`unparseable`
- `column_profiles[]`：`name`、`inferred_type`（整数/小数/日期/布尔/文本/混合/空）、`missing{count, rate, null, blank, placeholders}`、`unique`、`unique_ratio`、`top_values`、`type_counts`、`constant`，另有按需出现的字段：`numeric{count, min, max, mean, median, p1, p99, std, sum}`、`outliers{q1, q3, iqr, lower_fence, upper_fence, count, rate, examples}`、`number_as_text`、`mixed_types`、`whitespace`、`pseudo_duplicates`、`date_range`

行号均为源文件行号，表头为第 1 行；xlsx 使用工作表的实际行号。

---

## 2. run_checks.py：规则运行器

```bash
python3 scripts/run_checks.py rules.json [--out-json result.json] [--out-md result.md]
        [--today YYYY-MM-DD] [--sample-limit 5] [--base-dir 目录] [--no-fail] [--pure]
```

- 数据集里的相对路径默认以规则文件所在目录为基准，可以用 `--base-dir` 或 `options.base_dir` 改掉。
- 基准日期的优先级：`--today` > `options.today` > 今天。
- 退出码：`0` 表示没有 high 级规则未通过；`1` 表示存在 **high 级失败或错误**；`2` 表示规则文件本身有问题（找不到、JSON 非法、缺少 `checks`）。加 `--no-fail` 时，前两种情况都返回 0。
- 单条规则配置出错（列不存在、表达式非法、数据集读取失败等）时，只把这一条标为 `error`，其余规则照常执行。

### 完整规则示例

```json
{
  "options": {"today": "2025-01-10", "sample_limit": 5},
  "datasets": {
    "orders":    "orders.csv",
    "orders_gb": {"path": "orders_gbk.csv", "encoding": "gbk"},
    "customers": {"path": "customers.xlsx", "sheet": "customers"},
    "summary":   {"path": "summary.csv", "max_rows": 1000}
  },
  "checks": [
    {"id": "pk_not_null", "type": "not_null", "dataset": "orders",
     "columns": ["order_id", "amount"], "severity": "high"},
    {"id": "pk_unique", "type": "unique", "dataset": "orders",
     "columns": ["order_id"], "severity": "high"},
    {"id": "combo_unique", "type": "unique", "dataset": "orders",
     "columns": ["order_id", "customer_id"], "normalize": true, "severity": "medium"},
    {"id": "amount_range", "type": "range", "dataset": "orders", "column": "amount",
     "min": 0, "max": 10000, "where": "status == 'paid'", "severity": "high"},
    {"id": "date_range", "type": "range", "dataset": "orders", "column": "order_date",
     "min": "2024-01-01", "max": "2024-12-31", "severity": "medium"},
    {"id": "status_enum", "type": "allowed_values", "dataset": "orders", "column": "status",
     "values": ["paid", "refund"], "case_sensitive": false, "severity": "medium"},
    {"id": "id_format", "type": "regex", "dataset": "orders", "column": "order_id",
     "pattern": "O\\d{4}", "severity": "low"},
    {"id": "rows_min", "type": "row_count", "dataset": "orders",
     "min": 100, "max": 1000000, "severity": "medium"},
    {"id": "rows_match", "type": "row_count", "dataset": "orders",
     "equals_dataset": "orders_gb", "tolerance": 0, "tolerance_pct": 0.01, "severity": "low"},
    {"id": "fk_customer", "type": "reference", "dataset": "orders", "column": "customer_id",
     "ref_dataset": "customers", "ref_column": "customer_id", "severity": "high"},
    {"id": "sum_match", "type": "sum_reconcile", "dataset": "orders", "column": "amount",
     "ref_dataset": "summary", "ref_column": "value",
     "tolerance_abs": 1, "tolerance_rel": 0.001, "severity": "high"},
    {"id": "fresh", "type": "freshness", "dataset": "orders", "column": "order_date",
     "max_age_days": 7, "severity": "medium"},
    {"id": "refund_cap", "type": "custom_expr", "dataset": "orders",
     "expr": "amount is None or amount < 5000 or status == 'refund'",
     "description": "非退款单金额不超过 5000", "severity": "medium"}
  ]
}
```

### 规则类型参数

每条规则都可以带以下通用字段：`id`、`type`、`dataset`、`severity`（`high/medium/low`，默认 medium）、`description`，以及可选的 `where`（行过滤表达式，语法同 custom_expr）。

| type | 参数 | 失败判定 |
|---|---|---|
| `not_null` | `column` 或 `columns`；`placeholders_as_null`（默认 true，把 NA/null/- 等占位符也视为空） | 任一指定列为空的行 |
| `unique` | `column` 或 `columns`（多列即组合键）；`normalize`（去空格、忽略大小写后比较）；`ignore_null`（默认 true） | 键重复的**全部**行 |
| `range` | `column`；`min`/`max`（至少给一个，数字按数值比较，日期字符串按日期比较）；`inclusive`（默认 true）；`allow_null`（默认 true） | 越界或无法解析的行 |
| `allowed_values` | `column`；`values`；`case_sensitive`（默认 true）；`strip`（默认 true）；`allow_null` | 取值不在列表中的行，`details.unexpected_values` 给出出现次数 |
| `regex` | `column`；`pattern`；`full_match`（默认 true，设为 false 时只需包含匹配）；`ignore_case`；`allow_null` | 不匹配的行 |
| `row_count` | `min`/`max`，或 `equals_dataset` 加 `tolerance`（行数）/ `tolerance_pct`（比例，两者取较大）；可选 `equals_where` | 行数不满足条件 |
| `reference` | `column(s)`；`ref_dataset`；`ref_column(s)`（默认与 `columns` 同名）；`normalize` | 外键在参照表中不存在的行（空值跳过） |
| `sum_reconcile` | `column`；`ref_dataset`；`ref_column`；`tolerance_abs`（默认 0.01）；`tolerance_rel`（相对较大合计的比例）；`ref_where` | \|差额\| > max(绝对容差, 相对容差×max(\|合计\|)) |
| `freshness` | `column`；`max_age_days`；`as_of`（默认取基准日期） | 最新日期距基准日超过 N 天，或没有可解析的日期 |
| `custom_expr` | `expr` | 表达式结果为假或求值出错的行 |

**custom_expr / where 表达式**

表达式由 `ast` 解析后逐节点解释执行，**不使用 eval/exec**。可以用的写法：

- 列名直接当变量写，列名含空格或中文符号时用 `row["列名"]`。
- 缺失值为 `None`；可解析为数字的值自动转成数字（千分位、货币符号、百分号也能识别）；日期列可以用 `date()` 转换。
- 运算符：`+ - * / // % **`（指数上限 100）、比较（支持链式比较）、`and/or/not`、`in/not in`、`is None`、`x if c else y`、列表或元组字面量。
- 函数：`abs round min max len str num int float lower upper strip isnull notnull coalesce startswith endswith contains regex date today days_between year month`。
- 属性访问、lambda、推导式、关键字参数以及白名单之外的函数，都会被拒绝，该规则记为 `error`。
- `None` 参与大小比较时结果为假，参与算术运算时结果为 `None`。

### JSON 输出字段

- `generated_at`、`as_of`、`sample_limit`
- `summary`：`total`、`passed`、`failed`、`errors`、`failed_by_severity`（按严重度统计的未通过数，含 error）、`high_failed`、`duplicate_ids`
- `datasets`：每个数据集的 `path/rows/columns/engine/encoding/sheet`，读取失败时为 `error`
- `results[]`：
  - `id`、`type`、`dataset`、`severity`、`description`
  - `status`：`pass` / `fail` / `error`
  - `total_rows`：参与检查的行数（已应用 where）
  - `failed_rows`、`failed_rate`：row_count、sum_reconcile、freshness 这类表级规则中为 null
  - `samples[]`：最多 `sample_limit` 条，每条含 `row`（源文件行号）、`values`（相关列的值）、`reason`
  - `details`：各类型的补充信息，例如 unique 的 `duplicate_keys/extra_rows`、reference 的 `orphan_top`、sum_reconcile 的 `sum/ref_sum/diff/diff_rel/tolerance`、freshness 的 `latest/age_days`、row_count 的 `actual/expected/reasons`
  - `error`：仅在 status=error 时出现

Markdown 报告的排序规则是：错误在前，其次是失败，最后是通过；同一类里按严重度排列。失败规则会附带样例表。

---

## 3. 降级与兼容说明

| 场景 | 处理方式 |
|---|---|
| 没装 openpyxl，或设置了 `MINIQ_DA_NO_OPENPYXL=1` / `MINIQ_DA_PURE=1` / `--pure` | 用 `zipfile + xml.etree` 直接解析 xlsx：读取 `workbook.xml` 和 rels 定位工作表，解析 `sharedStrings`（忽略拼音注音 rPh）、内联字符串、布尔值、错误值和公式缓存值；根据 `styles.xml` 的内置或自定义日期格式把序列号转换成日期，支持 1904 日期系统。不计算公式，只读缓存值；合并单元格只有左上角有值 |
| 没装 pandas，或处于纯标准库模式 | csv 用标准库 `csv` 读取。pandas 读取失败时也会自动回退，`source.pandas_fallback` 记录原因。两种引擎都**以文本读取**，所以统计口径一致 |
| 编码 | 不指定时依次尝试 `utf-8-sig`（自动去 BOM）、`gbk`、`gb18030`，全部失败时以 `latin-1(降级)` 读取并在报告中标注，此时中文可能乱码，建议显式传 `--encoding` |
| 分隔符 | `.tsv` 固定用 Tab；其他文件从 `, \t ; \|` 中按首行出现次数猜测，次数相同时优先用逗号 |
| 表头 | 自动跳过开头的空行，第一条非空行作为表头；重复列名改为 `名称_2`，空列名改为 `列N` |
| json | 支持 JSON 数组（元素为对象）和 JSON Lines；嵌套对象或数组转成 JSON 字符串后作为文本列 |
| 旧版 `.xls` | 不支持，请另存为 `.xlsx` 或 `.csv` |

环境变量汇总：`MINIQ_DA_PURE=1`（全部走标准库）、`MINIQ_DA_NO_OPENPYXL=1`（只禁用 openpyxl）。
