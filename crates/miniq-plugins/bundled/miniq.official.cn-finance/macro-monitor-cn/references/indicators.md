# 宏观指标说明与发布时间表

发布时间为常规安排，遇节假日顺延；以发布机构官网当月"发布日程"为准。所有"怎么看"只是指标含义说明，不是预测。

## 1. 中国

| 指标 | 定义 | 发布机构 / 一手 URL | 发布时间（北京） | akshare 函数（以 `dir(ak)` 为准） | 怎么看 |
|---|---|---|---|---|---|
| CPI | 居民消费价格指数同比 / 环比 | 国家统计局 `https://www.stats.gov.cn/sj/zxfb/` | 每月 9–10 日 09:30，发布上月数据 | `macro_china_cpi_monthly` / `macro_china_cpi_yearly` | 看同比方向与核心 CPI（剔除食品能源）；猪肉、能源权重大 |
| PPI | 工业生产者出厂价格同比 | 国家统计局 | 与 CPI 同日 | `macro_china_ppi_yearly` | 连续为负反映工业品通缩压力；与 CPI 剪刀差影响中下游利润 |
| 制造业 PMI | 采购经理指数 | 国家统计局 + 中国物流与采购联合会 | 每月最后一日或次月 1 日 09:30，发布当月数据 | `macro_china_pmi_yearly` | 50 为荣枯线；看新订单、生产、库存分项 |
| 财新 PMI | 民营中小企业样本 | 财新 / S&P Global | 次月 1 日 09:45（制造业）、3 日 09:45（服务业） | `macro_china_cx_pmi_yearly` | 与官方 PMI 对照看结构差异 |
| 社会融资规模 | 当月新增 / 存量同比 | 中国人民银行 `http://www.pbc.gov.cn/diaochatongjisi/` | 每月 10–15 日 16:00 后（不固定） | `macro_china_shrzgm` | 存量同比是趋势指标；当月新增有强季节性，看同比多增/少增 |
| M2 / M1 | 广义 / 狭义货币同比 | 中国人民银行 | 与社融同日 | `macro_china_m2_yearly` | M1−M2 剪刀差反映资金活化程度 |
| 新增人民币贷款 | 当月 | 中国人民银行 | 与社融同日 | `macro_china_new_financial_credit` | 看企业中长期贷款占比 |
| LPR | 1 年期 / 5 年期以上贷款市场报价利率 | 全国银行间同业拆借中心 `https://www.chinamoney.com.cn/` | 每月 20 日 09:00（遇假期顺延） | `macro_china_lpr` | 5 年期与房贷挂钩 |
| GDP | 季度同比 / 累计 | 国家统计局 | 1/4/7/10 月中旬 10:00 | `macro_china_gdp_yearly` | 看三产结构与两年平均 |
| 工业增加值 | 规模以上工业同比 | 国家统计局 | 每月 15 日前后 10:00（1–2 月合并） | `macro_china_industrial_production_yoy` | — |
| 社会消费品零售总额 | 同比 | 国家统计局 | 与工业增加值同日 | `macro_china_retail_total` | 看餐饮 vs 商品、线上占比 |
| 固定资产投资 | 累计同比 | 国家统计局 | 同上 | `macro_china_fixed_asset_investment` | 拆制造业 / 基建 / 地产 |
| 进出口 | 美元计价同比 | 海关总署 `http://www.customs.gov.cn/` | 每月 7–10 日 | `macro_china_trade_balance` | — |
| 外汇储备 | 月末 | 国家外汇管理局 | 每月 7 日 | `macro_china_fx_reserves_yearly` | — |

## 2. 美国

| 指标 | 发布机构 / 一手 URL | 发布时间（美东 → 北京） | akshare / yfinance | 怎么看 |
|---|---|---|---|---|
| FOMC 利率决议 | 美联储 `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | 每年 8 次，会后 14:00 → 次日 02:00（夏令时）/ 03:00（冬令时） | `macro_bank_usa_interest_rate` | 看联邦基金目标区间、点阵图、声明措辞变化 |
| CPI | BLS `https://www.bls.gov/cpi/` | 每月中旬 08:30 → 20:30 / 21:30 | `macro_usa_cpi_monthly` | 核心 CPI 环比为市场关注点 |
| PCE | BEA `https://www.bea.gov/` | 月末 08:30 | `macro_usa_core_pce_price` | 美联储偏好的通胀指标 |
| 非农就业 | BLS | 每月第一个周五 08:30 | `macro_usa_non_farm` | 新增人数、失业率、时薪同比 |
| ISM 制造业 PMI | ISM | 每月第一个工作日 10:00 | `macro_usa_ism_pmi` | 50 荣枯线 |
| GDP | BEA | 季后首月末 08:30（初值）| `macro_usa_gdp_monthly` | 年化环比 |
| 美债收益率 | 美国财政部 `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve` | 每日收盘后 | `macro_bond_public`；`yf.Ticker('^TNX')`（10 年，值 ×10）、`^FVX`、`^IRX` | 2 年 − 10 年倒挂常被视为衰退信号（仅为统计关系） |
| 美元指数 | ICE | 实时 | `yf.Ticker('DX-Y.NYB')` | — |

夏令时：3 月第二个周日至 11 月第一个周日，北京 = 美东 + 12 小时；其余 + 13 小时。按当前日期推导。

## 3. 周期判定示例

| 今天 | 指标 | 最近已发布周期 | 下次发布 |
|---|---|---|---|
| 2026-10-08 | 中国 CPI | 2026 年 8 月 | 2026-10-09 或 10 日（9 月数据） |
| 2026-10-08 | 制造业 PMI | 2026 年 9 月（9 月 30 日发布） | 2026-10-31（10 月数据） |
| 2026-10-08 | 社融 | 2026 年 8 月 | 10 月 10–15 日（9 月数据） |
| 2026-10-08 | LPR | 2026 年 9 月 22 日报价 | 2026-10-20 |

## 4. 日报 / 周报模板

```
# 宏观日报 2026-10-10

## 中国
| 指标 | 周期 | 发布值 | 前值 | 预期（非一手） | 发布时间 | 来源 |
|---|---|---|---|---|---|---|
| CPI 同比 | 2026-09 | x.x% | x.x% | x.x%（媒体汇总） | 2026-10-10 09:30 | 国家统计局 <URL> |
> 怎么看：……（来自本文"怎么看"列，不加预测）

## 美国
…

## 政策与讲话
- 2026-10-09 央行三季度货币政策委员会例会：……（一手：pbc.gov.cn，链接）

## 本周待发布
| 日期 | 指标 | 机构 |
```
