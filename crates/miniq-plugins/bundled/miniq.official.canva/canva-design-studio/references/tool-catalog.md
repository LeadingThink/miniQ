# Canva MCP 工具速查

> 以 `tools/list` 实际返回为准。下表按用途归类，参数名是常见形态，调用前核对 `inputSchema`。
> 调用格式：`mcp_call {"server":"canva","tool":"<工具名>","arguments":{...}}`

## 定位与读取（只读，无需确认）
| 工具 | 用途 | 参数要点 |
|---|---|---|
| `resolve-shortlink` | 把 `canva.link/xxx` 解析成完整设计链接 | `shortlink` |
| `search-designs` | 按标题搜索用户的设计 | `query`；可能分页（`continuation`） |
| `get-design` | 标题、页数、所有者、编辑/查看链接 | `design_id` |
| `get-design-pages` | 每页缩略图与尺寸 | `design_id`，可选分页 |
| `get-design-thumbnail` | 渲染后的缩略图（看版式/颜色的主要依据） | `design_id`，可选 `page_index` |
| `get-design-content` | 只返回文字（richtexts），不含颜色/字体/位置 | `design_id`，可选页码 |
| `get-presenter-notes` | 演示文稿的演讲者备注 | `design_id` |
| `get-export-formats` | 该设计可导出的格式 | `design_id` |
| `list-brand-kits` | 品牌工具包 ID/名称/缩略图（未必含色值与字体） | 无 |
| `search-brand-templates` | 搜索品牌模板；`dataset=non_empty` 只返回可自动填充的模板 | `query`、`dataset` |
| `get-brand-template-dataset` | 模板的可填充字段（名称区分大小写、类型 text/image/chart） | `brand_template_id` |
| `list-comments` / `list-replies` | 评论线程与回复 | `design_id`、`thread_id` |
| `list-folder-items` | 文件夹内容 | `folder_id` |

## 生成与创建（改动账号，需确认）
| 工具 | 用途 | 参数要点 |
|---|---|---|
| `generate-design` | AI 生成候选 | `design_type`、`query`、可选 `brand_kit_id`、可选素材 `asset_ids` |
| `create-design-from-candidate` | 候选 → 可编辑设计 | `job_id`、`candidate_id` |
| `autofill-design` | 用品牌模板 + 数据生成一份设计 | `brand_template_id`、`data`、`title` |
| `resize-design` | 生成新尺寸副本（原稿不变） | `design_id`、`design_type`（预设或 `{type:"custom",width,height}`） |
| `copy-design`（若提供） | 原尺寸复制 | `design_id` |
| `import-design-from-url` | 从公网 URL 导入 PDF/PPTX 等 | `url`、`name` |
| `upload-asset-from-url` | 上传图片/视频为素材，返回 `asset_id` | `url`、`name` |
| `export-design` | 导出（异步） | `design_id`、`format`、可选 `pages`/`quality`/尺寸 |

## 编辑事务（详见 `canva-edit-design` 技能）
`start-editing-transaction` → `perform-editing-operations` → `commit-editing-transaction` / `cancel-editing-transaction`

## 协作与整理（需确认）
`comment-on-design`、`reply-to-comment`、`create-folder`、`move-item-to-folder`

## 通用规则
1. 原始 `D...` ID 不要拿去 `search-designs`，搜索只匹配标题。
2. 能并行的只读调用（多个缩略图、多个 resize）可以一次发出；有依赖的写操作按顺序。
3. 所有返回里的链接（`urls.edit_url`、`urls.view_url`）直接给用户，不要自行拼接。
4. 列表类返回有分页时，按 `continuation` 继续取，直到拿全或达到用户需要的数量。
