# 来源说明

本包中的技能参考了以下公开资料的方法论，并按 miniQ 技能规范重写为中文正文：

- WorkBuddy 内置金融技能的路由思想（意图识别 → 场景方法论 → 数据来源分级 → 免责声明）
- 社区开源技能 stock-analyzer / stock-analysis / us-stock-analysis / earnings-tracker / macro-monitor 的分析维度与流程骨架

重写原则：

- 所有依赖私有 API 或密钥的数据通道（westock、neodata、券商与富途接口等）一律移除，只保留分析方法；数据改为免 key 的公开渠道（东方财富、新浪财经、巨潮资讯、国家统计局、中国人民银行、SEC EDGAR、Yahoo Finance）与开源 Python 库（`akshare`、`yfinance`）。
- 公开页面与 JSON 接口的结构可能随时变化，本包只描述探测方法，不把字段名写死为事实；以 `references/data-sources.md` 的提示为准，变动时用 `web_fetch` 重新探测。
- 本包不包含任何第三方代码；不提供投资建议，所有结论须附数据来源与截至时间。
