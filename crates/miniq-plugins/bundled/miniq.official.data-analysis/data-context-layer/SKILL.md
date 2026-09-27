---
name: data-context-layer
description: 当用户希望为某个数据集、数据库或数仓整理可复用的数据上下文，包括表与字段字典、粒度、关联关系、指标口径、已知坑点和常用查询，形成语义层文档供后续分析反复使用时使用
version: 1
---

# 数据上下文层（语义层文档）

把“只有老员工知道”的数据知识沉淀成工作区里的文件，让后续每次分析都从同一套口径出发。

## 触发场景
- “帮我把这个库/这些表整理成数据字典”“以后分析都按这套口径”
- 同一数据源被反复分析，但每次都要重新弄清字段含义、连接方式、指标定义
- 团队口径不统一，需要一份权威定义并标注冲突

## 前置条件
- 可访问的数据：文件、SQLite/DuckDB 文件，或已配置好的数据库命令行（`psql`、`mysql`、`bq`、`snowsql` 等，凭据由用户环境提供，不在对话中索取密码）
- 可选的已有材料：数据字典、dbt 项目（`models/*.yml`）、LookML、SQL 仓库、wiki 导出、历史报告
- 模板见 `references/context-template.md`；来源梳理与访谈问题见 `references/source-intake.md`；维护与自动刷新见 `references/maintenance.md`

## 分步流程
1. **确定范围**：用 `ask_user` 确认业务域（如“电商订单与用户”）、最重要的 3–5 个问题/指标、使用者。范围宁小勿大，先覆盖高频表。
2. **盘点来源**（按 `references/source-intake.md`）：
   - 文件：`file_glob` 找数据与已有文档；`file_grep` 在 SQL/dbt/LookML 中搜表名、指标名
   - 数据库：`shell_run` 只读查询 information_schema / `PRAGMA table_info` / `\d+`，列出表、列、类型、行数、分区与更新时间
   - 业务文档：交给 `data-business-context` 查找指标定义与变更记录
3. **画像核心表**：对每张核心表跑 `data-quality-audit/scripts/profile_data.py`（数据库表先导出抽样 CSV，或直接用 SQL 统计），确认粒度、主键、时间列、枚举值与空值情况。
4. **梳理关系**：通过列名相似、外键约束、实际连接命中率（`LEFT JOIN` 命中比例）确认连接键与基数（1:1、1:N、N:M），记录连接放大风险。
5. **定义指标**：对每个核心指标写：业务含义、SQL/公式、分子分母、过滤、去重、时区、时间归属、负责人、来源依据。多个来源定义冲突时并列记录并标注“待确认”，不要自行裁决。
6. **记录坑点**：测试账号、历史口径变更日期、已知数据缺口、迟到数据、枚举含义变化、软删除标记等。
7. **写入文件**：`file_write` 生成 `data-context/` 目录：
   - `data-context/README.md`：总览、适用范围、更新时间、维护人
   - `data-context/tables/<表名>.md`：表级文档
   - `data-context/metrics.md`：指标口径
   - `data-context/joins.md`：关系与连接方式
   - `data-context/queries/*.sql`：经过验证的常用查询
   - `data-context/gotchas.md`：已知问题
8. **验证**：挑 2–3 个指标，用文档中的 SQL/公式实际运行，与已知报表数字对账；结果写入 README 的“验证记录”。
9. **可选：固化为专用技能**：若用户希望 miniQ 以后自动使用此上下文，可按 `references/context-template.md` 末尾的“项目技能”格式，在用户的技能目录（而不是本插件目录）生成一个 SKILL.md，描述何时读取 `data-context/`。

## 工具与参数要点

- `file_glob`/`file_grep`：搜索已有口径资料，例如 `models/*.yml`、`*.lkml`、`*.sql`、`README*`、`docs/**`。`doc_read`：读取数据字典、wiki 导出和历史报告
- `shell_run`：只读探查数据库结构和样本，例如 `sqlite3 x.db .schema`、`duckdb -readonly`、`psql -c "\d+ 表"`。凭据由用户环境提供，不在对话里索取
- 字段画像可用 `python3 <插件目录>/data-quality-audit/scripts/profile_data.py <文件> --out-json ... --out-md ...`，用来补充取值范围和空值率
- `file_write`/`file_edit`：维护 `data-context/` 下的 `README.md`、`entities.md`、`metrics.md`、`glossary.md` 等文件。修改时增量编辑，不整体覆盖
- `ask_user`：口径冲突或负责人不明时集中提问一次，并附上候选答案
- 每条定义都要写明来源和更新时间，没有依据的内容标“待确认”

## 质量检查
- 每个指标都能追溯到来源（文件、SQL、文档或用户确认），无来源的标注“推断”
- 每张表写明粒度与主键，且主键唯一性经实测
- 常用查询都实际跑通过，并记录运行日期
- 不写入任何凭据、连接串密码、个人明细数据

## 失败回退
- 无数据库访问权限：请用户导出 schema（DDL）与小样本 CSV；或只基于文档建立“待验证”版本
- 表太多：按查询频率/用户优先级只做前 10 张，其余列入待办
- 口径冲突无法裁决：并列记录并列入“待确认问题”，用 `ask_user` 请负责人确认

## 交付格式
- `data-context/` 目录（结构见上），README 中含：范围、表清单、指标清单、验证记录、待确认问题、最后更新时间
- 对话中汇报：覆盖的表与指标数量、验证结果、主要坑点、待确认事项
