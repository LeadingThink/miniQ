---
name: data-metric-diagnostics
displayName: 指标诊断与归因
description: 当某个指标出现意外涨跌、突增或跌落、与预期或其他报表对不上，需要定位原因、按维度拆解贡献、区分结构变化与率变化、识别集中度或数据问题，并给出有证据的结论时使用
version: 1
---

# 指标诊断与归因

## 触发场景
- “为什么上周转化率掉了 2 个点？”“GMV 突然涨了是真的吗？”
- 事故/回退：某天起指标断崖，需要判断影响范围与起止时间
- “哪些客户/商品贡献了大部分增长？”集中度与头部依赖
- 两个报表/系统的数字对不上，需要解释差异

## 前置条件
- 指标的明细或可按维度聚合的数据，含日期列
- 指标口径（分子/分母）；不清楚时先查 `data-context-layer` 或问用户
- 方法说明见 `references/diagnostic-playbook.md`；脚本用法见 `references/scripts-usage.md`

## 分步流程
1. **定义问题**：哪个指标、哪个时间段对比哪个基准、变化多少、用户认为“意外”的依据是什么。写成一句话：“X 指标在 A 期相对 B 期 从 p 变为 q（±r）”。
2. **核实口径与数据**：复算两期数值，确认与用户看到的一致；排除数据问题——延迟到达、重复加载、埋点变更、口径修改、时区。可调用 `data-quality-audit/scripts/profile_data.py` 与按日行数检查。数据问题成立时直接转为数据质量结论。
3. **确定形态**：画按日时间序列（`data-visualize` 的 `make_chart.py` 或 `decompose_change.py --timeseries`），判断是 阶跃 / 渐变 / 单日尖峰 / 周期性 / 趋势拐点，并定位起始日期。
4. **选择诊断方案**（详见 playbook）：
   - 指标变化解释：加法指标做维度贡献分解；比率指标做 结构效应（mix）与 率效应（rate）分解
   - 突增/跌落/事故：定位起止时间、受影响分群、与事件时间线对齐
   - 贡献与集中度：Top N 贡献、帕累托、头部依赖
   - 对账差异：两来源逐层对齐（范围 → 时间 → 过滤 → 去重 → 连接）
5. **执行分解**：`shell_run`
   `python3 <技能目录>/scripts/decompose_change.py <数据> --date-col <日期> --base <基期> --focus <当期> --metric <列> | --numerator <列> --denominator <列> --dims 渠道,地区,平台 --top 10 --json-out analysis/diag/decomp.json --md-out analysis/diag/decomp.md`
   阅读输出：每个维度的贡献排序、mix/rate 效应、辛普森悖论提示；脚本会校验分项之和等于总变化。
6. **下钻与验证**：对贡献最大的分群继续按第二维度下钻（最多 2–3 层）；用独立方法交叉验证（如换一个时间窗、排除该分群后重算）。结合 `data-business-context` 的事件（发版、活动、定价、渠道投放变化）。
7. **形成结论**：区分 已证实的驱动因素 / 可能的驱动因素 / 已排除的假设；给出影响量化和置信度；建议后续动作（修复、监控规则、实验验证）。
8. **交付**：`analysis/diag/diagnosis.md`，必要时用 `data-report` 渲染并附图（瀑布图展示贡献、时间序列标注事件）。

## 工具与参数要点

- `shell_run`：`python3 <本技能目录>/scripts/decompose_change.py <数据.csv> --date-col <日期列> --base <基期> --focus <当期> (--metric <列> | --numerator <列> --denominator <列>) --dims 渠道 地区 --top 10 --json-out analysis/diag/decomp.json --md-out analysis/diag/decomp.md`
- `--base`/`--focus` 可以写 `2024-01`，也可以写 `2024-01-01:2024-01-31`。`--dims` 用空格或逗号分隔均可。比率指标用 numerator/denominator，会自动拆分结构效应和率效应
- 时序异常：`--timeseries day|week|month --anomaly-method std|mad`（默认 mad）`--k 3`。基线是静态的，存在季节性时要在结论中注明
- 退出码非 0 时，先看 stderr 里的可用列名和日期解析问题。`MINIQ_DA_PURE=1` 可强制走纯标准库路径
- `file_glob`/`doc_read`：确认数据文件和口径。口径不清时用 `file_read` 读取 `data-context/metrics.md`，或用 `ask_user` 询问
- 图表用 `data-visualize` 的 make_chart.py 输出瀑布图或趋势图，再用 `view_image` 检查。结论写入 `file_write` → `analysis/diag/report.md`

## 质量检查
- 分解的分项之和 = 总变化（误差 < 0.1%）
- 比率指标必须同时看分子、分母和结构变化，警惕辛普森悖论
- 每个驱动因素都有数量化贡献与证据，不只是“可能因为”
- 已排除的假设也列出，说明排除依据
- 小分群的大幅百分比变化不应被当作主因（看绝对贡献）

## 失败回退
- 没有维度字段：只能做时间形态与事件对齐，结论标注置信度低，并建议补充维度
- 维度过多：先用各维度的“解释力”（最大单分群贡献占比）排序，只下钻前 2–3 个
- 两期口径不同：先统一口径再分解；无法统一时分别说明
- 无法确认原因：输出“候选原因 + 验证方法 + 需要的数据/人员”

## 交付格式
```markdown
# 指标诊断：<指标> <时间对比>
## 结论（3 行以内）
## 变化概述（数值、形态、起始时间）
## 数据可信度检查
## 驱动因素（按贡献排序：分群、贡献值、占比、证据、置信度）
## 结构 vs 率效应
## 已排除的假设
## 建议与后续监控
## 附：方法、口径、脚本与图表路径
```
