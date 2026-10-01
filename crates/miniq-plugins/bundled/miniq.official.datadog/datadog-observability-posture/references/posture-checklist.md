# 可观测性体检清单与评分

| 维度 | 0 分 | 3 分 | 5 分 | 自动检查工具 |
|---|---|---|---|---|
| 统一标签 | 没有 service/env | 大部分服务有 | 全部服务都有 service/env/version/team | search_datadog_entities、list_tag_rules |
| 日志 | 未接入 | 接入但无结构化 | 结构化并有索引策略、敏感数据扫描 | search_datadog_logs |
| APM | 未接入 | 部分服务 | 全部关键服务，并关联日志 | search_datadog_spans |
| 监控 | 无 | 仅有资源监控 | RED + SLO + 拨测，覆盖所有关键服务 | get_monitor_coverage |
| SLO | 无 | 有目标但无燃烧率告警 | 有错误预算策略 | search_datadog_slos |
| 前端 | 无 RUM | 有 RUM | 有 RUM、source map 和会话回放 | search_rum_applications |
| 成本 | 不清楚 | 有月度查看 | 基数治理与成本建议闭环 | get_metric_volume、cost_recommendations |
| 治理 | 无 | 有规则 | 检测与缓解闭环 | list_governance_detections |
| 交付 | 无 CI 可见性 | 有流水线数据 | flaky 管理与 DORA 指标 | software-delivery 工具集 |
| 数据 | 无 | 部分关键表 | 关键表都有新鲜度、体量、结构监控 | data-observability 工具集 |

总分 = 各维度平均分；低于 3 分的维度进入整改清单。

## 整改优先级
1. 影响故障发现的（监控、SLO 缺口）
2. 影响故障定位的（APM、日志关联、统一标签）
3. 成本类（基数、日志索引）
4. 规范与流程类（治理、交付）
