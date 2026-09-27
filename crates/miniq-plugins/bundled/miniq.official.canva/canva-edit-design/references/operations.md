# perform-editing-operations 操作结构

> 字段名以 `tools/list` 中 `perform-editing-operations` 的 `inputSchema` 为准；下面是常见形态，用于快速组装。所有 `element_id` 必须来自本次事务返回的数据。

## 调用外层
```json
{
  "transaction_id": "<start 返回>",
  "pages": [ /* start 返回的 pages 原样传回 */ ],
  "page_index": 1,
  "operations": [ { "type": "..." } ]
}
```
`page_index` 为本批操作涉及的第一页（多数实现从 1 开始，以 schema 说明为准）。

## 文字内容
```json
{ "type": "replace_text", "element_id": "E1", "text": "双十一狂欢" }
{ "type": "find_and_replace_text", "element_id": "E2", "find_text": "2024", "replace_text": "2025" }
```
- `replace_text` 替换整个文本元素；保留该元素原有样式。
- `find_and_replace_text` 只替换子串，适合改年份、价格、错别字。
- 文本中的换行用 `\n`；多段落列表保留原有行数，避免版式错乱。

## 文字格式 `format_text`
```json
{ "type": "format_text", "element_id": "E1",
  "formatting": { "font_size": 64, "font_weight": "bold", "font_style": "normal",
                  "color": "#D62828", "text_align": "center", "line_height": 1.2,
                  "decoration": "underline", "strikethrough": "none",
                  "link": "https://example.com", "list_level": 0, "list_marker": "disc" } }
```
- 可只传需要改的键。颜色用 `#RRGGBB`。
- 字重只有 normal/bold；**字体族不可改**。
- 部分实现支持对字符区间格式化（start/end 索引），以 schema 为准。

## 媒体
```json
{ "type": "update_fill", "element_id": "F1", "asset_type": "image", "asset_id": "<asset_id>" }
{ "type": "insert_fill", "asset_type": "image", "asset_id": "<asset_id>",
  "left": 100, "top": 200, "width": 400, "height": 300, "alt_text": "产品正面照" }
{ "type": "delete_element", "element_id": "F2" }
```
- `asset_id` 来自 `upload-asset-from-url` 或已有素材；URL 不能直接用。
- `insert_fill` 新插入的元素可设置透明度等少量属性（以 schema 为准）；插入时尽量写 `alt_text`。
- 视频用 `asset_type: "video"`。

## 布局
```json
{ "type": "position_element", "element_id": "E3", "left": 80, "top": 960 }
{ "type": "resize_element", "element_id": "F1", "width": 540, "height": 540 }
```
- 单位为设计像素，原点在页面左上角。
- 等比缩放：新高 = 原高 × 新宽 / 原宽（原尺寸从事务返回数据里取）。
- 移动后确认 `left + width ≤ 页面宽`、`top + height ≤ 页面高`。

## 元数据
```json
{ "type": "update_title", "title": "双十一海报（终稿）" }
{ "type": "update_autofill_field", "element_id": "E1", "field_name": "product_name" }
```
`update_autofill_field` 仅适用于固定页面（非响应式）的设计，用于把元素标记为模板数据字段。

## 批处理建议
- 同一事务里的所有改动尽量放进一次调用；跨多页时，按页顺序排列操作。
- 单次操作过多（>50）时分几批调用，每批后检查返回是否有报错。
