# RUM 与产品分析口径

## Core Web Vitals（p75）
| 指标 | 良好 | 需改进 | 差 |
|---|---|---|---|
| LCP | ≤ 2.5s | ≤ 4s | > 4s |
| INP | ≤ 200ms | ≤ 500ms | > 500ms |
| CLS | ≤ 0.1 | ≤ 0.25 | > 0.25 |

## 常用字段
- 用户：`@usr.id`、`@usr.email`（敏感）、`@session.id`
- 地理：`@geo.country`、`@geo.country_iso_code`、`@geo.city`
- 页面：`@view.name`、`@view.url_path`、`@view.loading_time`
- 设备：`@device.type`、`@os.name`、`@browser.name`
- 错误：`@error.message`、`@error.source`、`@error.stack`

## 统计陷阱
- 未登录用户没有 `@usr.id`，只统计用户 ID 会低估总量，需同时给出会话数。
- 采样率低于 100% 时，计数需要按采样率换算，或注明是样本数据。
- 漏斗按“同一会话内”还是“时间窗口内”计算，结果差异很大，需事先说明。
- 实验：先检查 SRM（样本比例失衡），再看主指标；多指标比较要注意多重检验。
