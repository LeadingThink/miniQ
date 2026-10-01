# 定位 Canva 设计：从用户输入得到 design_id

所有针对已有设计的技能都用同一套规则，顺序如下：

| 用户给的是 | 处理 |
|---|---|
| `https://canva.link/abc123` 等短链 | `resolve-shortlink` 得到完整 URL，再按下一行提取 |
| `https://www.canva.com/design/DAGxxxx/yyyy/edit?...` | 取 `/design/` 之后、下一个 `/` 或 `?` 之前的段：`DAGxxxx` |
| `DAGxxxx`、`DABcd1234ef` 这类以 `D` 开头的字符串 | 就是 design_id，直接用；**不要搜索** |
| 设计名称，如“春季上新海报” | `search-designs` query=名称；0 条 → 请用户给链接；1 条 → 使用；多条 → 列出标题+更新时间让用户选 |
| “刚才那个”“这个设计” | 复用本次对话里最近生成/编辑的设计 ID；拿不准就问 |
| 什么都没给 | `ask_user` 要链接或 ID |

## 提取规则
正则：`/design/([A-Za-z0-9_-]+)`。也可运行 `python3 <canva-brand-batch 技能目录>/scripts/canva_bulk.py design-id "<链接>"` 提取。

## 校验
- 拿到 ID 后先 `get-design`：确认存在、可访问、记录标题与页数，后续命名副本、写报告都用这个标题。
- `get-design` 返回 404/403：告诉用户该设计不存在或当前账号无权访问（常见于别人分享的“仅查看”链接），请对方授予编辑权限或复制到自己账号。
