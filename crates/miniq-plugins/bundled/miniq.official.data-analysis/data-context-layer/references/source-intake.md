# 来源梳理与访谈

## 来源优先级（冲突时的默认信任顺序，可被用户覆盖）
1. 生产代码/转换逻辑（dbt 模型、ETL 脚本、视图定义）——真实执行的口径
2. 官方指标文档/语义层定义（LookML、Metrics YAML）
3. 被管理层使用的正式报表
4. wiki、会议纪要、聊天记录
5. 列名推断

## 盘点命令参考（只读）
- SQLite：`sqlite3 db.sqlite ".tables"`、`PRAGMA table_info(t);`、`SELECT COUNT(*) FROM t;`
- DuckDB：`duckdb db.duckdb -c "DESCRIBE t"`；直接查询 CSV/Parquet：`SELECT * FROM 'x.parquet' LIMIT 5`
- PostgreSQL：`psql -c "\dt+ schema.*"`、`information_schema.columns`
- MySQL：`SHOW TABLES; SHOW CREATE TABLE t;`
- dbt 项目：`file_glob` `models/**/*.yml`、`models/**/*.sql`；`file_grep` `ref\('...'\)` 找依赖
- 始终加 `LIMIT`，避免全表扫描大表；不执行任何写入/DDL

## 向用户/负责人确认的问题（挑最关键的问，不要一次全抛）
1. 这些数据主要回答哪些问题？谁在用？
2. 核心指标的“官方”定义在哪里？有没有历史口径变更？
3. 哪些记录应被排除（测试、内部、退款、作废）？
4. 时间用哪个时区？业务日切点是几点？
5. 数据多久刷新一次，通常延迟多久？
6. 有哪些已知的数据缺口或事故？

## 表重要性判断
- 被报表/查询引用次数多
- 包含核心实体（用户、订单、账户、事件）或核心指标
- 用户在范围确认中点名的表
