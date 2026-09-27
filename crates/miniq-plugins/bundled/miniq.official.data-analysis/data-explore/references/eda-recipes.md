# EDA 代码配方

## pandas 路径
```python
import pandas as pd
df = pd.read_csv(PATH, encoding="utf-8-sig", low_memory=False)
# 粒度与主键
print(df.shape, df[KEY].is_unique, df.duplicated().sum())
# 日期解析与覆盖
df[DATE] = pd.to_datetime(df[DATE], errors="coerce")
print(df[DATE].min(), df[DATE].max(), df[DATE].isna().mean())
# 月度趋势（标出不完整周期）
m = df.set_index(DATE).resample("MS")[METRIC].agg(["sum", "count"])
days = df.set_index(DATE).resample("MS").apply(lambda x: x.index.normalize().nunique())
# 分组：值 + 样本量 + 占比
g = df.groupby(DIM)[METRIC].agg(total="sum", n="size", mean="mean", median="median")
g["share"] = g["total"] / g["total"].sum()
g.sort_values("total", ascending=False).head(15)
# 帕累托
s = df.groupby(ENTITY)[METRIC].sum().sort_values(ascending=False)
top10 = s.head(max(1, len(s) // 10)).sum() / s.sum()
# 相关（稳健）
df.select_dtypes("number").corr(method="spearman")
```

## 纯标准库路径
```python
import csv, statistics
from collections import defaultdict
tot, cnt = defaultdict(float), defaultdict(int)
with open(PATH, encoding="utf-8-sig", newline="") as f:
    for row in csv.DictReader(f):
        try:
            v = float(row[METRIC].replace(",", ""))
        except ValueError:
            continue
        tot[row[DIM]] += v
        cnt[row[DIM]] += 1
for k in sorted(tot, key=tot.get, reverse=True)[:15]:
    print(k, round(tot[k], 2), cnt[k])
```

## SQLite 路径（大文件或偏好 SQL）
```bash
sqlite3 :memory: <<'SQL'
.mode csv
.import data.csv t
SELECT substr(order_date,1,7) AS ym, COUNT(*) n, SUM(CAST(amount AS REAL)) amt
FROM t GROUP BY ym ORDER BY ym;
SQL
```
注意：`.import` 导入的列均为文本，求和前 `CAST`；日期需为 ISO 格式才能用 `substr` 聚合。

## 常见陷阱
- 合计行/小计行混在数据中 → 按关键列为空或文字“合计”过滤
- 数字带千分位、货币符号、百分号 → 先清洗再转换
- 同一实体多种写法（“北京”“北京市”）→ 标准化映射表
- 时区与日期截断 → 统一时区后再按日聚合
- 多对多连接导致行数膨胀 → 连接前后核对行数与合计
