---
name: data-index
description: 数据分析插件的总入口与路由。用户提出数据相关需求但不确定该用哪种分析方式，或一个请求同时涉及取数、分析、可视化、报告、仪表盘等多个环节时，先用本技能判定任务类型并串联其他 data- 技能
version: 1
---

# 数据分析总览与路由

本插件把一次数据工作拆成“理解问题 → 找数与建上下文 → 质量与可信度 → 分析 → 呈现 → 校验 → 交付”几个环节。本技能负责判断用户处在哪个环节、该调用哪些技能、以什么顺序串联，以及统一的交付与校验标准。

## 触发场景
- 用户说“帮我分析一下……”“做个数据看看”“出一份周报/看板/报告”，但没有指定方法
- 一个请求跨多个环节，例如“先检查数据质量，再做月度 KPI 报告并导出 PDF”
- 需要知道本插件能做什么、各技能之间怎么配合

## 前置条件
- 数据来源至少其一：工作区中的 CSV/TSV/Excel/JSON/Parquet/SQLite 文件，用户粘贴的表格，可通过 `shell_run` 访问的数据库命令行（sqlite3、psql、mysql、duckdb 等，需用户已配置凭据），或用户可提供的网页/文档
- `python3` 可用（所有脚本默认只依赖标准库；pandas/matplotlib/openpyxl/python-docx/python-pptx 为可选增强）

## 技能地图

| 用户意图 | 首选技能 | 常见后续 |
|---|---|---|
| 初看一份数据、摸清结构和规律 | `data-explore` | `data-quality-audit`、`data-visualize` |
| 数据能不能信：缺失、重复、异常、口径漂移 | `data-quality-audit` | `data-report` |
| 检查一份分析/报告/看板的结论是否站得住 | `data-validate-analysis` | 修正后再交付 |
| 为数据集/数据库建立字段字典、口径、语义层 | `data-context-layer` | 所有分析技能复用 |
| 查找业务背景、指标定义、既往结论、时间锚点 | `data-business-context` | 任意分析技能 |
| 设计/挑选 KPI、北极星指标、护栏指标、目标 | `data-kpi-design` | `data-kpi-reporting`、`data-dashboard` |
| 周报/月报/季报、目标达成、进度追踪 | `data-kpi-reporting` | `data-report`、`data-dashboard` |
| 指标为什么涨跌、异常定位、归因、对账差异 | `data-metric-diagnostics` | `data-report` |
| TAM/SAM/SOM、市场机会、收入池测算 | `data-market-sizing` | `data-report` |
| 产品/业务问题：漏斗、留存、分群、实验、定价、渠道 | `data-product-analysis` | `data-visualize`、`data-report` |
| 画一张或几张图 | `data-visualize` | 嵌入报告/看板 |
| 做可交互看板（HTML/Streamlit/BI 规格） | `data-dashboard` | `data-publish-html` |
| 写分析报告（高管版/技术版） | `data-report` | `data-report-pdf`、`data-report-office`、`data-publish-html` |
| 导出 PDF | `data-report-pdf` | — |
| 导出 Word/PPT（或降级为 HTML 幻灯片） | `data-report-office` | — |
| 生成可静态托管的网页并部署 | `data-publish-html` | — |
| 用 Notebook 承载可复现分析 | `data-jupyter-notebook` | 任意 |

## 分步流程
1. **识别意图**：从用户原话提取 问题 / 决策 / 受众 / 时间范围 / 交付物。若只缺一项且会实质改变做法（例如受众是高管还是工程师、交付是看板还是报告），用 `ask_user` 问一次，其余作为显式假设写入交付物。
2. **盘点数据**：用 `file_glob`（如 `**/*.{csv,xlsx,xls,tsv,json,parquet,db,sqlite}`）找候选文件；用 `doc_read` 预览；数据库用 `shell_run` 执行只读查询（`SELECT ... LIMIT`）。如果工作区里已有 `data-context/` 或 `DATA_CONTEXT.md`，先 `file_read` 复用其中的口径。
3. **决定链路**：按上表选主技能，并按下面的“默认链路”补足前后环节。多个独立子问题（例如 3 条产品线分别诊断）可以用 `agent_run` 并行分派，每个子代理拿到相同的口径文件与输出格式，产出写到不同文件，最后由主流程汇总。
4. **执行并留痕**：所有取数和计算写成脚本或 Notebook（默认放 `analysis/`），不要只在对话里心算；关键数字必须能从脚本输出追溯。
5. **校验**：面向他人交付前，至少过一遍 `data-validate-analysis` 的快速清单；新数据源或结果出乎意料时先做 `data-quality-audit`。
6. **交付**：按“交付标准”输出，并告诉用户文件路径和下一步可选动作（导出 PDF/Word/PPT、发布网页、做成定期更新的脚本）。

### 默认链路
- 一次性问题（“上月哪个渠道最好？”）：`data-explore`（或直接查询）→ 简短结论 + 一张图 + 口径说明，不强行出报告。
- 面向利益相关者的分析：业务背景 → 质量检查 → 分析技能 → `data-visualize` → `data-report` → `data-validate-analysis` → 导出。
- 周期性汇报：`data-kpi-design`（首次）→ `data-kpi-reporting` → `data-dashboard` 或 `data-report`。
- 异常/涨跌：`data-quality-audit`（排除数据问题）→ `data-metric-diagnostics` → `data-report`。

## 全局约定
- **目录**：分析脚本与中间结果 `analysis/`，图表 `analysis/figures/`，报告与看板 `deliverables/`。不修改原始数据文件。
- **口径先行**：每个指标写清 分子/分母/时间窗/时区/过滤条件/去重键；多来源冲突时说明采用哪一个及原因。
- **事实与推断分开**：观察到的数字、基于数字的解读、推测的原因、建议，四者在文字上可区分。相关≠因果。
- **比率优于计数**：跨组对比优先用率，并同时给出分母规模。
- **不虚构数据**：真实数据不可得时停下说明缺什么；只有用户明确要“示意/样例/mockup”时才可用合成数据，并在交付物醒目标注“合成数据”。
- **隐私**：只展示聚合结果；含个人信息的明细不写进报告；不把数据发往外部服务（包括 `web_fetch` 上传）除非用户明确同意。
- **依赖安装**：需要 pip 安装时先征得同意，命令统一为 `python3 -m pip install --user <包>`；拒绝安装则走脚本的纯标准库降级路径。

## 共享脚本一览（均在各技能的 scripts/ 下，先 `file_read` 看文件头部用法）
- `data-quality-audit/scripts/profile_data.py`：数据画像（类型推断、缺失、重复、异常值、时间覆盖）
- `data-quality-audit/scripts/run_checks.py`：按 JSON 规则执行校验（非空、唯一、范围、外键、行数/金额对账、新鲜度）
- `data-metric-diagnostics/scripts/decompose_change.py`：指标变动按维度贡献分解、结构/率效应分解、时间序列异常点
- `data-kpi-reporting/scripts/kpi_scorecard.py`：KPI 记分卡（环比/同比/目标达成/进度外推）
- `data-market-sizing/scripts/sizing_model.py`：市场规模模型（情景、敏感性、蒙特卡洛）
- `data-visualize/scripts/make_chart.py`：按 JSON 规格生成单图（12 种图型，支持 CSV 聚合；matplotlib 缺失或 `MINIQ_DA_PURE=1` 时降级为纯 SVG）
- `data-dashboard/scripts/build_dashboard.py`：JSON 规格 → 单文件 HTML 看板
- `data-report/scripts/build_report.py`：Markdown(+JSON) → 自包含 HTML 报告
- `data-report-pdf/scripts/html_to_pdf.py`：HTML/Markdown → PDF（无头浏览器，失败降级为打印就绪 HTML）
- `data-report-office/scripts/export_office.py`：Markdown → docx/pptx（缺库时纯标准库 docx、HTML 幻灯片）
- `data-publish-html/scripts/package_html.py`：内联资源、检查外链、打包为可静态托管目录
- `data-jupyter-notebook/scripts/nb_tool.py`：Notebook 脚手架/校验/执行/清理

脚本路径：技能目录由技能加载结果给出；在 `shell_run` 中用绝对路径调用，例如 `python3 <插件目录>/data-quality-audit/scripts/profile_data.py data.csv --out-md analysis/profile.md`。

## 工具与参数要点

- `file_glob`/`file_grep`：盘点工作区里的数据文件（`**/*.{csv,xlsx,json,parquet,db}`）和已有产出（`analysis/`、`deliverables/`、`data-context/`）
- `file_read`/`doc_read`：路由前读取用户给的文档、表格和上下文。每个子技能的 SKILL.md 先读再执行
- `shell_run`：探测环境，例如 `python3 -c "import pandas, matplotlib"`、`sqlite3 --version`、`which duckdb psql`。结果决定后续是否走纯标准库路径（`MINIQ_DA_PURE=1`）
- `ask_user`：目标、受众或数据源不明确时只问一次，并给出推荐选项。公开发布、安装依赖、改写原始数据前必须确认
- `agent_run`：多份数据或多个问题彼此独立时，可以分给后台子任务并行处理。每个子任务写到各自的 `analysis/<子目录>/`，由主流程汇总
- 脚本统一用 `python3 <插件目录>/data-xxx/scripts/<脚本>.py` 调用。各脚本参数见对应技能 references 目录下的 scripts-usage.md
- 退出码约定：0 成功；2 通常表示已降级或有警告（需逐条处理），其他非 0 值表示失败。不要忽略非 0 退出码

## 质量检查

- 路由正确：所选子技能与用户问题一致；多步任务按“数据质量 → 分析 → 校验 → 交付”的顺序执行，不跳过 `data-validate-analysis`
- 数据可信：分析前至少完成一次画像或质量检查，发现的 high 级问题在结论中写明
- 可复现：所有数字都来自 `analysis/` 下保存的脚本或查询，关键数字写明口径、时间窗和数据截至时间
- 交付完整：产物放在 `analysis/` 与 `deliverables/` 约定目录，图表逐张用 `view_image` 检查，HTML 用 `browser_automation` 截图检查
- 可信度评级明确：可直接分享 / 附带说明后分享 / 需要修订，并附上理由

## 交付格式（交付标准）
- 先给答案，再给证据：第一段直接回答用户的问题（含关键数字与时间范围）。
- 每个结论附：数字依据、口径、来源文件/查询、图表路径。
- 列出假设、局限和需要用户确认的问题。
- 生成的文件给出路径清单；HTML/图片交付前用 `browser_automation`（打开 `file://` 路径截图）或 `view_image` 实际看过。
- 结尾给出可信度评级：可直接分享 / 附带说明后分享 / 需要修订（标准见 `data-validate-analysis`）。

## 失败回退
- 找不到数据：列出已搜索的位置，用 `ask_user` 请用户提供路径或导出文件。
- 数据库无法连接：请用户提供导出的 CSV，或确认连接命令；不要猜测凭据。
- Python 包缺失：优先走脚本降级；需要完整功能时给出安装命令让用户确认。
- 需求过大：先交付最小可用版本（关键结论 + 1–3 张图），说明后续可扩展项。
