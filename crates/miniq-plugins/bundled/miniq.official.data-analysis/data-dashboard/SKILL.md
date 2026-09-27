---
name: data-dashboard
description: 当用户需要搭建数据看板或仪表盘时使用，包括单文件交互式 HTML 看板（KPI 卡片、图表、表格、筛选）、Streamlit 应用，或为 BI 平台输出可落地的看板设计规格，并完成数据校验与渲染检查
version: 1
---

# 数据看板

## 触发场景
- “做一个销售看板”“把这些指标做成仪表盘”“给团队一个能筛选的页面”
- 定期更新的监控页面；KPI 汇报的可视化版本
- 需要为 Tableau/Power BI/Superset/Metabase 等平台写看板需求规格

## 前置条件
- 指标与口径已明确（来自 `data-kpi-design`/`data-kpi-reporting`/用户）
- 数据文件或查询结果；数据需预先聚合到看板所需粒度
- 设计原则见 `references/dashboard-design.md`；交付形式对照见 `references/delivery-options.md`；脚本规格见 `references/scripts-usage.md`

## 分步流程
1. **简报**：确认 受众、要支持的决策/问题（3–5 个）、刷新频率、使用场景（大屏/桌面/手机）、交付形式。用 `ask_user` 补齐缺失的关键项。
2. **选交付形式**（`references/delivery-options.md`）：
   - 默认：单文件 HTML（离线可开、可发邮件、可静态托管）
   - 需要实时查询/Python 交互：Streamlit（需用户环境安装 `streamlit`）
   - 企业 BI：输出看板规格文档 + SQL/数据集，由用户在其平台搭建
3. **数据校验**：用 `data-quality-audit` 画像输入数据；核对看板数字与已知报表一致；确认截至日期。
4. **指标模型**：列出每个 KPI 的口径、对比基准、好的方向、目标；需要记分卡时直接用 `data-kpi-reporting/scripts/kpi_scorecard.py` 输出的 `kpis` 数组。
5. **布局**：按“总 → 分 → 细”：顶部 KPI 卡片（4–6 个）→ 主趋势图 → 维度拆分图 → 明细表；筛选器放顶部；每个区块标题写结论或问题。
6. **写规格并构建**（HTML 形式）：`file_write` 写 `deliverables/dashboard/spec.json`（格式见 `references/scripts-usage.md`：title、subtitle、as_of、kpis、charts、tables、filters、notes/caveats），然后 `shell_run`
   `python3 <技能目录>/scripts/build_dashboard.py deliverables/dashboard/spec.json --out deliverables/dashboard/index.html`
   先用 `--validate` 检查规格。Streamlit 形式则 `file_write` 写 `app.py`，并用 `shell_run` 执行 `python3 -m py_compile app.py` 检查语法；运行命令交给用户或在用户同意后后台运行。
7. **渲染验证**：`browser_automation` 打开 `file://<绝对路径>/index.html`，截图检查：布局、KPI 数值、图表是否渲染、中文、筛选交互（点击后截图对比）、窄屏表现（`resize` 到 390px 宽）。发现问题修改规格后重建。
8. **交付**：给出文件路径、截图结论、更新方式（修改数据后重跑哪条命令）；需要托管时交给 `data-publish-html`。

## 工具与参数要点

- `file_write`：写 `deliverables/dashboard/spec.json`，包含 title、subtitle、as_of、datasets、kpis、charts、tables、filters、notes。字段见 `references/scripts-usage.md`
- `shell_run` 校验：`python3 <本技能目录>/scripts/build_dashboard.py deliverables/dashboard/spec.json --validate`。只打印摘要，不写文件；规格错误时退出码为 2，会一次列出所有问题
- `shell_run` 生成：`python3 <本技能目录>/scripts/build_dashboard.py deliverables/dashboard/spec.json --out deliverables/dashboard/index.html`。输出为单文件 HTML，不含任何外部资源
- kpis 可以直接引用 `kpi_scorecard.py --json-out` 的输出。图表支持 CSV 聚合（x/y/agg/series），并按 filters 联动
- 只依赖标准库，`MINIQ_DA_PURE=1` 时结果相同。表格超过 200 行会自动分页并告警
- `browser_automation`：打开 `file://` 路径，截图检查布局，操作筛选器；再用 `view_image` 复核截图

## 质量检查
- 页面第一屏能回答最重要的问题
- 每个 KPI 有对比基准与方向色（好/坏按指标的“好的方向”判断，而不是一律涨绿跌红）
- 图表符合 `data-visualize` 质量检查；数字与源数据一致（抽查 3 个）
- 显示数据截至时间、口径说明与已知问题
- 单文件 HTML 不引用任何外部 URL（脚本 `--validate` 会检查）
- 表格行数合理（>200 行时分页或只展示 Top N）

## 失败回退
- 数据太大无法内嵌：预聚合；或拆成多个页面；仍过大时改用 Streamlit/BI
- 需要实时数据但只有静态文件：说明限制，提供“一键刷新脚本”（重跑聚合 + 构建）
- 浏览器自动化不可用：用 `file_read` 检查 HTML 结构并请用户打开确认
- 交互需求超出脚本能力：在生成的 HTML 基础上 `file_edit` 增加原生 JS 逻辑，保持无外部依赖

## 交付格式
- `deliverables/dashboard/index.html`（或 `app.py`、或 `dashboard-spec.md`）
- `deliverables/dashboard/spec.json` 与数据准备脚本
- 对话中：截图验证结论、KPI 概览、刷新方法、已知局限
