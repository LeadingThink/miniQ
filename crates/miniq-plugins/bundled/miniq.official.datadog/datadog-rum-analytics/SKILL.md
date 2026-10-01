---
name: datadog-rum-analytics
displayName: Datadog 前端体验与产品分析
description: 当用户要分析前端与产品数据时使用：RUM 页面性能与错误、会话回放、错误追踪 issue、产品分析（用户量按国家、漏斗路径、留存）、实验结果与功能开关状态。
version: 1
---

# Datadog 前端体验与产品分析

## 触发场景
- “按国家统计活跃用户”“首页 LCP 变差了吗”“结账漏斗在哪一步流失最多”“这个前端报错影响多少用户”“A/B 实验结果显著吗”“这个功能开关在 prod 的放量比例”。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- `core` 包含 `search_datadog_rum_events`、`aggregate_rum_events`；深入分析需要开启 `rum`、`product-analytics`、`session-replay`、`error-tracking`、`experiments`（默认不开）、`feature-flags` 工具集。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`。
2. **定位应用**：用 `search_rum_applications` 找到应用 ID 和名称；确认时间窗和环境。
3. **用户量与分布**：用 `aggregate_rum_events` 或 `aggregate_product_analytics_events` 对用户 ID 做去重计数，按 `@geo.country`/`@device.type`/`@browser.name` 分组。说明使用的是用户 ID 还是会话 ID。
4. **性能**：用 `get_rum_summary` 查看 Core Web Vitals（LCP、INP、CLS）和加载时间；用 `get_rum_insight` 获取自动洞察；用 `get_rum_view_waterfall` 拆解单个慢页面的资源瀑布。
5. **错误**：用 `search_datadog_error_tracking_issues` → `get_datadog_error_tracking_issue` → `analyze_datadog_error_tracking_errors`，得到影响用户数、首次和最近出现时间、版本分布；用 `grep` 在本地前端代码中定位（需要 source map）。修改 issue 状态、评论、关联工单等写操作要先 `ask_user`。
6. **会话回放**：用 `search_replays`/`get_replay_summary` 查看典型会话中的用户操作路径（注意隐私）。
7. **产品分析**：漏斗用 `run_product_analytics_journey`，路径用 `run_product_analytics_pathway`，留存用 `run_product_analytics_retention`；已有图表用 `get_product_analytics_saved_chart`。
8. **实验与开关**：用 `list_experiments` → `get_experiment_results`/`explore_experiment_results`（按细分维度）→ `get_experiment_diagnostics`（样本比例失衡等问题）；用 `list_datadog_feature_flags` → `get_datadog_feature_flag` → `list_datadog_feature_flag_allocations`。启停实验、修改开关放量属于线上变更，必须先 `ask_user`。
9. **RUM 运维（可选）**：RUM 自定义指标（`upsert_rum_metric`）、保留过滤器、operation 的增删改，都要先确认。
10. **输出**：按交付格式给出结论；需要图表时交给 `datadog-dashboards` 或本地可视化。

## 工具与参数要点
- 用户量口径：日活、周活、月活需要明确时间窗；跨天去重和按天求和的结果不同。
- 漏斗需要明确步骤事件的定义和转化时间窗口。
- 实验结论必须带置信区间或显著性，以及样本量；样本比例失衡（SRM）时结论不可信。
- 口径说明见 `references/rum-metrics.md`。

## 质量检查
- 数字附带口径（去重字段、时间窗、过滤条件）；国家分布中的“未知”值要单独列出。
- 性能指标按 p75 汇报（与 Web Vitals 的标准一致）。
- 回放与用户数据不在输出中暴露个人身份信息。

## 失败回退
- 缺少工具集：用 core 的 RUM 聚合完成基础统计，并说明开启哪些工具集可以获得漏斗、留存和实验分析。
- 没有 RUM 数据：建议用 onboarding 工具集的 `browser_onboarding` 接入（见 `datadog-observability-posture`）。

## 交付格式
- 结论摘要、表格（维度 | 用户数 | 占比）、Web Vitals 表（页面 | LCP p75 | INP p75 | CLS p75 | 评级）、漏斗转化表、实验结果（指标 | 对照 | 实验 | 提升 | 置信区间）、行动建议。
