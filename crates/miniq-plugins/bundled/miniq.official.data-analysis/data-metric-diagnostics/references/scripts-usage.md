# 脚本用法：decompose_change.py（指标变化归因）

路径：`scripts/decompose_change.py`。纯标准库，支持 Python 3.9 及以上，不需要安装任何依赖。设置 `MINIQ_DA_PURE=1` 时行为不变。

## 用途

对比两个期间（基期和关注期），回答"指标为什么变了"：

- **可加指标**（收入、订单数、用户数合计等）：按维度拆出每个成员的贡献，所有贡献之和恰好等于总变化。
- **比率指标**（转化率、客单价、毛利率等，由分子/分母定义）：拆成**结构效应**（mix，分母占比变化）和**率效应**（rate，成员自身比率变化），两者之和恰好等于 R₁ − R₀。
- 可选：输出时间序列并标记异常点。

## 命令行

```bash
# 可加指标
python3 scripts/decompose_change.py sales.csv --date-col date \
  --base 2024-01 --focus 2024-02 --metric revenue \
  --dims region channel --top 10 --timeseries week \
  --json-out out.json --md-out out.md

# 比率指标（分子/分母）
python3 scripts/decompose_change.py sales.csv --date-col date \
  --base 2024-01-01:2024-01-31 --focus 2024-02-01:2024-02-29 \
  --numerator orders --denominator visits --label 转化率 \
  --dims channel region --timeseries day --anomaly-method mad --k 3
```

| 参数 | 说明 |
|---|---|
| `data` | CSV 文件。编码依次尝试 utf-8-sig、gbk、utf-8、latin-1；分隔符自动识别（`, ; \t \|`） |
| `--date-col` | 日期列（必填）。支持 `2024-01-05`、`2024/01/05`、`20240105`，也支持带时间的写法 |
| `--base` / `--focus` | 基期 / 关注期（必填）：`A:B`（包含首尾两天）、`YYYY-MM`、`YYYY`、`YYYY-MM-DD` |
| `--metric` | 可加指标列（求和）。与 `--numerator`/`--denominator` 二选一 |
| `--numerator` `--denominator` | 比率指标的分子列和分母列（各自求和后再相除） |
| `--dims` | 分解维度，可写多个，每个维度单独分解 |
| `--top` | Markdown 中每个维度展示前几名，默认 10。JSON 中始终保留全部成员 |
| `--label` | 指标显示名 |
| `--timeseries day\|week\|month` | 输出时间序列。周以周一为起点 |
| `--anomaly-method std\|mad` | 异常判定方法，默认 mad；`--k` 为阈值倍数，默认 3 |
| `--json-out` / `--md-out` | 输出文件 |
| `--stdout md\|json\|none` | 标准输出的内容，默认 md |

数值解析规则：自动去掉千分位逗号、`¥`、`$`；以 `%` 结尾的值会除以 100；`na/null/none/-`/空值视为缺失。日期无法解析的行会被忽略。

## 方法公式

**可加分解**：成员 i 的贡献 cᵢ = Vᵢ(关注期) − Vᵢ(基期)；Σcᵢ = 总变化；占总变化% = cᵢ / 总变化。
成员状态分为：持续、新增（基期没有）、消失（关注期没有）。
集中度：给出 top1/top3/top5 的贡献占比、同向贡献累计达到 80% 所需的成员数，以及反向抵消的总额。

**比率分解（对称中点法）**：R = Σ wᵢ·rᵢ，其中 wᵢ = 成员分母 / 总分母，rᵢ = 成员分子 / 成员分母。

- 结构效应 mixᵢ = (w₁ᵢ − w₀ᵢ)·(r₀ᵢ + r₁ᵢ)/2
- 率效应 rateᵢ = (r₁ᵢ − r₀ᵢ)·(w₀ᵢ + w₁ᵢ)/2
- mixᵢ + rateᵢ = w₁ᵢr₁ᵢ − w₀ᵢr₀ᵢ，对所有成员求和恰好等于 R₁ − R₀，理论上没有残差。
- 新增成员的 r₀ 取 r₁，消失成员的 r₁ 取 r₀，因此它们的影响全部计入结构效应。
- `driver` 字段说明结构效应和率效应哪个占主导。

**辛普森提示**：
- 可加指标：持续成员中过半的变化方向与总体相反时触发。
- 比率指标：持续成员自身比率多数与整体比率变化方向相反时触发。这通常意味着整体变化来自结构迁移。

**时间序列异常**：
- `std`：均值 ± k·样本标准差。
- `mad`：中位数 ± k·1.4826·MAD。
- 首尾不完整的周期（数据没有覆盖整周/整月）标记为 `partial`，不参与基线估计和异常判定。
- 有效点少于 3 个时不做判定。

## 输出（JSON 主要字段）

- `overall`：base、focus、abs_change、rel_change。比率指标另有 base_num、base_den、focus_num、focus_den。
- `dimensions[]`：
  - 可加指标：`sum_of_contributions`、`residual`、`members[]`（member/base/focus/contribution/change_pct/share_of_change/status/rank）、`omitted_members`、`new_members`、`vanished_members`、`concentration`、`simpson`。
  - 比率指标：另有 `mix_effect`、`rate_effect`、`mix_share`、`rate_share`、`sum_of_effects`、`residual_note`、`driver`，成员含 weight/rate/mix_effect/rate_effect/total_effect。
- `timeseries`：grain、method、k、center、spread、lower、upper、series[]（period/value/partial/anomaly）、anomalies。
- `warnings`：期间重叠、两期天数不同（可加指标）、某期无数据、残差非 0、辛普森提示。

列名不存在时脚本报错退出，并列出所有可用列。

## 局限

- 只做单维度分解，不做多维交叉的层级下钻。需要时可以先过滤出子集再运行，或把两个维度拼接成一列。
- 可加指标的两期天数不同时，结果不会自动折算成日均。需要日均时，请选择等长期间或预先处理数据。
- 比率分解要求分子、分母都可以按成员求和。均值类指标（如平均时长）要写成"总时长 / 次数"的形式。
- 异常检测使用全序列的静态基线：如果指标出现**水平跃迁**（例如流量整体翻倍），跃迁后的所有点都会被标为异常。这时应把 `--base`/`--focus` 的分解结果作为主要结论，或者只对跃迁后的数据单独运行。没有考虑季节性。
- 分母为 0 但分子不为 0 的成员无法计算比率，会记入 `residual_note`，请人工核查。
- 贡献只是会计意义上的拆分，不代表因果关系。
