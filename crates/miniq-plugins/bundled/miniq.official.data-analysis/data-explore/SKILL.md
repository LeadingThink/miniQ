---
name: data-explore
description: 当用户给出 CSV 或 Excel 数据文件，想了解数据概况、质量问题、分布、分组统计或趋势，并得到带图表的探索性分析结论时使用
origin: installed
---

## 适用场景

用户说"帮我看看这份数据"、"分析一下这个表"、"销售数据有什么规律"。输入为工作区中的 `.csv`、`.xlsx`、`.xls` 文件。只需要改格式或做报表排版时优先用 `spreadsheet-workflow`。

## 步骤（写明每步用哪个工具）

1. 定位文件：用 `file_glob` 查找数据文件；多个文件时用 `ask_user` 确认分析对象和关心的问题（例如"按月销售额变化"）。
2. 快速预览：用 `doc_read` 读取前 50 行（`maxRows: 50`），了解列名、类型、编码、表头位置、是否有多个工作表。
3. 检查环境：用 `shell_run` 执行 `python3 -c "import pandas, matplotlib; print(pandas.__version__)"`。
   - 可用：进入第 4 步用 pandas 分析。
   - 不可用：告知用户，可在确认后执行 `python3 -m pip install --user pandas openpyxl matplotlib`；若用户不同意安装，只用 `doc_read` 分页读取做描述性统计（适合小文件）。
4. 用 `file_write` 写分析脚本 `analysis/explore.py`，再用 `shell_run` 执行 `python3 analysis/explore.py`。脚本应包含：
   - 读取：`pd.read_csv(path)` 或 `pd.read_excel(path, sheet_name=None)`；中文 CSV 乱码时尝试 `encoding="gbk"`。
   - 概况：`df.shape`、`df.dtypes`、`df.head()`、`df.describe(include="all")`。
   - 质量：每列缺失率 `df.isna().mean()`、重复行 `df.duplicated().sum()`、异常值（IQR 法）、类型可疑列（数字存成文本、日期未解析）。
   - 分布与关系：数值列直方图、类别列 `value_counts().head(10)`、数值列相关矩阵。
   - 业务问题：按用户关心的维度 `groupby(...).agg(...)`，时间列用 `resample("M")` 看趋势。
   - 图表用 `matplotlib` 保存到 `analysis/figures/*.png`（设置中文字体或使用英文标签，避免乱码方块）。
5. 用 `view_image` 抽查生成的图表，确认可读、坐标轴正确。
6. 用 `file_write` 输出 `analysis/report.md`：数据概况 → 数据质量问题 → 关键发现（3–7 条，每条附数字依据与图表路径）→ 后续建议。

## 注意事项 / 安全

- 不修改原始数据文件；清洗结果另存为新文件（如 `analysis/cleaned.csv`）。
- 大文件（数百 MB 以上）先用 `nrows=` 或 `usecols=` 抽样，并向用户说明。
- 数据含个人信息时，报告中只展示汇总结果，不列出具体个人记录。
- 结论要区分相关与因果，样本量小时注明不确定性。
- 安装 Python 包前先向用户确认。

## 如何确认完成

脚本能完整运行无报错，报告中的每个结论都能追溯到脚本输出或图表，且回答了用户最初关心的问题。
