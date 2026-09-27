# 监控覆盖清单与定义示例

## 每个在线服务的最低覆盖
| 维度 | 建议监控 | 典型阈值来源 |
|---|---|---|
| 错误率 | 5xx / 总请求 | 近 14 天 p99 的 2–3 倍，或业务可接受上限 |
| 延迟 | p95/p99 延迟 | 基线 p95 × 1.5 作为 warning，× 2 作为 critical |
| 流量 | 请求量骤降（anomalies 或 change 告警） | 与上周同期对比 |
| 饱和度 | CPU、内存、连接池、队列积压 | 80% / 90% |
| 可用性 | 拨测（HTTP/API/浏览器） | 连续 2 个地点失败 |
| 关键日志 | 特定异常关键字计数 | > 0 或超过基线 |
| SLO | 错误预算燃烧率（多窗口多燃烧率） | 1h 14.4x / 6h 6x |
| 依赖 | 下游与数据库错误、慢查询 | 视情况 |

## 指标监控示例
```json
{
  "name": "[checkout] 5xx 错误率过高",
  "type": "query alert",
  "query": "sum(last_5m):sum:trace.http.request.errors{service:checkout,env:prod}.as_count() / sum:trace.http.request.hits{service:checkout,env:prod}.as_count() > 0.05",
  "message": "{{#is_alert}}checkout 5xx 错误率超过 5%（当前 {{value}}）{{/is_alert}} @<由用户提供>",
  "tags": ["service:checkout", "env:prod", "team:<团队>", "created-by:miniq"],
  "options": {"thresholds": {"critical": 0.05, "warning": 0.02}, "notify_no_data": false, "renotify_interval": 60}
}
```

## 日志监控示例
```json
{
  "name": "[checkout] 错误日志激增",
  "type": "log alert",
  "query": "logs(\"service:checkout env:prod status:error\").index(\"*\").rollup(\"count\").last(\"5m\") > 10",
  "message": "checkout 错误日志 > 10 条/5min @<由用户提供>",
  "options": {"thresholds": {"critical": 10}}
}
```
（JSON 字符串中的引号转义以实际 validate 结果为准。）

## 常见误区
- 用 avg 看错误率会掩盖尖刺，应改用 sum 比值。
- 低流量服务的比例告警容易抖动，应加最小请求量条件（composite），或改用计数告警。
- 所有告警都通知同一个频道会导致告警疲劳，应按严重程度分流。
