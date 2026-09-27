# Datadog 查询速查

## 日志搜索语法
- 保留属性：`service:`、`env:`、`host:`、`status:`（error/warn/info）、`source:`、`version:`。
- 自定义属性前加 `@`：`@http.status_code:[500 TO 599]`、`@duration:>1000000000`（纳秒）、`@usr.id:123`。
- 逻辑与通配：`AND`、`OR`、`-`（取反）、`*`；短语用双引号：`"connection reset"`。
- 聚合统计（analyze_datadog_logs）示例：
  - 各服务日志量：`SELECT service, count(*) AS n FROM logs GROUP BY service ORDER BY n DESC LIMIT 20`
  - 各状态码分布：`SELECT @http.status_code, count(*) FROM logs WHERE service='web' GROUP BY 1`
  - 实际表名和字段写法以工具 schema 与报错提示为准。

## 指标查询语法
- `avg:system.cpu.user{env:prod,service:api} by {host}`
- 计数：`sum:trace.http.request.hits{service:api}.as_count()`
- 错误率：`sum:trace.http.request.errors{service:api}.as_count() / sum:trace.http.request.hits{service:api}.as_count()`
- 分位延迟：`p95:trace.http.request{service:api}`（分布指标），或 `avg:trace.http.request.duration.by.service.95p{service:api}`（以实际指标名为准）。
- Top N：`top(avg:system.cpu.user{*} by {service}, 10, 'mean', 'desc')`
- 常用函数：`rollup(avg, 300)`、`timeshift(-86400)`（环比）、`anomalies()`、`outliers()`。
- 容器 CPU 常见指标：`kubernetes.cpu.usage.total`、`container.cpu.usage`、`docker.cpu.usage`；主机：`system.cpu.user`、`system.cpu.idle`。先用 search_datadog_metrics 确认存在。

## span 查询
- `service:checkout env:prod status:error resource_name:"POST /pay"`、`@duration:>2s`、`operation_name:http.request`。

## RUM / 产品分析
- 用户量按国家：对 RUM session 或 view 事件做 `cardinality(@usr.id)`，按 `@geo.country` 分组；没有用户 ID 时退而用 `@session.id`，并在结论中注明。
- 常用字段：`@view.url_path`、`@view.loading_time`、`@application.name`、`@browser.name`、`@device.type`。

## DDSQL
- 先 `ddsql_get_spec` 了解方言，再用 `ddsql_schema_search_tables` 找表（如主机、容器、日志、span 相关表），用 `ddsql_schema_get_table_columns` 看字段。
- 查询务必带时间过滤和 `LIMIT`。

## 时间窗
- 相对时间：`now-15m`、`now-1h`、`now-7d`。
- 同一时刻在不同工具里可能要写成 ISO8601、秒或毫秒；可以用 `dd_summarize.py --window` 一次性换算出来。
