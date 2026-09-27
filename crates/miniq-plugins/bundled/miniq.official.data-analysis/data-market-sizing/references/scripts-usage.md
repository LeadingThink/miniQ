# 脚本用法：sizing_model.py（市场规模测算）

路径：`scripts/sizing_model.py`。纯标准库，支持 Python 3.9 及以上，不需要安装任何依赖。设置 `MINIQ_DA_PURE=1` 时行为不变。

## 用途

把市场规模估算写成可复核的模型，包括：

- 变量：低/基准/高值、单位、来源，并标注是**事实**还是**假设**。
- 计算链：自上而下、自下而上，或任意命名的层级（TAM/SAM/SOM 等）。

脚本输出以下内容：

- 基准值，以及代入数值后的计算链展开。
- 低/高情景。
- 单变量敏感性龙卷风表。
- 可选的蒙特卡洛 P10/P50/P90。
- 自上而下与自下而上两种方法的交叉校验差距。

## 命令行

```bash
python3 scripts/sizing_model.py model.json --json-out sizing.json --md-out sizing.md
python3 scripts/sizing_model.py model.json --simulations 10000 --seed 42
```

| 参数 | 说明 |
|---|---|
| `model` | 模型 JSON |
| `--simulations N` | 蒙特卡洛次数，默认 0（不运行） |
| `--seed` | 随机种子，默认 42。种子相同则结果可复现 |
| `--json-out` / `--md-out` / `--stdout md\|json\|none` | 输出设置 |

## 模型 JSON 示例

```json
{
  "name": "企业协作 SaaS 中国市场规模",
  "method": "both",
  "unit": "元/年",
  "variables": {
    "companies": {"label": "中小企业数", "low": 4.8e7, "base": 5.2e7, "high": 5.2e7, "unit": "家",
                  "source": "统计年鉴 2023", "type": "fact"},
    "digital_share": {"low": 0.25, "base": 0.35, "high": 0.45, "source": "行业报告估计", "type": "assumption"},
    "spend_per_company": {"low": 1500, "base": 3000, "high": 5000, "unit": "元/家", "source": "访谈 12 家", "type": "assumption"},
    "segment_fit": {"low": 0.3, "base": 0.4, "high": 0.5, "type": "assumption", "source": "产品定位"},
    "share_3y": {"low": 0.02, "base": 0.05, "high": 0.08, "type": "assumption", "source": "对标竞品"},
    "reps": {"low": 40, "base": 50, "high": 60, "type": "assumption", "source": "招聘计划"},
    "deals_per_rep": {"low": 120, "base": 200, "high": 260, "type": "fact", "source": "历史销售数据"},
    "acv": {"low": 6000, "base": 9000, "high": 12000, "type": "fact", "source": "定价表"}
  },
  "top_down": [
    {"name": "TAM", "label": "总可触达市场", "formula": "companies * digital_share * spend_per_company"},
    {"name": "SAM", "label": "可服务市场", "formula": "TAM * segment_fit"},
    {"name": "SOM", "label": "可获得市场", "formula": "SAM * share_3y"}
  ],
  "bottom_up": [
    {"name": "SOM", "label": "可获得市场", "formula": "reps * deals_per_rep * acv"}
  ],
  "cross_check": {"layer": "SOM", "tolerance": 0.2}
}
```

- **variables**：可以写成字典（键为变量名），也可以写成列表（每项带 `name`）。变量名必须是合法标识符。
  - `type` 为 `fact` 或 `assumption`，也可以写中文"事实"。
  - 只填 `base` 时，低值和高值都等于基准值，即该变量不参与敏感性分析。
  - 如果不满足 low ≤ base ≤ high，脚本会自动排序并给出警告。
  - 事实变量有区间时（low ≠ high）也会给出警告，提醒确认来源精度。上面示例中的 companies 就会触发这条警告。
  - 假设变量没有填写 source 时会给出警告。
- **计算链**：可以写 `top_down` / `bottom_up`，也可以用 `chains: {任意链名: [层级...]}`，或只写一个 `layers`。
  - 每个层级都有 `name`、`formula`，可选 `label`、`unit`、`note`。
  - 公式只能引用变量和**本链中更早的层级**。
  - `method` 为 `top_down` 或 `bottom_up` 时只计算对应的那条链（`chains` 中的自定义链仍会计算），`both` 或不填时计算全部链。
- **公式白名单**：
  - 数字、变量名、`+ - * / ** % //`、一元正负号。
  - 函数：`min max abs round sqrt log exp ceil floor`。
  - 其他写法一律拒绝，包括属性访问、下标、字符串、其他函数调用、lambda 等。指数的绝对值不能超过 100。
- **cross_check**：
  - 同时存在 `top_down` 和 `bottom_up` 时，默认比较两条链中同名的层级，也可以用 `layer` 指定层级。两条链没有同名层级时，比较各自的最后一层。
  - 也可以用 `pairs: [["top_down.SOM", "bottom_up.SOM"]]` 显式指定。
  - `tolerance` 默认 0.2。

## 方法

- **基准**：所有变量取 base，按层级顺序求值。计算链展开会写出每一层的公式、代入数值后的算式和结果，同时列出这一层直接引用了哪些事实/假设变量，以及它依赖的全部假设（沿层级向上追溯）。
- **龙卷风（单变量敏感性）**：其他变量固定在 base，只把一个变量分别设为 low 和 high，记录链的最终层结果；波动幅度 = |结果差|，按幅度从大到小排序。
- **低/高情景**：每个变量取"使最终层更低/更高"的那一端，方向由龙卷风分析确定（所以分母类变量会自动反向）。对单调模型来说，这就是真正的区间下界和上界；每个变量取了哪一端写在 `scenario_inputs` 中。
- **蒙特卡洛**：每个变量独立服从三角分布 Triangular(low, mode=base, high)，用标准库 `random.Random(seed).triangular` 抽样；输出每一层的 P10/P50/P90/mean/std/min/max，分位数用线性插值计算。
- **交叉校验**：gap = 左 − 右，gap_pct = gap / |右|。
  - |gap_pct| ≤ tolerance：一致。
  - |gap_pct| ≤ 2.5×tolerance：存在明显差距，需复核关键假设。
  - 更大时：两种方法的口径或假设可能不一致。
  - 另外给出两者的低~高情景区间是否重叠。
- **关键假设**：每条链龙卷风表前 3 名中属于假设的变量。

## 输出

- JSON：
  - `variables`、`facts`、`assumptions`、`key_assumptions`
  - `chains.{链名}`：`final_layer`、`base`、`expansion[]`、`scenarios.low/base/high`、`scenario_inputs`、`tornado[]`，以及可选的 `monte_carlo`
  - `cross_check[]`、`warnings`
- Markdown：变量表（事实/假设加粗标注，含来源）→ 每条链的计算链展开、情景表（含 P10/P50/P90）、龙卷风表 → 交叉校验表 → 提示。

## 局限

- 蒙特卡洛假设各变量相互独立，没有建模相关性（例如渗透率和客单价往往负相关），所以尾部区间可能偏宽或偏窄。
- 三角分布只是对主观区间的粗略刻画；low/high 应理解为合理的极端值，而不是严格的 P10/P90。
- 低/高情景基于单变量方向判断，对非单调公式（如含 min/max 或先升后降的关系）不一定是真正的极值。
- 龙卷风只衡量单变量的影响，看不到交互效应。
- 模型只保证算术正确，不能证明假设合理；结论的可信度取决于变量来源，请重点复核 `key_assumptions`。
