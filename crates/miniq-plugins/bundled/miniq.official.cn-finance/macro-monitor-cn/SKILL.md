---
name: macro-monitor-cn
displayName: 宏观监测
description: 当用户要查看或定期整理中国与美国的宏观指标（CPI、PPI、PMI、社融、M2、新增信贷、LPR、GDP、美联储利率、美债收益率、美国 CPI 与非农），要"每日/每周宏观表"、趋势图或"最新数据什么时候发布"时使用；一手来源为国家统计局、中国人民银行、美联储、美国财政部与 BLS，备选 akshare。不做市场方向预测。
version: 1
origin: installed
requires:
  bins: [python3]
---

# 宏观监测

## 适用场景
- "最近 CPI、PPI、PMI 什么情况，做个表。"
- "这个月社融和 M2 什么时候公布？出了的话帮我整理一下。"
- "美联储最近一次议息决定是什么，10 年期美债收益率多少？"
- "给我做一张近 3 年 CPI 和 PPI 的趋势图。"
- "每周一帮我整理上周发布的宏观数据。"

不适用：个股或行业分析（`stock-analysis-cn`）；对未来经济走向做预测（本包只整理已发布数据和官方解读）。

## 前置条件
- `python3` + `akshare`（宏观函数以 `dir(ak)` 中 `macro_` 开头者为准），缺库 `ask_user` 后安装。
- 指标定义、发布时间表、一手来源 URL、解读要点见 `references/indicators.md`（**整理前必读**，判断"最新数据"属于哪个周期时尤其需要）。
- 出图读 `miniq.official.visual-language/visual-language-core/SKILL.md`，用 `visual-charts` 或 `data-visualize`。
- 落盘目录 `<工作区>/投研/宏观/`。

## 步骤

### 1. 确定目标周期
- 用户说"最新 / 最近 / 这个月"时，先对照 `references/indicators.md` 的发布时间表判断该指标**最近一个已发布的周期**。例：今天 2026-10-08，CPI 最新已发布周期是 2026 年 8 月（9 月数据 10 月 9–10 日才发布），不要把"当月"当最新。
- 用户指定了历史周期（"2024 年全年"），严格按指定范围。
- 相对时间按北京时间：上周 = 上周一至上周日；本周 = 本周一至今。

### 2. 取数（逐级降级，写明降级原因）
1. **一手来源**：`web_fetch` 国家统计局 `https://data.stats.gov.cn/` 月度数据页或新闻发布稿（`https://www.stats.gov.cn/sj/zxfb/`）、中国人民银行 `http://www.pbc.gov.cn/` 调查统计司、美联储 `https://www.federalreserve.gov/`、美国财政部收益率表、BLS 发布稿。页面为前端渲染时用 `browser_automation` open → snapshot。
2. **akshare**：`shell_run` 例如
   ```bash
   python3 -c "import akshare as ak; print(ak.macro_china_cpi_monthly().tail(6))"
   ```
   其他：`macro_china_ppi_yearly`、`macro_china_pmi_yearly`、`macro_china_shrzgm`、`macro_china_m2_yearly`、`macro_china_lpr`、`macro_china_gdp_yearly`、`macro_bank_usa_interest_rate`、`macro_usa_cpi_monthly`、`macro_usa_non_farm`、`macro_bond_public`。
3. **媒体公开页**：财新、华尔街见闻、财联社，标"非一手 / 需核实原文"。
4. 美债收益率备选：`yfinance` `^TNX`（10 年期，数值 ×10）、`^FVX`（5 年）、`^IRX`（13 周）。

每个数字记录：指标 | 周期 | 发布值 | 前值 | 市场预期（有则写，标非一手）| 发布时间 | 来源 URL。

### 3. 整理表格
- **每日表**（有新发布才写）：`投研/宏观/日报-<YYYY-MM-DD>.md`，按"中国 / 美国 / 政策与讲话"分组，每行一个指标，附一句"怎么看"（取自 `references/indicators.md`，不加预测）。
- **每周表**：`投研/宏观/周报-<YYYY-MM-DD>.md`，汇总上周发布的所有数据 + 本周待发布日历。
- **指标面板**：`投研/宏观/panel.csv`，长表：`date,indicator,period,value,prev,source,fetched_at`，每次追加，不覆盖历史。
- 单位统一：同比 %；社融、M2 增量用"万亿元 / 亿元"并写明是"存量同比"还是"当月新增"；LPR 用 %；美债收益率 %。

### 4. 趋势图
对用户关心的 2–4 个指标出图（`visual-charts`）：
- CPI 与 PPI 同比双线（近 36 个月）；PMI 以 50 荣枯线为参考线；社融存量同比与 M2 同比双线；美债 2 年 / 10 年与利差。
- 标题写结论句（如"PPI 同比已连续 N 个月为负"），副标题写口径与区间，底部写来源与截至日期。
- 涨跌或高于/低于前值用朱砂/松绿加箭头，不只靠颜色。保存到 `投研/宏观/charts/`，截图自检。

### 5. 交付
- 第一段：本期最重要的 2–3 个数字（含周期、发布值、前值、来源、发布时间）。
- 然后表格 / 图表路径。
- 最后：本周待发布日历（日期 + 指标 + 发布机构）与风险提示。

## 注意事项 / 安全
- 不替官方做解读：只引用统计局 / 央行发布稿里的官方说明；媒体观点标明出处。
- 不做"降息概率""下月 CPI 预测"等前瞻判断；用户追问时说明本包定位。
- 周期误标是最常见错误：每个数字必须写清"2026 年 8 月同比"而非"最新 CPI"。
- 国家统计局接口有访问频率限制，失败后等 2 秒重试一次，再失败降级到 akshare。

## 如何确认完成
- 表格中每个指标都有周期、发布值、前值、来源、发布时间五要素。
- `panel.csv` 追加成功且可用 pandas 读取。
- 图表（如有）已截图自检，中文正常显示。

风险提示：本分析仅为信息整理，不构成投资建议。宏观数据以官方发布为准，后续可能修订。
