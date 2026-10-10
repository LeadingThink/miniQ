# 免 key 公开数据渠道

> 所有页面与接口的结构**以实际探测为准**。本文只记录渠道、入口与探测方法；当返回报错、字段对不上或页面改版时，用 `web_fetch` / `http_request` 重新探测并更新本文的"探测记录"。不要把任何字段名当作永久事实。

## 1. 代码映射表

| 市场 | 判定规则 | 新浪 `hq.sinajs.cn` | 东财 `secid` | yfinance | akshare `symbol` | 巨潮/交易所 |
|---|---|---|---|---|---|---|
| 沪市主板 | 60xxxx | `sh600519` | `1.600519` | `600519.SS` | `600519` | `600519` |
| 科创板 | 688xxx | `sh688981` | `1.688981` | `688981.SS` | `688981` | `688981` |
| 深市主板 | 00xxxx | `sz000001` | `0.000001` | `000001.SZ` | `000001` | `000001` |
| 创业板 | 30xxxx | `sz300750` | `0.300750` | `300750.SZ` | `300750` | `300750` |
| 北交所 | 8xxxxx / 4xxxxx | `bj830799` | `0.830799` | 不支持 | `830799` | `830799` |
| 港股 | 1–5 位数字，补零到 5 位 | `hk00700` | `116.00700` | `0700.HK`（4 位） | `00700` | HKEX `0700` |
| 美股 纳斯达克 | 字母 ticker | `gb_aapl`（小写） | `105.AAPL` | `AAPL` | `105.AAPL` | SEC CIK |
| 美股 纽交所 | 字母 ticker | `gb_baba` | `106.BABA` | `BABA` | `106.BABA` | SEC CIK |
| 美股 其他 | 字母 ticker | `gb_xxx` | `107.XXX` | `XXX` | `107.XXX` | SEC CIK |
| A 股指数 | 上证 000001 / 深证 399001 / 沪深300 000300 | `s_sh000001` | `1.000001` / `0.399001` / `1.000300` | `000001.SS` / `399001.SZ` / `000300.SS` | `sh000001` | — |
| 美股指数 | 标普500 / 纳指 | — | `100.SPX` | `^GSPC` / `^IXIC` | — | — |

美股交易所前缀（105/106/107）不确定时，先 `web_fetch https://so.eastmoney.com/Web/s?keyword=AAPL` 从搜索结果 URL 中读取。

## 2. Python 库（首选）

| 库 | 覆盖 | 安装 | 备注 |
|---|---|---|---|
| `akshare` | A 股/港股行情、K 线、财务、股东、分红、财报日历、宏观 | `python3 -m pip install --user akshare` | 底层多数来自东方财富/新浪，接口名会随版本变动；用 `dir(ak)` 和 `help(ak.xxx)` 现场确认 |
| `yfinance` | 美股/港股行情、K 线、财务、分红、财报日期 | `python3 -m pip install --user yfinance` | 行情延迟约 15 分钟；财务数据来自 Yahoo 二次整理，关键数字对照 SEC 原文 |
| `pandas` | 落盘与校验 | 随上两者安装 | — |

安装前必须 `ask_user`；国内网络加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`。

常用 akshare 函数（以 `dir(ak)` 实际存在为准）：
- 行情：`stock_zh_a_spot_em()`、`stock_hk_spot_em()`、`stock_us_spot_em()`
- K 线：`stock_zh_a_hist(symbol, period, start_date, end_date, adjust)`、`stock_hk_hist(...)`、`stock_us_hist(...)`
- 财务：`stock_financial_abstract(symbol)`、`stock_balance_sheet_by_report_em(symbol='SH600519')`、`stock_profit_sheet_by_report_em`、`stock_cash_flow_sheet_by_report_em`、`stock_financial_analysis_indicator(symbol)`
- 股东：`stock_gdfx_top_10_em`、`stock_gdfx_free_top_10_em`、`stock_zh_a_gdhs_detail_em`
- 分红：`stock_fhps_detail_em(symbol)`
- 财报日历：`stock_yysj_em(symbol, date)`（预约披露）、`stock_yjyg_em(date)`（业绩预告）、`stock_yjkb_em(date)`（业绩快报）、`stock_yjbb_em(date)`（业绩报表）
- 指数：`stock_zh_index_daily(symbol='sh000300')`、`index_zh_a_hist(symbol='000300', period='daily')`
- 宏观：`macro_china_cpi_monthly()`、`macro_china_ppi_yearly()`、`macro_china_pmi_yearly()`、`macro_china_shrzgm()`（社融）、`macro_china_m2_yearly()`、`macro_china_lpr()`、`macro_usa_cpi_monthly()`、`macro_bond_public()`

## 3. 公开 JSON 接口（备选）

### 新浪行情
- URL：`https://hq.sinajs.cn/list=sh600519,sz000001,hk00700,gb_aapl`
- 必须带头：`Referer: https://finance.sina.com.cn`（用 `http_request` 的 `headers`）。
- 返回：`var hq_str_sh600519="名称,今开,昨收,现价,最高,最低,...,日期,时间";`，GBK 编码。A 股字段顺序通常为：名称、今开、昨收、现价、最高、最低、买一价、卖一价、成交量（股）、成交额（元）……倒数第 3、2 项为日期、时间。港股/美股字段顺序不同，**先用已知股票对照确认**。

### 东方财富行情
- 快照：`https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f170`
- 探测记录（2026-10 探测，可能过期）：`f43` 现价、`f44` 最高、`f45` 最低、`f46` 今开、`f47` 成交量、`f48` 成交额、`f57` 代码、`f58` 名称、`f60` 昨收、`f116` 总市值、`f117` 流通市值、`f162` PE(动)、`f167` PB、`f168` 换手率、`f170` 涨跌幅。价格字段多为整数，需除以 100（部分港股/基金除以 1000），用已知价格校准。
- K 线：`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&lmt=250&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`；`klt=101` 日线 / `102` 周线 / `103` 月线；`fqt=1` 前复权 / `2` 后复权 / `0` 不复权；`data.klines` 每行为"日期,开,收,高,低,量,额,振幅"。
- 资金流：`https://data.eastmoney.com/zjlx/600519.html`（页面渲染为 JS，`web_fetch` 可能拿不到，改 `browser_automation` 截图读取）。
- 请求间隔 ≥ 1 秒。

### 东方财富数据中心（网页）
- 财务：`https://data.eastmoney.com/bbsj/`（业绩报表）、F10 `https://emweb.securities.eastmoney.com/pc_hsf10/pages/index.html?type=web&code=SH600519#/cwfx`
- 公告：`https://data.eastmoney.com/notices/stock/600519.html`
- 研报：`https://data.eastmoney.com/report/stock/600519.html`（非一手来源）
- 上述页面多为前端渲染，`web_fetch` 为空时用 `browser_automation` open → snapshot。

### 新浪财经网页
- 个股：`https://finance.sina.com.cn/realstock/company/sh600519/nc.shtml`
- 财务摘要：`https://money.finance.sina.com.cn/corp/go.php/vFD_FinanceSummary/stockid/600519.phtml`（静态 HTML，`web_fetch` 可读）

### 雪球
- `https://xueqiu.com/S/SH600519`；多数接口需登录 Cookie。**没有登录态直接降级**，不要向用户索要 Cookie。

### 巨潮资讯（A 股公告一手来源）
- 首页：`http://www.cninfo.com.cn/`
- 公告搜索：`http://www.cninfo.com.cn/new/fulltextSearch?notautosubmit=&keyWord=贵州茅台 年度报告`
- 页面为前端渲染；用 `browser_automation` 搜索后取 PDF 链接（形如 `http://static.cninfo.com.cn/finalpage/<日期>/<id>.PDF`），下载后 `view_pdf` 读"主要会计数据"页。
- 交易所官网备选：上交所 `https://www.sse.com.cn/`、深交所 `https://www.szse.cn/`、港交所披露易 `https://www.hkexnews.hk/`。

### 美股
- Yahoo Finance 页面：`https://finance.yahoo.com/quote/AAPL/`（`yfinance` 更稳定）。
- SEC EDGAR 全文检索：`https://efts.sec.gov/LATEST/search-index?q="Apple Inc" 10-K&dateRange=custom`；公司列表 `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=AAPL&type=10-K&dateb=&owner=include&count=10`。
- SEC 要求 `User-Agent` 头含联系方式（如 `miniQ research contact@example.com`），否则 403。用 `http_request` 带头。
- XBRL 结构化财务：`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`（CIK 补零到 10 位），字段按 US-GAAP 标签。

## 4. 宏观数据

| 指标 | 一手来源 | 发布时间（北京） | 备选 |
|---|---|---|---|
| CPI / PPI | 国家统计局 `https://data.stats.gov.cn/` → 月度数据 | 每月 9–10 日 09:30 | `ak.macro_china_cpi_monthly()` |
| PMI（制造业/非制造业） | 国家统计局 + 中国物流与采购联合会 | 每月最后一天或次月 1 日 09:30 | `ak.macro_china_pmi_yearly()`；财新 PMI 次月 1 日 09:45 |
| 社融 / M2 / 新增信贷 | 中国人民银行 `http://www.pbc.gov.cn/` → 调查统计司 | 每月 10–15 日 16:00 后 | `ak.macro_china_shrzgm()`、`ak.macro_china_m2_yearly()` |
| LPR | 中国人民银行 / 全国银行间同业拆借中心 | 每月 20 日 09:00（遇假期顺延） | `ak.macro_china_lpr()` |
| GDP | 国家统计局 | 季后 15–20 日 10:00 | — |
| 美联储利率 | `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | FOMC 会后美东 14:00 | `ak.macro_bank_usa_interest_rate()` |
| 美债收益率 | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` | 美东每日收盘后 | `yf.Ticker('^TNX')`（10 年期 ×10） |
| 美国 CPI / 非农 | BLS `https://www.bls.gov/` | 美东 08:30 | `ak.macro_usa_cpi_monthly()`、`ak.macro_usa_non_farm()` |

媒体解读（非一手）：财新 `https://www.caixin.com/`、华尔街见闻 `https://wallstreetcn.com/`、财联社 `https://www.cls.cn/`。

## 5. 探测流程（页面变动时执行）
1. `http_request` GET 目标 URL（带必要头），看状态码与前 500 字符。
2. 用一只已知股票（如 600519 当天收盘价已从另一渠道确认）比对字段，锁定价格、涨跌幅、成交额位置。
3. 把确认的字段映射写回本文"探测记录"，并注明探测日期。
4. 仍不可用：换下一个渠道，并在交付中写明"渠道 X 于 YYYY-MM-DD 不可用"。
