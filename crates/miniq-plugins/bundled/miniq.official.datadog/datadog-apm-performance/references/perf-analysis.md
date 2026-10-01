# 性能分析口径

## 延迟拆解
- 请求总耗时 = 自身代码 + 下游调用 + 数据库 + 外部 API + 排队。span 的 self time 反映本层耗时，duration 包含子 span。
- 关注 p95/p99 而不是平均值；同时查看请求量，避免把低流量下的噪声误判为退化。

## 退化判定
- 同样长度的前后时间窗对比，p95 上升 > 20% 且样本量足够（每窗 > 1000 请求），才认定为退化。
- 结合 change stories 与部署事件确认时间点。

## Profiling 类型
| 类型 | 用途 |
|---|---|
| CPU | 计算密集热点 |
| Wall time | 包含等待，定位阻塞 I/O |
| Allocations / Heap | 内存分配与泄漏 |
| Lock / Contention | 锁竞争 |
| Exceptions | 异常开销 |

## DBM 常见优化
- 全表扫描 → 加索引；N+1 → 批量查询或预加载；大 OFFSET 分页 → 游标分页；锁等待 → 缩短事务。
- 执行计划中 rows examined 与 rows returned 的比值过大，通常说明索引不当。

## K8s
- CPU throttling 高：limit 过低；OOMKilled：内存 limit 过低或存在泄漏；滚动发布期间错误升高：检查 readiness 探针。
