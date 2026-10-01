---
name: data-quality-audit
displayName: 数据质量审计
description: 当用户怀疑数据不可信，或在使用新数据源、指标突变、对账不平、上线新管道前，需要系统检查缺失、重复、异常值、口径漂移、时效性和表间一致性并给出分级问题清单与修复建议时使用
version: 1
---

# 数据质量审计

## 触发场景
- “这份数据靠谱吗”“为什么两个报表对不上”“指标突然掉了一半，是不是数据出问题了”
- 首次接入新数据源、迁移/回填之后、搭建看板或定期报告之前
- 需要为数据管道沉淀可重复运行的校验规则

不适用：检查一份已完成分析的推理与结论 → 用 `data-validate-analysis`。

## 前置条件
- 数据文件（csv/tsv/xlsx/jsonl）或数据库只读访问
- 最好知道：数据粒度、主键、时间列、下游用途（影响严重度判断）。不知道时先推断，并列为假设
- 深度清单见 `references/checklist.md`；严重度与报告模板见 `references/severity-and-report.md`；脚本用法见 `references/scripts-usage.md`

## 分步流程
1. **界定范围**：确认要审的表/文件、时间窗、下游用途（报表、模型、计费……）。用途决定严重度。
2. **理解粒度与键**：`doc_read` 预览；写出“一行代表什么”，列出候选主键、外键、时间列、金额/数量列。
3. **自动画像**：`shell_run` 运行
   `python3 <技能目录>/scripts/profile_data.py <文件> --key <主键> --date-col <时间列> --out-json analysis/dq/profile.json --out-md analysis/dq/profile.md`
   `file_read` 阅读画像，拿到基础问题清单（缺失、重复、类型、异常值、日期缺口、常量列、伪重复）。
4. **补充业务规则**：根据画像与业务理解，写 `analysis/dq/rules.json`（格式见 `references/scripts-usage.md`），至少覆盖：主键唯一、关键字段非空、取值范围/枚举、外键参照完整性、行数或金额与上游/财务对账、数据新鲜度。然后执行
   `python3 <技能目录>/scripts/run_checks.py analysis/dq/rules.json --out-json analysis/dq/checks.json --out-md analysis/dq/checks.md`
   （有 high 级失败时退出码为 1，属正常结果，不是脚本错误）
5. **时间与分群切片**：对关键指标按 天/周 与 主要维度（渠道、地区、平台、版本）拆分行数、缺失率、均值，找突变点；比较“率”而不仅是“数”。需要时用 `data-metric-diagnostics/scripts/decompose_change.py --timeseries` 标异常点。
6. **追因**：对每个异常，区分 真实业务变化（上线、活动、节假日、定价调整）/ 采集或埋点问题 / 管道问题（延迟、重复加载、回填、时区）/ 口径变化。用 `file_grep` 搜代码与文档、用 `data-business-context` 查变更记录。无法确认时写“可能原因”并给出验证方法。
7. **分级与建议**：按 `references/severity-and-report.md` 给每个问题定严重度与置信度，写修复建议与可自动化的检测规则（直接复用 rules.json）。
8. **交付**：写 `analysis/dq/report.md`；面向他人时用 `data-report` 生成 HTML 报告。保留脚本与规则文件以便复跑。

## 核心检查维度（详见 references/checklist.md）
完整性、唯一性、有效性（类型/范围/枚举/格式）、一致性（跨字段、跨表、跨系统）、准确性（与可信来源对账）、时效性（新鲜度、延迟到达）、稳定性（分布与基数漂移）、可追溯性（来源、口径、变更）。

## 工具与参数要点

- `file_glob`/`doc_read`：确认文件、工作表和表头。`file_write`：写规则文件 `analysis/dq/rules.json`
- `shell_run` 执行画像：`python3 <本技能目录>/scripts/profile_data.py <文件> [--sheet 表] [--encoding gbk] [--key 主键] [--date-col 日期列] [--today YYYY-MM-DD] [--top 10] [--max-rows N] --out-json analysis/dq/profile.json --out-md analysis/dq/profile.md`
- `shell_run` 执行规则校验：`python3 <本技能目录>/scripts/run_checks.py analysis/dq/rules.json [--base-dir 数据目录] [--today YYYY-MM-DD] [--sample-limit 5] --out-json analysis/dq/checks.json --out-md analysis/dq/checks.md`
- run_checks 的退出码：0 表示没有 high 级失败；1 表示存在 high 级失败或错误；2 表示规则文件本身有问题。`--no-fail` 会把前两种都改为 0，只建议在汇总阶段使用
- `--pure` 或 `MINIQ_DA_PURE=1`：两个脚本都强制走纯标准库路径，结果应与 pandas 路径一致。缺 pandas 时会自动降级
- `file_read`：读取 `analysis/dq/*.md`，整理问题清单。需要确认业务规则（例如允许的状态值）时用 `ask_user`

## 质量检查
- 每个问题都有 证据（计数、比例、时间、样例行 ID），不只写“存在缺失”
- 同时给出 绝对数 与 比例，并说明影响的下游指标
- 字符串先标准化（去空格、统一大小写/全半角）再判断重复与基数
- 最近几天分区可能是延迟到达，不要直接判定为缺失
- 区分“数据错了”和“业务真的变了”

## 失败回退
- 文件太大：画像加 `--max-rows` 抽样并说明；或导入 `sqlite3`/`duckdb` 用 SQL 做全量计数
- 缺少 openpyxl：脚本自带纯标准库 xlsx 解析；若解析失败请用户另存为 CSV
- 没有可对账的可信来源：标注“准确性未验证”，并建议对账对象
- 规则运行器报 JSON 格式错误：按报错行修正 rules.json 后重跑

## 交付格式
`analysis/dq/report.md`：
1. 结论摘要（能否用于预期用途：可用 / 有条件可用 / 不可用）
2. 数据集与粒度说明
3. 已执行的检查（列表 + 通过/失败）
4. 问题清单（按严重度排序：问题、证据、影响、置信度、可能原因、建议）
5. 时间/分群异常
6. 建议的自动化规则（附 rules.json 路径）
7. 假设与待确认问题
附件：`profile.md/json`、`checks.md/json`、`rules.json`、分析脚本路径
