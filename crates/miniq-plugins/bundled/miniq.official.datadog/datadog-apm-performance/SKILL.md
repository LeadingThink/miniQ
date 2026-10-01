---
name: datadog-apm-performance
description: 当用户要用 Datadog 分析服务性能时使用：APM 服务健康与延迟瓶颈、Watchdog 异常、变更关联、持续剖析火焰图、数据库慢查询与执行计划、K8s 与网络，输出优化建议并关联代码。
version: 1
---

# Datadog 性能分析（APM / Profiling / DBM / K8s）

## 触发场景
- “这个接口为什么慢”“服务 p99 变高了”“哪个 SQL 最耗时”“CPU 被哪个函数吃掉了”“这次发布后性能退化了吗”“LLM 调用链耗时分析”。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 按需开启工具集：`apm`（Preview，需申请）、`profiling`、`dbm`、`kubernetes`、`networks`、`llmobs`、`live-debugger`（Preview），例如 `?toolsets=core,apm,profiling,dbm`。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`，确认已开启的工具集。
2. **服务健康**：`apm_get_service_health`（没有时用 core 的指标查询 RED 指标）；`apm_search_watchdog_stories` 查看 Watchdog 自动检测到的异常。
3. **找瓶颈**：用 `apm_latency_bottleneck_summary` 汇总慢在哪一层；用 `apm_search_spans`/`search_datadog_spans` 按 `@duration:>…` 找慢 span；用 `apm_query_trace`/`get_datadog_trace` 展开典型 trace；用 `apm_discover_span_tags` 找可用于分组的标签（如 `@db.statement`、`peer.service`）。
4. **变更关联**：用 `get_change_stories`/`semantic_search_change_stories` 查看同一时间段的部署、配置、开关变更。
5. **代码级热点**：用 `get_profiling_services` → `get_profiling_service_insights` → `explore_profiling_flame_graph`（CPU、wall、alloc、lock），对比变更前后的火焰图；`explore_profiling_timeline` 用于查看单次请求的线程活动。
6. **数据库**：用 `find_datadog_database_instances` → `get_datadog_database_query_performance`（按总耗时排序）→ `get_datadog_database_explain_plans` → `get_datadog_database_recommendations`/`optimize_datadog_database_query`（索引与改写建议）。
7. **基础设施**：`search_datadog_k8s_resources`/`describe_datadog_k8s_resource`（资源限制、OOMKilled、节流），`analyze_cloud_network_monitoring`（跨可用区流量、重传、DNS）。
8. **官方建议**：用 `apm_search_recommendations`/`apm_get_recommendation` 获取 Datadog 给出的优化建议。
9. **运行时取证（可选）**：开启 live-debugger 时，`create_datadog_logpoint` 可在不重新部署的情况下采集变量。这会影响线上进程，必须先 `ask_user`，结束后用 `disable_datadog_logpoints` 关闭。
10. **关联代码并提出优化**：用 `grep` 按 span 的 resource、函数名定位代码，用 `file_read` 分析；给出按收益排序的优化建议，改代码前先确认。

## 工具与参数要点
- 分析口径统一：同一服务、环境、时间窗；对比时选择“变更前同长度时间窗”。
- 火焰图要说明 profile 类型；CPU 热点和 wall time 热点的结论不同（后者包含 I/O 等待）。
- SQL 文本可能含敏感值，引用前做打码。
- 性能指标口径参考 `references/perf-analysis.md`。

## 质量检查
- 每条优化建议都附带证据（span 耗时占比、火焰图占比、SQL 总耗时占比）和预估收益。
- 区分“单次慢”和“普遍慢”：给出分位数与样本量。

## 失败回退
- 没有 apm 工具集：用 `search_datadog_spans` + `get_datadog_metric`（`trace.*` 指标）完成大部分分析。
- 未接入 profiling/DBM：说明缺少数据来源；需要时引导使用 `datadog-observability-posture` 中的接入流程。

## 交付格式
```
## <服务> 性能分析（时间窗、样本量）
### 结论（一句话）
### 瓶颈拆解（层级 | 耗时占比 | 证据）
### 热点代码 / SQL（位置 | 占比 | 建议）
### 相关变更
### 优化建议（按收益排序，含风险）
```
