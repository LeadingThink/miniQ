---
name: adobe-create-social-variations
description: 当用户想把一张主图或一段视频一次性导出为 Instagram、抖音/TikTok、小红书、LinkedIn、X、YouTube 等多平台尺寸套装时使用；图片可用 AI 扩图或智能重构图，视频做同比例缩放，并提供本地裁切计划脚本。
version: 1
---

# 社媒多尺寸套装（Adobe）

## 触发场景
- “这张海报帮我出 Instagram、小红书、LinkedIn 各尺寸”“把横版主视觉改成竖版故事图”。
- 视频要导出 1080×1920 / 720×1280 等同比例尺寸。
- 需要新做设计请用 `adobe-design-from-template`；统一调色请用 `adobe-batch-edit-photos`。

## 前置条件
- MCP：`adobe-creativity` 已连接并登录（见 `adobe-creativity-cloud`），调用方式为 `mcp_call {"server":"adobe-creativity","tool":"...","arguments":{...}}`。
- **工具名以 `tools/list` 为准**。常见名称：
  - `image_generative_expand`（AI 扩图，生成式）
  - `image_crop_and_resize`（`fit:"reframe"` 智能重构图）
  - `video_resize` + `resizeVideoPoll`（视频缩放与轮询）
  - `asset_preview_file`
  - 上传用 `asset_initialize_file_upload` / `asset_finalize_file_upload`
- 支持的输入：JPG、PNG、Firefly 图片、PSD/AI（需先拼合为 JPEG）、MP4/MOV。Express 文件、DOCX、PDF 需要用户先导出为图片。
- 本地回退：`scripts/social_crop_plan.py`（纯标准库，计算裁切框并生成 ffmpeg 命令）。

## 分步流程（图片）
1. **初始化**：先 `tools/list`；若有 `adobe_mandatory_init`，传 `{"skill_name":"adobe-create-social-variations","skill_version":"1"}`。
2. **上传**得到 `sourceURI`（需征得同意），并记录原图宽高与方向。
3. **选平台**：`ask_user` 多选平台（尺寸见 `references/social-sizes.md`），并提供两种模式：
   - **全套**：先出 3 张测试图，确认后再出其余。
   - **快速**：直接全部生成。
   选了 Snapchat 时要提前提醒：文件需压到 250 KB，画质会下降。
4. **焦点分析**：用 `view_image` 看原图，记下主体位置、文字/logo 区域，决定扩图方向和构图对齐方式，保证文字不被裁掉。
5. **准备画布**（都从原图出发，**不要在扩图结果上再扩图**）：
   - 竖版画布 `tallURI`：`image_generative_expand {imageURI:sourceURI, options:{top:960, bottom:960}}`；横构图原图可用 2000。
   - 横版画布 `wideURI`：`image_generative_expand {imageURI:sourceURI, options:{left:960, right:960}}`；横构图原图可用 1500。
   - 1:1 直接从原图裁切。
   - 扩图返回 403：改为从 `sourceURI` 调用 `image_crop_and_resize {fit:"reframe"}`，并在交付中注明。
6. **测试预览**（仅全套模式）：1080×1080（原图）、1080×1350（tall）、1200×627（wide）三张，展示后请用户确认。
7. **逐尺寸导出**：
   - `image_crop_and_resize {imageURI:<对应画布>, options:{output:{width:W,height:H}, fit:"reframe", focus:"subject"}, outputFileType:"jpeg", quality:<参考表>}`。
   - 尺寸完全相同时复用测试图。
   - 文件命名：`<原名>_<平台>_<用途>_<比例>.jpg`，例如 `hero_instagram_story_9x16.jpg`。
8. **预览与交付**：用 `asset_preview_file` 展示，或 `curl -L -o adobe/out/social/<文件名>` 下载后用 `view_image` 抽查。部分失败时照常交付成功的部分。

## 分步流程（视频）
1. 上传得到 `assetId`（视频工具不接受 URL 或本地路径）。
2. 判断源比例（手机竖拍 9:16 / 方形 1:1 / 录屏或相机 16:9；不确定时按 1:1 处理）。
3. **只推荐同比例尺寸**（见参考表）。跨比例（如 16:9 → 9:16）会产生黑边，且在短视频平台会被降权；如用户坚持，说明风险，并建议本地居中裁切（本地脚本 `--video`）。
4. 每个尺寸调用 `video_resize {assetId, width, height}` 得到 `statusId`，再用 `resizeVideoPoll` 轮询。慢时先轮询 3–4 次再告知用户进度。
5. 预览、下载，并用 `ffprobe` 核对分辨率。

## 本地回退
```bash
python3 scripts/social_crop_plan.py --width 3000 --height 2000 --platforms instagram,xiaohongshu,linkedin \
  --focus 0.5,0.4 --input hero.jpg --outdir adobe/out/social        # 打印裁切框与 ffmpeg 命令
python3 scripts/social_crop_plan.py --list                            # 列出全部预设尺寸
```
- `--focus` 是主体中心的相对坐标（0–1），可以根据 `view_image` 的观察来估计。
- 本地回退只能裁切和缩放，不能 AI 扩图。比例差异大时会裁掉较多内容，脚本会给出“裁掉比例”警告。

## 质量检查与失败回退
- 逐张检查：主体和文字是否完整、有无扩图接缝或伪影、分辨率是否完全等于目标。Snapchat 文件需 ≤250 KB。
- 失败处理：
  - 扩图 403：改用智能重构图。
  - 裁切 403：停止，说明套餐限制，并提供本地回退。
  - PSD 拼合 403：请用户先导出 JPG/PNG。
  - 文件过大：降低 quality 重新导出。
  - `.ffgenimg` 扩图失败：改用 rendition URL 重试。
  - 401：请用户重新登录。
  - 视频缩放失败：建议转为 MP4 后重新上传。

## 输出交付格式
```
✅ 社媒套装完成（<N> 个尺寸）
| 平台 | 用途 | 尺寸 | 状态 | 文件 |
| Instagram | 动态竖图 | 1080×1350 | ✅（测试图复用） | adobe/out/social/hero_instagram_feed_4x5.jpg |
| LinkedIn | 横图 | 1200×627 | ✅ | … |
⚠️ AI 扩图不在当前套餐内，已改用智能重构图。   ← 仅在发生回退时显示
```
