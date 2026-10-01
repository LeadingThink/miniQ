---
name: data-kpi-reporting
displayName: KPI 周期汇报
description: 当用户需要制作周期性 KPI 汇报（周报、月报、季报、经营分析会材料），计算环比同比、目标达成与进度，解释驱动因素与业务影响，并以记分卡、报告或看板形式交付时使用
version: 1
---

# KPI 周期汇报

## 触发场景
- “做一下本周/本月经营数据周报”“Q3 各指标完成得怎么样”“给老板一页纸 KPI 汇总”
- 固定模板的定期汇报，希望脚本化以便每期复用
- 首次汇报且指标尚未定义 → 先用 `data-kpi-design`

## 前置条件
- 指标清单与口径（`data-context/metrics.md`、`kpi-design.md` 或用户说明）
- 明细或按日汇总的数据（CSV/Excel/数据库），含日期列；可选目标值
- 汇报模板见 `references/report-templates.md`；脚本用法见 `references/scripts-usage.md`

## 分步流程
1. **明确用途**：受众（高管/业务/运营）、周期（周/月/季）、对比口径（环比/同比/目标）、交付形式（Markdown/HTML 报告/看板/幻灯片）。缺关键信息时 `ask_user` 一次。
2. **确定指标框架**：主指标、驱动指标、护栏指标；每个写清口径与“好的方向”。与上期报告保持一致，若口径变化须在报告中说明。
3. **锁定周期与数据截至点**：明确本期起止日期、时区；检查数据是否已完整到达（最近日期行数是否偏低）。不完整时标注或只报到完整日期。
4. **计算记分卡**：`shell_run`
   `python3 <技能目录>/scripts/kpi_scorecard.py analysis/kpi/kpis.json --period <本期> --compare prior|yoy [--pacing --as-of <日期>] --json-out analysis/kpi/scorecard.json --md-out analysis/kpi/scorecard.md`
   （配置格式先 `file_read references/scripts-usage.md`）。输出的 `kpis` 数组可直接放入 `data-dashboard` 规格或 `data-report` 的 KPI 卡片。
5. **放入上下文**：对每个指标给出 对比基准变化、目标达成率、按日历的进度（本期未结束时给出外推值与置信说明）、历史波动区间，判断变化是否“正常波动”。
6. **解释驱动因素**：对变化超出正常区间的指标，`python3 <插件目录>/data-metric-diagnostics/scripts/decompose_change.py ...` 按维度分解贡献；结合 `data-business-context` 的事件时间线解释。只写有证据的原因，其余标注“待验证”。
7. **业务影响与行动**：把变化翻译成业务语言（对收入/成本/用户的影响），列出需要关注的风险和建议动作及负责人。
8. **验证**：抽查 2–3 个数字与上期报告/源系统对账；核对环比方向、百分比与百分点用法；过 `data-validate-analysis` 快速清单。
9. **交付**：按 `references/report-templates.md` 生成 Markdown，再用 `data-report` 渲染 HTML（或 `data-dashboard` 生成看板、`data-report-office` 导出 PPT/Word、`data-report-pdf` 导出 PDF）。把本期使用的脚本与配置保存在 `analysis/kpi/`，下期只需改 `--period` 复跑。

## 工具与参数要点

- `file_write`：写 definitions JSON，包含 title、data、date_col、thresholds、kpis[]（id、name、类型、口径、target、good_direction）
- `shell_run`：`python3 <本技能目录>/scripts/kpi_scorecard.py <definitions.json> --period 2024-06 [--compare prior|yoy] [--pacing --as-of YYYY-MM-DD] [--title 标题] --json-out analysis/kpi/scorecard.json --md-out analysis/kpi/scorecard.md [--stdout md|json|none]`
- `--period` 必填，可以写月份，也可以写 `起:止` 日期区间。`--pacing` 按已过天数折算目标，适用于月中汇报
- `MINIQ_DA_PURE=1` 强制走纯标准库路径。scorecard.json 可以直接作为 `data-dashboard` 的 kpis 或 `data-report` 的 `{{kpis:id}}` 数据来源
- 出现异常波动时，转 `<插件目录>/data-metric-diagnostics/scripts/decompose_change.py` 拆解原因
- `file_read`：核对 scorecard.md 后再写解读。趋势图用 `data-visualize` 的 make_chart.py 生成，并用 `view_image` 检查

## 质量检查
- 覆盖所有约定指标；缺失的指标说明原因
- 每个指标都有：当前值、对比值、变化（绝对+相对）、目标达成、状态（绿/黄/红）
- 比率指标的变化用“百分点”，数值指标用“%”
- 状态判定规则统一且写明；不完整周期已处理
- 驱动因素的贡献之和与总变化一致（分解脚本内置校验）

## 失败回退
- 缺目标值：状态改用“相对历史区间”（高于/在/低于近 8 期区间）
- 缺同比数据：改用环比并说明
- 数据延迟未到齐：报到最后完整日期，标注“截至 X 日”
- 脚本无法适配复杂口径：在 `analysis/kpi/` 写自定义脚本，输出同样结构的 JSON

## 交付格式
- `analysis/kpi/scorecard.md/json`、`deliverables/kpi-<周期>.md`（及 HTML/PDF/PPT 等）
- 报告结构：一句话总结 → 记分卡表 → 重点变化与驱动 → 风险与行动 → 口径与数据说明
