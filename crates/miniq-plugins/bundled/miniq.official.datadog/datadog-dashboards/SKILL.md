---
name: datadog-dashboards
displayName: Datadog 仪表盘、笔记本与可视化
description: 当用户要把 Datadog 数据可视化时使用：查找或读取现有仪表盘与笔记本，按需求设计并校验组件，在确认后创建或更新仪表盘、笔记本或 Datadog 表格，并返回链接。
version: 1
---

# Datadog 仪表盘、笔记本与可视化

## 触发场景
- “做一个 checkout 服务概览仪表盘”“把这次排查过程整理成笔记本”“给现有仪表盘加一个错误率图”“找一下有没有关于 Redis 的仪表盘”。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- `core` 已包含 `search_datadog_dashboards`、`get_datadog_dashboard`、`upsert_datadog_dashboard` 以及笔记本工具。组件规范查询与校验需要 `dashboards`/`widgets` 工具集，表格需要 `sheets` 工具集。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`。
2. **先复用**：用 `search_datadog_dashboards`/`search_datadog_notebooks` 按关键词搜索，已有合适的就给出链接或在原有基础上修改，避免重复创建。
3. **设计**：与用户确认受众（值班、管理层、开发）、时间窗默认值和模板变量（`env`、`service`）；按 `references/dashboard-design.md` 的布局规划分组与组件。
4. **取数验证**：每个组件的查询先用 `get_datadog_metric`/`analyze_datadog_logs` 试查，确认有数据；开启 widgets 工具集时再用 `verify_widget_data` 检查。
5. **生成组件 JSON**：开启 dashboards 工具集时，先调用 `get_widget_reference` 获取组件 schema，再用 `validate_dashboard_widget` 逐个校验；拿不准时可以用 `ask_widget_expert`。
6. **确认后写入**：`ask_user` 展示标题、组件清单和是否覆盖已有仪表盘，得到同意后调用 `upsert_datadog_dashboard`（新建时不传 ID，更新时传 ID）。笔记本用 `create_datadog_notebook`/`edit_datadog_notebook`，单元格可以先用 `validate_notebook_cells` 校验。
7. **表格（可选）**：需要做成表格分享时，用 `upsert_datadog_spreadsheet`；已有表格数据用 `get_datadog_spreadsheet_tab_data` 读取。
8. **回读确认**：用 `get_datadog_dashboard`/`get_datadog_notebook` 回读，核对组件数量和标题，然后返回链接。
9. **本地可视化退路**：用户不想写入 Datadog 时，把查询结果保存为 CSV，交给数据分析插件的可视化技能（例如 `data-visualize`，若已安装）生成本地图表。

## 工具与参数要点
- 更新已有仪表盘时，upsert 可能整体替换组件列表。必须先 `get_datadog_dashboard` 取回完整定义，在此基础上修改，并在本地 `/tmp/miniq-dd/dashboard-<id>.bak.json` 保存备份。
- 删除仪表盘（`delete_datadog_dashboard`）属于高风险操作，必须单独 `ask_user`。
- 组件类型选择：趋势用 timeseries，当前值用 query_value，排行用 toplist，分布用 distribution/heatmap，明细用 table 或 list（日志流）。

## 质量检查
- 每个组件都有标题和单位，查询带 `env`/`service` 模板变量。
- 同一组内的时间窗和聚合方式保持一致；颜色阈值与监控阈值一致。
- 回读后组件数与设计一致，链接可以访问。

## 失败回退
- 没有组件 schema 工具：按参考文档中的最小 JSON 结构编写，并提示用户开启 dashboards 工具集以获得校验能力。
- 写权限不足（403）：输出完整 JSON，指导用户在 Datadog UI 的 Import dashboard JSON 中导入。

## 交付格式
- 仪表盘或笔记本链接、组件清单（名称 | 类型 | 查询）、模板变量、备份文件路径（更新时）、后续建议（例如配套监控）。
