---
name: datadog-observability-posture
displayName: Datadog 可观测性体检与治理
description: 当用户要评估和改进 Datadog 可观测性体系时使用：服务接入与标签规范、监控覆盖率、指标基数与成本、云成本建议、治理控制台检测、CI 与测试健康、数据可观测性，以及引导式接入。
version: 1
---

# Datadog 可观测性体检与治理

## 触发场景
- “我们的可观测性做得怎么样”“哪些服务没有监控或没接 APM”“自定义指标费用太高，怎么降”“有哪些省钱建议”“CI 里哪些 flaky 测试最多”“帮我给 K8s 集群接入 Datadog”。
- 周期性体检：发现问题 → 修复 → 复查。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 按需开启工具集：`alerting`（覆盖率）、`metrics-governance`、`cost`、`governance`（Preview，需联系 Datadog 支持）、`software-delivery`、`data-observability`、`onboarding`、`reference-tables`。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`；按 `references/posture-checklist.md` 标注哪些检查项可以自动完成。
2. **资产盘点**：用 `search_datadog_entities` 列出服务目录（负责团队、语言、层级），用 `search_datadog_hosts` 列出主机；检查 `service`、`env`、`version`、`team` 统一标签的覆盖情况。
3. **遥测覆盖**：逐个服务检查是否有日志、APM trace、指标（用 `search_datadog_logs`/`search_datadog_spans` 各取 1 条验证）以及 RUM（前端）。
4. **告警覆盖**：用 `get_monitor_coverage` 和 `search_datadog_slos` 找出没有监控或没有 SLO 的关键服务；补监控交给 `datadog-monitors`。
5. **成本与基数**：用 `get_metric_volume`/`estimate_datadog_metric_cardinality`/`get_metric_cardinality_profile` 找出基数最高的自定义指标及其导致膨胀的标签；用 `get_metric_tag_configuration` 查看现有配置；用 `cost_recommendations` 获取云成本节省建议。
6. **治理**：用 `list_governance_insights`/`list_governance_detections`/`list_governance_best_practices`/`list_governance_limits` 发现违规和风险；用 `list_tag_rules` 查看标签规则。
7. **交付健康**：用 `get_datadog_flaky_tests`、`aggregate_datadog_ci_pipeline_events`（失败率、耗时）、`aggregate_dora_deployments`（部署频率、变更失败率）。
8. **数据可观测性**：用 `get_data_observability_monitor_coverage`、`rank_data_observability_monitor_candidates` 找出缺少质量监控的关键表。
9. **整改（写操作，逐项确认）**：修改指标标签配置（`manage_metric_tag_configuration`，会影响历史查询与计费）、缓解治理检测（`mitigate_governance_detections`）、创建标签规则、更新 flaky 测试状态，每一项都要先 `ask_user` 展示影响。
10. **接入引导**：缺少接入时，按需调用 `kubernetes_onboarding`/`browser_onboarding`/`serverless_onboarding`/`llm_observability_onboarding`/`test_optimization_onboarding`/`source_map_uploads` 生成步骤；修改本地配置文件（Helm values、SDK 初始化代码）用 `file_edit`，并在确认后执行。
11. **评分与闭环**：输出体检评分卡和整改清单；建议定期复查，并与上次结果对比（可将评分卡保存到仓库 `observability/posture-<日期>.md`）。

## 工具与参数要点
- 降低指标基数的常用手段：只索引查询中真正使用的标签（Metrics without Limits）、去掉 user_id/request_id 这类高基数标签、合并相似指标。操作前要确认有没有仪表盘或监控依赖这些标签。
- 评分方法见 `references/posture-checklist.md`。

## 质量检查
- 每一项评分都有数据依据；无法自动检查的项目标注为“需人工确认”。
- 整改建议给出预估收益（如节省的指标数、覆盖率提升）和风险。

## 失败回退
- 缺少 governance 等 Preview 工具集：用 core + alerting 工具完成可以做的部分，其余列出人工检查方法。
- 没有权限：列出需要的权限清单。

## 交付格式
```
## 可观测性体检（日期、范围）
| 维度 | 得分(0-5) | 证据 | 主要问题 |
## Top 10 整改项（优先级 | 动作 | 收益 | 风险 | 负责人待定）
## 已执行变更（经确认）
## 下次复查要点
```
