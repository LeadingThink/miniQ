---
name: datadog-investigate
displayName: Datadog 故障排查
description: 当用户要借助 Datadog 排查线上故障、报错或变慢时使用：按服务和时间窗串联告警、incident、日志、指标、APM 链路、变更与 K8s 事件，形成时间线和根因假设，并关联到本地代码。
version: 1
---

# Datadog 故障排查

## 触发场景
- 错误率升高、延迟变大、告警触发、incident 进行中；“checkout 服务 10 点开始 500，帮我查一下”。
- 发版后出现异常，需要确认是否与这次变更有关。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 关联代码时需要本地仓库（当前工作区）。

## 分步流程
1. **确定范围**：服务（`service:`）、环境（`env:`）、时间窗（换算为 UTC；可用 `python3 <本技能目录>/scripts/dd_summarize.py --window 2h`）、现象（错误码、接口、告警名）。
2. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`。
3. **起点**：用 `search_datadog_monitors` 查该服务正在告警的监控，用 `search_datadog_incidents`/`get_datadog_incident` 查进行中的 incident，用 `search_datadog_events` 查部署、配置变更等事件，由此确定首次异常时间。
4. **日志**：先用 `analyze_datadog_logs` 按错误消息或异常类统计高频项，再用 `search_datadog_logs` 取 3–5 条代表性样本（含堆栈）。
5. **指标**：用 `get_datadog_metric` 对比故障前后的错误数、请求量、延迟 p95、主机/容器 CPU 和内存；可用 `timeshift` 与昨天同期对比。
6. **链路**：用 `search_datadog_spans`/`get_datadog_trace` 找出错或最慢的 trace，定位瓶颈 span（下游服务、数据库、外部 API）。开启 apm 工具集时，优先用 `apm_get_service_health`、`apm_latency_bottleneck_summary`、`apm_search_watchdog_stories`、`get_change_stories`（部署/配置变更与异常的关联）。
7. **基础设施**：开启相应工具集时，用 `search_datadog_hosts`、`analyse_datadog_k8s_rollout`（滚动发布）、`get_datadog_database_query_performance`（慢 SQL）交叉印证。
8. **可选：Bits AI 调查**：开启 investigator 工具集时，可用 `trigger_incident_investigation` 或 `trigger_bits_ai_investigation` 让 Datadog 并行调查。触发前需 `ask_user`，结果作为参考证据，而不是最终结论。
9. **关联代码**：用 `grep` 在本地仓库搜索错误消息、异常类和路由；`shell_run` 执行 `git log --since=<故障前一天> --oneline -- <路径>`；用 `file_read` 阅读可疑代码。
10. **结论与处置**：按“首次异常 → 告警 → 峰值 → 恢复/现状”整理时间线，给出根因假设（标注置信度）、证据 ID/链接、影响范围、修复建议。修改代码用 `file_edit`，提交或部署前先 `ask_user`。需要后续跟踪时交给 `datadog-incident-response`。

## 工具与参数要点
- 日志与指标查询语法见 `references/triage-playbook.md`，工具集说明见 `references/toolsets-and-sites.md`。
- 先聚合、再抽样：不要一次拉取上千条日志明细。
- 大结果落盘到 `/tmp/miniq-dd/`，用 `dd_summarize.py --field attributes.service --numeric attributes.duration` 汇总。

## 质量检查
- 每条结论都有可追溯证据（日志样本、指标数值、trace ID、事件 ID）。
- 相关与因果要区分：时间上吻合的变更只是嫌疑，需要机制上说得通。
- 已排除的假设也要列出，避免用户重复排查。

## 失败回退
- 缺少 apm/kubernetes/dbm 等工具集：先用 core 工具完成排查，并告诉用户开启哪个工具集可以提高精度。
- 无 trace 数据（服务未接入 APM）：改用日志和指标，并建议接入。
- MCP 不可用：使用 REST 退路（见参考文档）。

## 交付格式
```
## 故障摘要：<服务> <现象>（UTC+8 时间窗）
### 时间线
| 时间 | 事件 | 证据 |
### 根因假设（置信度：高/中/低）
### 影响范围
### 证据清单（日志样本 / 指标 / trace ID / 链接）
### 代码定位：path/to/file.py:123
### 修复与后续建议
```
