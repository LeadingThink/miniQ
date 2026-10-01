# Adobe 云端 MCP 工具目录与资产流程

> 下列工具名来自公开资料中出现过的常见名称，**实际可用的工具和参数一律以 `tools/list` 为准**。服务端会按账号套餐和客户端动态暴露工具，有些工具需要延迟加载，并不会出现在首次返回的列表里。

## 1. 工具目录
| 分组 | 工具（常见名） | 用途 | 关键参数 |
|---|---|---|---|
| 初始化 | `adobe_mandatory_init` | 会话初始化与 egress 状态 | `skill_name`, `skill_version` |
| 资产 | `asset_add_file` / `read_widget_context` | 组件上传（ChatGPT 专用，miniQ 通常不可用） | — |
| 资产 | `asset_initialize_file_upload` → `asset_finalize_file_upload` | 分步上传本地文件 | 文件名、MIME、大小 → 返回上传 URL 与资产 ID |
| 资产 | `asset_preview_file` | 预览或取回链接 | `assets[]`, `source` |
| 资产 | `asset_share_link` | 生成分享链接 | 资产/看板 ID |
| 图像 | `image_auto_straighten` | 自动拉直 | `uprightMode`, `constrainCrop` |
| 图像 | `image_apply_auto_tone` | 自动影调 | `type:"cameraRawFilter"` |
| 图像 | `image_apply_adjustments` | 曝光/对比/高光/暗部/鲜艳度等 | 单个数值，不接受范围 |
| 图像 | `image_list_presets` / `image_apply_preset` | 列出和应用 Lightroom 预设 | 预设 ID |
| 图像 | `image_select_subject` | 主体/人脸/皮肤分割 | 部位列表 |
| 图像 | `image_apply_lens_blur` / `image_apply_gaussian_blur` | 背景虚化 | `blurRadius`, `blurTarget` |
| 图像 | `image_crop_and_resize` | 裁切、缩放、智能重构图 | `output{width,height}`, `fit`, `focus` |
| 图像 | `image_remove_background` | 去背景 | 图像 URI |
| 图像 | `image_fill_area` / `image_generative_expand` | 生成式填充和扩图（消耗额度） | 区域 / `top,bottom,left,right` |
| 生成 | `image_generate` | Firefly 生图 | `options{prompt, referenceImage, aspectRatio, n}` |
| 看板 | `create_firefly_board` / `boards_create_new_board` / `boards_add_items_to_board` | Firefly 看板 | `doc_name`, `board_id` |
| 设计 | `search_design` / `fill_text` / `replace_image` / `change_background_color` / `animate_design` / `download_design` | Express 模板 | `templateURN`/`documentURN` |
| 视频 | `video_create_quick_cut` + `quickCutPoll` | 高光快剪 | `assetIds`, `target_duration`, `user_prompt` |
| 视频 | `video_resize` + `resizeVideoPoll` | 视频改尺寸 | `assetId`, `width`, `height` |
| 素材 | Stock 搜索类工具 | 搜索 Adobe Stock | 关键词、方向、类型 |
| PDF | PDF 类工具 | 合并、导出、转换 | 以 schema 为准 |

## 2. 资产上传（本地文件 → 云端）
1. 先用 `ask_user` 取得上传同意，并告知用户文件会存放在其 Adobe 账号下。
2. 调用 `asset_initialize_file_upload`，传入文件名、MIME（例如 `image/jpeg`、`video/mp4`）和字节数（`stat -f%z` 或 `wc -c`），得到预签名上传 URL 和资产标识。
3. 上传文件：
   ```bash
   curl -sS -X PUT -H "Content-Type: <mime>" --data-binary @<本地文件> "<uploadUrl>"
   ```
4. 调用 `asset_finalize_file_upload` 确认上传，拿到可用于图像工具的 URI 或视频工具需要的 `assetId`。
5. **永远不要把本地路径直接传给图像或视频工具。** 大于 500 MB 的视频先提醒用户上传耗时，或者先在本地压缩。

## 3. 下载与留存
- 下载：`mkdir -p adobe/out/<任务>` 后执行 `curl -L --fail -o adobe/out/<任务>/<文件名> "<url>"`。
- 预签名 URL 通常数小时内失效，Express 文档约 12 小时后会被清理，所以必须及时下载。
- 汇报时只给出文件路径，或去掉签名参数的链接说明，不要回显完整签名。

## 4. 云端不可用时的本地替代
| 云端能力 | 本地替代 |
|---|---|
| 调色、预设、裁切 | `adobe-batch-edit-photos/scripts/local_batch_grade.py`（ffmpeg） |
| 多尺寸裁切 | `adobe-create-social-variations/scripts/social_crop_plan.py` |
| 高光快剪 | `adobe-edit-quick-cut/scripts/quickcut_plan.py` |
| PS 动作、智能对象、画板导出 | `adobe-desktop-scripting/scripts/run_jsx.sh` + `.jsx` |
| 生成、扩图、去背景 | miniQ 原生 `generate_image` / `edit_image` |
