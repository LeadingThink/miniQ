---
name: datadog-monitors
displayName: Datadog 监控与 SLO
description: 当用户要查看、梳理、新建或修改 Datadog 监控告警与 SLO 时使用：盘点监控状态与覆盖缺口，基于基线起草阈值，先校验再在确认后创建，并检查拨测与监控模板。
version: 1
---

# Datadog 监控与 SLO

## 触发场景
- “这个服务有哪些监控、哪些在告警或被静音”“给新服务补齐告警”“查一下 SLO 达成情况”“监控覆盖率怎么样”。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 创建、校验、覆盖率分析和 SLO 查询需要 `alerting` 工具集（URL 追加 `?toolsets=core,alerting`）；拨测需要 `synthetics` 工具集。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`，确认是否有 `create_datadog_monitor`、`validate_datadog_monitor`、`get_monitor_coverage`、`search_datadog_slos`。
2. **盘点现状**：用 `search_datadog_monitors` 按 `service:`/`team:` 标签筛选，整理名称、类型、查询、阈值、状态（OK/Alert/Warn/No Data）、通知对象、是否静音；用 `search_datadog_monitor_groups` 查看哪些分组（host/pod）在告警。
3. **SLO**：用 `search_datadog_slos` 列出目标、时间窗、当前达成率和剩余错误预算。
4. **覆盖缺口**：用 `get_monitor_coverage` 查看服务/主机的覆盖情况；再对照 `references/monitor-checklist.md`（错误率、延迟、流量骤降、饱和度、关键日志、拨测、SLO 燃烧率）逐项核对。
5. **定基线**：用 `get_datadog_metric` 查询近 7–14 天的分位数，按基线推荐 warning/critical 阈值，并说明推导过程。
6. **起草定义**：可以先用 `get_datadog_monitor_templates` 获取模板；用 `file_write` 把定义写到仓库 `monitors/<name>.json`（示例见参考文档）。通知对象（`@slack-…`、`@pagerduty-…`、邮箱）必须由用户提供。
7. **校验**：`validate_datadog_monitor`（或 REST `POST /api/v1/monitor/validate`）。校验通过后才进入创建环节。
8. **确认后写入**：用 `ask_user` 展示完整定义、通知对象和预期告警频率，得到同意后调用 `create_datadog_monitor`。MCP 没有修改或删除工具时，改用 REST `PUT/DELETE /api/v1/monitor/<id>`，同样需要先确认。
9. **拨测（可选）**：用 `get_synthetics_tests` 查看现有拨测；新建或编辑拨测（`synthetics_test_wizard`/`edit_synthetics_tests`）前也要 `ask_user`。
10. **验证**：重新读取监控，确认配置和状态，并报告监控 ID 与链接。

## 工具与参数要点
- 监控类型：`metric alert`/`query alert`、`log alert`、`trace-analytics alert`、`rum alert`、`composite`、`slo alert`、`service check`。
- 消息中可使用 `{{#is_alert}}…{{/is_alert}}`、`{{host.name}}` 等模板变量；标签建议包含 `service`、`env`、`team`、`created-by:miniq`。
- 设置 `notify_no_data` 时要考虑流量低谷，避免误报。

## 质量检查
- 阈值有基线依据；warning < critical；评估窗口与数据粒度匹配。
- 查询在 validate 中通过；标签过滤确实能命中数据（先用 get_datadog_metric 试查）。
- 不重复创建：先按名称和查询搜索已有监控。

## 失败回退
- 没有 alerting 工具集：只读盘点仍可用 `search_datadog_monitors`；创建走 REST（需要用户配置密钥），或者输出 JSON 让用户到 UI 中导入。
- 校验失败：根据报错修正查询语法后再校验，最多迭代 3 次，仍不通过就交回用户。

## 交付格式
- 现状表（名称 | 类型 | 状态 | 阈值 | 通知 | 静音）、SLO 表、缺口清单（优先级）、新建或修改的监控 ID 和链接，以及仓库中定义文件的路径。
