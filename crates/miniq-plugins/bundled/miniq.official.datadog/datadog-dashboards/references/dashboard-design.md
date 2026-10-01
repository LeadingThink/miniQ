# 仪表盘设计与最小 JSON

## 推荐布局（服务概览）
1. 顶部：query_value × 4（请求量、错误率、p95 延迟、Apdex/SLO）。
2. 流量与错误：timeseries（按 resource 分组的请求量与错误数）。
3. 延迟：timeseries（p50/p95/p99），toplist（最慢接口 Top 10）。
4. 依赖：toplist（下游服务错误），数据库慢查询。
5. 资源：CPU、内存、Pod 重启。
6. 日志：list_stream（error 日志）。

## 模板变量
```json
"template_variables": [
  {"name": "env", "prefix": "env", "default": "prod"},
  {"name": "service", "prefix": "service", "default": "*"}
]
```
查询中写成 `{$env,$service}`。

## 最小组件示例
```json
{
  "definition": {
    "type": "timeseries",
    "title": "请求量（按接口）",
    "requests": [{"q": "sum:trace.http.request.hits{$env,$service} by {resource_name}.as_count()", "display_type": "bars"}]
  }
}
```
```json
{"definition": {"type": "query_value", "title": "错误率", "precision": 2,
  "requests": [{"q": "sum:trace.http.request.errors{$env,$service}.as_count() / sum:trace.http.request.hits{$env,$service}.as_count() * 100", "aggregator": "avg"}]}}
```
```json
{"definition": {"type": "toplist", "title": "CPU Top 10 服务",
  "requests": [{"q": "top(avg:system.cpu.user{$env} by {service}, 10, 'mean', 'desc')"}]}}
```

## 仪表盘外壳
```json
{"title": "<服务> 概览（miniQ 生成）", "layout_type": "ordered", "description": "由 miniQ 创建，数据口径见各组件标题",
 "widgets": [ ... ], "template_variables": [ ... ]}
```
新版 API 字段以 `get_widget_reference` 的返回为准。
