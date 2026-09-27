# 自动填充（autofill）负载与图片字段处理

## mapping.json 格式（供 `canva_bulk.py payload` 使用）
```json
{
  "full_name": {"column": "姓名", "type": "text"},
  "job_title": "职位",
  "avatar":    {"column": "头像URL", "type": "image_url"},
  "logo":      {"column": "logo_asset", "type": "image_asset"}
}
```
- 键必须是模板字段的**原始名称**（区分大小写）。
- 值可以直接写列名字符串（默认 `text`）。
- `type`：
  - `text` → `{"type":"text","text":"<单元格>"}`
  - `image_asset` → 单元格已是 Canva 素材 ID，直接生成 `{"type":"image","asset_id":"<单元格>"}`
  - `image_url` → 单元格是图片链接，脚本把它放进 `needs_upload`，由执行者先上传再并入 `data`

## autofill-design 调用示例
```json
{
  "server": "canva",
  "tool": "autofill-design",
  "arguments": {
    "brand_template_id": "DAExxxxxx",
    "title": "批量设计 - 第3行 - 李四",
    "data": {
      "full_name": {"type": "text", "text": "李四"},
      "avatar":    {"type": "image", "asset_id": "Mxxxxxxxx"}
    }
  }
}
```
参数名以当前 `tools/list` 返回的 schema 为准；如为异步任务，保留返回的任务 ID 轮询状态。

## 图片字段三种模式
| 模式 | 数据特征 | 做法 |
|---|---|---|
| A. 已有素材 ID | 列中是 Canva asset ID | `type: image_asset`，直接填充 |
| B. 图片 URL | 列中是 http(s) 链接 | 每行执行前 `upload-asset-from-url`（`url`、`name`）→ 取 `asset_id` → 并入 `data`；上传是写入账号素材库的操作，在第 4 步统一获得许可 |
| C. 没有图片数据 | 模板有图片字段但表中无对应列 | 问用户：省略该字段（模板保留默认图）或中止 |
本地图片文件无法直接上传：需用户提供公网可访问链接或自行上传到 Canva 后提供素材 ID。

## 数据清洗建议
- 去除首尾空格（脚本已处理）；全空行自动跳过。
- 数字列（如价格）若表格软件导出为 `1234.0`，按展示需要格式化后再填。
- 单元格超过模板文本框容量（`inspect --max-len` 标出的超长文本）→ 试跑时重点检查，必要时让用户精简。
- 电话、身份证号等长数字在 Excel 中可能变成科学计数法，提醒用户以文本格式保存。

## 结果 JSONL（供 `report` 使用）
每行一个 JSON 对象，字段：`row`、`status`（`created`/`failed`）、`title`、`design_id`、`design_url`、`export_file`、`error`。缺省字段留空即可。

## 限流与规模
- 顺序执行，每行之间无需刻意等待；遇到 429/限流错误时等待数秒再重试一次。
- ≥ 50 行：先试跑 3 行；≥ 200 行：建议分批（每批 50 行）并在批次之间向用户汇报。
