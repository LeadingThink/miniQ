---
name: stock-data-cn
displayName: 证券数据获取
description: 当用户要获取 A 股、港股、美股的行情快照、历史 K 线、财务三表、主要股东、分红记录，或其他技能需要先把数据拉到本地时使用；负责代码规范化（600519 → sh600519 / 1.600519 / 600519.SS）、以 akshare / yfinance 为首选、公开 JSON 为备选的免 key 取数，并统一落到 投研/<代码>/data/*.csv。不做分析和结论。
version: 1
origin: installed
requires:
  bins: [python3]
---

# 证券数据获取

## 适用场景
- "把贵州茅台近 5 年的财务数据拉下来存成 CSV。"
- "600519 现在多少钱，今天成交额多少？"
- "给我腾讯 00700 最近一年的日 K 线。"
- "AAPL 最近 4 个季度的营收和净利润。"
- 其他技能（`stock-analysis-cn`、`portfolio-review` 等）的取数前置步骤。

不适用：解读数据、给结论——交给 `stock-analysis-cn`。

## 前置条件
- `python3` 可用。首选 `akshare`（A 股/港股免 key）与 `yfinance`（美股/港股）；缺库时**必须** `ask_user` 确认后再 `shell_run "python3 -m pip install --user akshare"`（国内可加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`）。用户拒绝安装时走 `web_fetch` 公开 JSON 备选。
- 数据源清单、代码映射表、JSON 接口探测方法见 `references/data-sources.md`（**第一次取数前先读**；接口报错或字段对不上时再读一遍并重新探测）。
- 落盘目录：`<工作区>/投研/<代码>/data/`，代码用交易所前缀形式（`sh600519`、`hk00700`、`us-AAPL`）。

## 步骤

### 1. 代码规范化
按 `references/data-sources.md` 的映射表把用户输入转换成各渠道需要的形式。核心规则：

| 市场 | 用户输入 | 新浪 | 东财 secid | yfinance | akshare |
|---|---|---|---|---|---|
| 沪市 | 600519 / 6xxxxx / 688xxx | `sh600519` | `1.600519` | `600519.SS` | `600519` |
| 深市 | 000001 / 3xxxxx | `sz000001` | `0.000001` | `000001.SZ` | `000001` |
| 北交所 | 8xxxxx / 4xxxxx | `bj830799` | `0.830799` | 不支持 | `830799` |
| 港股 | 00700 / 700 | `hk00700` | `116.00700` | `0700.HK` | `00700` |
| 美股 | AAPL | `gb_aapl` | `105.AAPL`（纳斯达克）/ `106.AAPL`（纽交所） | `AAPL` | `105.AAPL` |

用户只给公司名时 `web_search "<名称> 股票代码"`，多候选（A+H、ADR、同名）`ask_user`。

### 2. 行情快照
首选 `shell_run`：
```bash
python3 -c "import akshare as ak; df=ak.stock_zh_a_spot_em(); print(df[df['代码']=='600519'].T)"
```
备选 `web_fetch`（新浪，需 `Referer: https://finance.sina.com.cn` 头，可改用 `http_request` 带头）：`https://hq.sinajs.cn/list=sh600519`，返回 GBK 编码的逗号分隔串，字段顺序以探测为准。
再备选：东财 `https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f44,f45,f46,f57,f58,f60,f116,f162,f167`（字段含义以 `references/data-sources.md` 的探测记录为准，价格多为 ×100 或 ×1000 的整数）。
三条都失败 → `web_search "<名称> 今日股价"` 取媒体报道并标"非一手来源"。

记录：`投研/<代码>/data/quote-<YYYY-MM-DD-HHmm>.json`，内含 `source` 与 `fetched_at` 字段。

### 3. 历史 K 线
```bash
python3 -c "import akshare as ak; ak.stock_zh_a_hist(symbol='600519', period='daily', start_date='20210101', end_date='20261231', adjust='qfq').to_csv('投研/sh600519/data/kline-daily-qfq.csv', index=False)"
```
港股 `ak.stock_hk_hist(...)`，美股用 `yfinance`：`yf.Ticker('AAPL').history(period='5y')`。
备选东财 K 线接口 `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&lmt=250&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`。
复权口径必须写进文件名（`qfq` 前复权 / `hfq` 后复权 / `raw` 不复权），默认前复权。

### 4. 财务三表与指标
- A 股：`ak.stock_financial_abstract(symbol='600519')`（摘要）、`ak.stock_balance_sheet_by_report_em(symbol='SH600519')`、`ak.stock_profit_sheet_by_report_em(...)`、`ak.stock_cash_flow_sheet_by_report_em(...)`。函数名以 `python3 -c "import akshare as ak; print([f for f in dir(ak) if 'financial' in f or 'sheet' in f])"` 实际输出为准。
- 港股/美股：`yf.Ticker('0700.HK').financials / .balance_sheet / .cashflow`（年度）或 `.quarterly_financials`。
- 美股一手来源：SEC EDGAR（`references/data-sources.md`），年报 10-K、季报 10-Q。
- A 股一手来源：巨潮资讯公告 PDF，用 `web_fetch` 搜索页后 `view_pdf` 读关键页。
落盘：`balance.csv`、`income.csv`、`cashflow.csv`、`indicators.csv`，每个文件首行注释写来源与报告期。

### 5. 股东与分红
- 十大股东 / 流通股东：`ak.stock_gdfx_top_10_em(symbol='sh600519', date='20250630')`；股东户数 `ak.stock_zh_a_gdhs_detail_em(...)`。
- 分红：`ak.stock_fhps_detail_em(symbol='600519')`；美股 `yf.Ticker('AAPL').dividends`。
落盘 `holders.csv`、`dividends.csv`。

### 6. 校验与记录
- 每个 CSV 用 `shell_run "python3 -c 'import pandas as pd; df=pd.read_csv(...); print(df.shape, df.head(3), df.tail(3))'"` 检查非空、日期连续、数值可解析。
- 同一指标两个渠道差异 > 1% 时在 `投研/<代码>/data/README.md` 写明分歧与采信理由（优先一手来源）。
- `README.md` 记录每个文件的来源、接口、取数时间 `YYYY-MM-DD HH:mm`、复权与币种口径。

## 注意事项 / 安全
- 公开接口有限流：同一域名请求间隔 ≥ 1 秒，串行不并行；失败等 2 秒重试一次，仍失败则降级。
- 雪球等需登录态的页面不要求用户提供 Cookie；直接降级到其他渠道。
- 不编造任何字段；接口字段含义不确定时，先用小样本（已知股票的已知价格）比对校准，再批量取。
- 单位：A 股金额单位为元，港股港元，美股美元；涨跌幅为百分比。统一写入 README。

## 如何确认完成
- `投研/<代码>/data/` 下存在所需 CSV/JSON，`README.md` 标明来源与时间。
- 校验输出显示行数与首尾日期合理。
- 回复中列出文件路径、来源渠道、取数时间与已知缺口。

风险提示：本分析仅为信息整理，不构成投资建议。
