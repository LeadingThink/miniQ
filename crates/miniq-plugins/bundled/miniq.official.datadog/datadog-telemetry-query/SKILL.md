---
name: datadog-telemetry-query
displayName: Datadog 遥测即席查询
description: 当用户想用自然语言查询 Datadog 遥测数据时使用：日志量/错误数按服务统计、指标趋势与 Top N（如 CPU 最高的 10 个服务）、span/RUM 聚合、DDSQL 即席查询，并给出表格和结论。
version: 1
---

# Datadog 遥测即席查询

## 触发场景
- “过去 24 小时各服务的日志量是多少”“最近 6 小时 CPU 最高的 10 个服务”“按国家统计用户数”“prod 环境 5xx 最多的接口”。
- 用户只要数字、趋势或排行，并不是在排查某个具体故障（排障请用 `datadog-investigate`）。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 数据量大的结果可以落盘到 `/tmp/miniq-dd/`，再用 `<本技能目录>/scripts/dd_summarize.py` 汇总（使用前先 `file_read` 阅读脚本头部用法）。

## 分步流程
1. **澄清口径**：确认数据源（日志/指标/span/RUM/产品分析）、时间窗（默认过去 1 小时，并说明时区）、过滤条件（`env`、`service`、`team` 等标签）、分组维度和 Top N。用户没说清楚时，按合理默认值执行，并在结果中写明所用口径。
2. **换算时间窗**：`shell_run` 执行 `python3 <本技能目录>/scripts/dd_summarize.py --window 6h`，得到 UTC ISO、秒和毫秒，供不同工具参数使用。
3. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`，记下可用工具及其参数 schema。
4. **按数据源选择工具**（细节见 `references/query-cookbook.md`）：
   - 日志计数/分组 → `analyze_datadog_logs`（SQL 风格聚合）；要看日志明细 → `search_datadog_logs`。
   - 指标 → 先用 `search_datadog_metrics` 或 `get_datadog_metric_context` 确认指标名和可用标签，再用 `get_datadog_metric` 查询，例如 `avg:system.cpu.user{env:prod} by {service}`。Top N 在结果上排序，或使用 `top()` 函数。
   - span/链路 → `search_datadog_spans`；开启了 apm 工具集时可用 `apm_search_spans`。
   - RUM 用户、会话、国家分布 → `aggregate_rum_events`（按 `@geo.country` 分组）；已开启 product-analytics 时可用 `aggregate_product_analytics_events`。
   - 跨数据源、需要 JOIN 或复杂 SQL → `ddsql` 工具集：`ddsql_schema_search_tables` → `ddsql_schema_get_table_columns` → `ddsql_run_query`，需要分享时用 `ddsql_create_link`。
5. **执行并校验**：返回为空时，逐项排查标签拼写、时间窗、索引和指标名，并用 `search_*` 验证过滤条件是否存在，不要直接说“没有数据”。
6. **汇总**：结果较大时先落盘，再执行 `python3 <本技能目录>/scripts/dd_summarize.py /tmp/miniq-dd/x.json --field <路径> --top 10`。
7. **输出**：表格、关键结论、所用查询语句；用户需要长期观看时，建议交给 `datadog-dashboards` 做成仪表盘或笔记本。

## 工具与参数要点
- 指标查询语法：`<聚合>:<指标>{<过滤>} by {<分组>}`，计数类指标加 `.as_count()`，速率类加 `.as_rate()`。
- 日志查询语法：`service:web env:prod status:error @http.status_code:>=500 -host:canary*`，属性前加 `@`。
- 时间参数有的工具接收 `now-6h` 这种相对时间，有的接收 epoch 毫秒，以 schema 为准。
- 查询语法速查见 `references/query-cookbook.md`，工具集和站点说明见 `references/toolsets-and-sites.md`。

## 质量检查
- 结论中的数字与原始返回一致；写明时间窗（含时区）、过滤条件和聚合方式。
- Top N 的排序字段与用户问题一致（例如按平均值还是最大值）。
- 数据有采样或截断时（例如分页未取完、结果上限）要明确说明。

## 失败回退
- 工具不存在：说明需要开启哪个工具集，同时用 `core` 工具（`search_datadog_logs`/`get_datadog_metric`）近似完成。
- 401/OAuth 失效：请用户重新授权；403：说明缺哪项 RBAC 权限；429：退避后重试一次。
- MCP 整体不可用：按参考文档的 REST 端点，用 `shell_run` + curl 查询。

## 交付格式
```
### <问题复述>（时间窗：2025-06-01 10:00–16:00 UTC+8，env:prod）
| 排名 | 服务 | 平均 CPU% | 峰值 CPU% |
|---|---|---|---|
结论：……
查询：`avg:system.cpu.user{env:prod} by {service}`
```
