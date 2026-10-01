---
name: data-explore
displayName: 探索性数据分析（EDA）
description: 当用户给出 CSV、Excel、JSON 或数据库表，想快速了解数据概况、结构、分布、分组统计与趋势，并得到带图表和数字依据的探索性分析结论时使用
version: 1
---

# 探索性数据分析（EDA）

## 触发场景
- “帮我看看这份数据”“这个表有什么规律”“销售数据按月怎么变化”
- 拿到一份新数据，在做正式报告、看板、诊断之前先摸清：粒度、字段含义、时间覆盖、主要分布与关系
- 只需要改格式/排版的表格任务不在本技能范围（可交给表格类技能）

## 前置条件
- 输入：工作区中的 `.csv/.tsv/.xlsx/.xls/.json/.parquet`，或可用 `shell_run` 只读查询的数据库（`sqlite3`、`duckdb`、`psql` 等）
- `python3`；pandas/matplotlib 可选。检查：`shell_run` → `python3 -c "import pandas, matplotlib; print(pandas.__version__)"`
  - 缺失时：本插件脚本全部可用纯标准库运行；需要 pandas 做复杂分组时，征得同意后执行 `python3 -m pip install --user pandas openpyxl matplotlib`

## 分步流程
1. **明确问题**：从用户原话提取关心的问题、维度、时间范围。问题完全不清楚时用 `ask_user` 问一句“最想从这份数据里知道什么？”，同时给出 2–3 个基于列名的候选问题。
2. **定位与预览**：`file_glob` 找文件；`doc_read`（`maxRows: 50`）预览表头、工作表、编码、表头是否在第一行、是否有合计行/备注行。
3. **一键画像**：`shell_run` 运行
   `python3 <插件目录>/data-quality-audit/scripts/profile_data.py <文件> --out-json analysis/profile.json --out-md analysis/profile.md [--date-col 日期列] [--key 主键列]`
   用 `file_read` 读 `analysis/profile.md`，得到每列类型、缺失率、唯一值、Top 值、数值分位数、异常值、日期覆盖和问题清单。
4. **确定粒度**：用一句话写出“一行代表什么”（如“一行 = 一个订单的一个商品”），找出候选主键并验证唯一性；这决定后续所有计数与求和是否正确。
5. **按问题分析**：`file_write` 写 `analysis/explore.py`，`shell_run` 执行（pandas / 纯标准库 / SQLite 三种写法见 `references/eda-recipes.md`）。按下方清单选做：
   - 单变量：数值列分布（直方图/箱线图、分位数）；类别列频数 Top N 与长尾占比
   - 时间：按日/周/月聚合趋势，注意不完整的首尾周期（标出或剔除）
   - 分组：按用户关心的维度 `groupby` 求和/均值/比率，同时列出每组样本量
   - 关系：数值列相关矩阵（Spearman 更稳健），关键两变量散点图
   - 集中度：前 10%/前 N 个实体贡献占比（帕累托）
   - 无 pandas 时：用 `csv` 模块 + `collections` 聚合，或 `sqlite3` 把 CSV 导入内存库后写 SQL
6. **出图**：用 `data-visualize` 的 `make_chart.py` 或 matplotlib 生成到 `analysis/figures/`；每张图标题写“结论句”而不是“某某分布”。用 `view_image` 抽查，确认中文不乱码、轴标签与单位正确。
7. **写结论**：`file_write` 输出 `analysis/report.md`（结构见下）。发现数据质量问题严重时，建议转入 `data-quality-audit`；需要正式交付时转 `data-report`。

## 分析清单（至少覆盖）
- 行数、列数、粒度、时间范围、数据截至日期
- 缺失率 > 5% 的列、重复行、主键冲突、明显异常值、类型可疑列（数字存成文本、日期未解析）
- 与用户问题直接相关的 3–7 条发现，每条带数字、对比基准和样本量
- 可能的混杂因素或偏差（例如某月只有半月数据、某渠道口径不同）

## 工具与参数要点

- `file_glob`：定位数据文件。`doc_read`：预览 xlsx/csv 前几行，确认表头与编码。`file_read`：读取数据字典或说明
- `shell_run`：运行分析代码（`python3 - <<'EOF' ... EOF` 或 `analysis/*.py`），以及只读数据库查询（`sqlite3 -readonly`、`duckdb -readonly`）
- 快速画像可复用 `python3 <插件目录>/data-quality-audit/scripts/profile_data.py <文件> --key <主键> --date-col <日期列> --out-json analysis/dq/profile.json --out-md analysis/dq/profile.md`（加 `--pure` 或设置 `MINIQ_DA_PURE=1` 可不依赖 pandas）
- 出图用 `<插件目录>/data-visualize/scripts/make_chart.py <spec.json> -o analysis/figures/xx.png`。有 matplotlib 时输出 PNG，缺失时自动降级为 SVG
- `file_write`：写分析脚本和 `analysis/explore.md`。`view_image`：逐张检查生成的图
- 大文件先用 `--max-rows` 或 `head` 抽样，确认口径后再跑全量；不修改原始数据文件

## 质量检查
- 所有百分比写清分母；所有均值考虑是否被极端值拉偏（同时给中位数）
- 分组对比时样本量过小（如 < 30）要标注
- 趋势结论要检查首尾不完整周期
- 相关不等于因果，措辞用“与……相关”“同期”
- 报告中的每个数字都能在脚本输出中找到

## 失败回退
- 中文乱码：依次尝试 `utf-8-sig`、`gbk`、`gb18030`；画像脚本会自动尝试
- Excel 多表头/合并单元格：`doc_read` 看清结构后用 `header=`/`skiprows=` 读取，或请用户确认表头行
- 文件过大（数百 MB 以上）：先抽样（`nrows=` / `head -n`）或导入 `sqlite3`/`duckdb` 用 SQL 聚合，并在报告中说明
- matplotlib 不可用：`make_chart.py` 自动输出 SVG

## 交付格式
`analysis/report.md`：
1. 一句话回答（直接回应用户问题）
2. 数据概况（来源、粒度、行列数、时间范围、截至日期）
3. 数据质量要点（问题 + 影响 + 处理方式）
4. 关键发现 3–7 条（结论句 + 数字 + 图表路径）
5. 局限与下一步建议（需要更深入时推荐的技能）

## 安全
- 不修改原始数据；清洗结果另存（如 `analysis/cleaned.csv`）
- 含个人信息时只展示聚合结果
- 安装依赖前先确认
