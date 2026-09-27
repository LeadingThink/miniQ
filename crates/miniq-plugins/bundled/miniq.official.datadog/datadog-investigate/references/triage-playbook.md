# 排障手册

## RED 与 USE
- 服务看 RED：Rate（请求量）、Errors（错误率）、Duration（延迟分位）。
- 资源看 USE：Utilization（使用率）、Saturation（饱和度，如队列、线程池、连接池）、Errors（错误）。

## 常用查询
- 错误日志：`service:<svc> env:prod status:error`
- 按异常类统计：在 analyze_datadog_logs 中对 `@error.kind`（或 `@error.message`）分组计数。
- 错误率：`sum:trace.<op>.errors{service:<svc>}.as_count() / sum:trace.<op>.hits{service:<svc>}.as_count()`，其中 `<op>` 常见为 `http.request`、`flask.request`、`express.request`、`servlet.request`。
- 延迟：`p95:trace.<op>{service:<svc>}` 或该服务的 duration 分布指标。
- 资源：`avg:container.cpu.usage{kube_deployment:<d>}`、`avg:container.memory.usage{...}`、`kubernetes.containers.restarts`。
- 与昨天同期对比：`timeshift(<query>, -86400)`。

## 典型根因模式
| 现象 | 优先怀疑 | 验证方式 |
|---|---|---|
| 发版后错误骤增 | 新代码或配置 | get_change_stories、部署事件、git log |
| 延迟升高但错误不多 | 下游慢、数据库慢查询、GC | trace 瓶颈 span、DBM、profiling |
| 某一台主机或 Pod 异常 | 节点问题、坏实例 | 按 host/pod 分组的指标 |
| 周期性尖刺 | 定时任务、缓存失效 | 按小时对比、事件 |
| 5xx 伴随连接错误 | 连接池耗尽、依赖不可用 | 日志关键字 timeout/refused、依赖服务健康 |

## 证据整理
- trace ID、日志 ID、监控 ID、incident ID 都要保留，便于用户在 Datadog 中打开查看。
- 日志中的个人信息与令牌需要打码后再引用。
