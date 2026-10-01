# 交付形式对照

| 形式 | 适合 | 依赖 | 更新方式 | 局限 |
|---|---|---|---|---|
| 单文件 HTML（默认） | 发邮件、离线查看、静态托管、周期快照 | 无（浏览器） | 重跑数据脚本 + `build_dashboard.py` | 数据量受限（建议 < 5MB）；无实时查询 |
| Streamlit | 需要 Python 交互、连接数据库、参数化分析 | `streamlit`、pandas | 应用内实时查询 | 需要运行环境与服务器 |
| BI 平台规格 | 企业已有 Tableau/Power BI/Superset/Metabase/Looker | 用户的 BI 平台 | 平台调度刷新 | 需用户在平台上搭建 |

## Streamlit 骨架要点
- `st.set_page_config(layout="wide")`；顶部 `st.columns` 放 `st.metric` KPI
- `@st.cache_data(ttl=3600)` 缓存数据加载
- 侧边栏筛选：`st.sidebar.date_input`、`st.sidebar.multiselect`
- 图表：`st.line_chart`/`st.bar_chart`，或 matplotlib `st.pyplot`
- 数据库凭据从环境变量或 `st.secrets` 读取，不写入代码
- 运行：`python3 -m streamlit run app.py`（先征得用户同意安装与运行）

## BI 规格文档结构
1. 目标与受众、刷新频率
2. 数据集：来源表、SQL、粒度、刷新方式
3. 计算字段：名称、公式、格式
4. 页面布局草图（ASCII 或 Markdown 表格描述网格）
5. 每个可视化：类型、维度、度量、筛选、排序、颜色规则、提示信息
6. 筛选器与联动
7. 权限与行级安全需求
8. 验收标准：与哪些已知数字对账
