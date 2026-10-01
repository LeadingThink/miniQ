---
name: adobe-batch-edit-photos
displayName: 批量统一调色（Adobe）
description: 当用户想把一组照片调成统一风格（如暖调、电影感、清新、胶片感），或批量拉直、自动影调、统一裁切比例时使用；优先调用 Adobe 云端图像工具，不可用时回退本机 ffmpeg 或 Photoshop 脚本。
version: 1
---

# 批量统一调色（Adobe）

## 触发场景
- “把这 20 张旅行照调成同一种暖色调”“这批产品图统一亮一点、裁成 4:5”。
- 用户给出一个文件夹或多张图片，希望输出风格一致的一整套照片。
- 单张人像精修请改用 `adobe-retouch-portraits`；改社媒尺寸请用 `adobe-create-social-variations`。

## 前置条件
- MCP：`adobe-creativity` 已连接且已登录（连接探测、登录与 401/403 处理见 `adobe-creativity-cloud`）。
- 调用方式：`mcp_call {"server":"adobe-creativity","tool":"<工具名>","arguments":{...}}`。
- **工具名以连接器 `tools/list` 实际返回为准**。下文名称来自 Adobe 公开能力，名称不同就按语义匹配，完全缺失则走回退。
- 本地回退需要 `ffmpeg`（`shell_run` 执行 `ffmpeg -version` 检查），或本机 Photoshop（见 `adobe-desktop-scripting`）。
- 说明：Adobe 为 ChatGPT 提供的同类能力走专有 App 连接器（`.app.json`），miniQ 无法使用，只能通过上面的 MCP 服务器。

## 分步流程
1. **初始化**：先 `tools/list`；若存在 `adobe_mandatory_init`，调用 `{"skill_name":"adobe-batch-edit-photos","skill_version":"1"}`。返回中的文件规则、egress（外传）状态和 `importantNote` 必须遵守。
2. **预设目录**：调用 `image_list_presets {}`，按名称关键词给 7 种风格（见 `references/looks-and-tweaks.md`）各挑最多 2 个预设（主、次），每个预设只归入一种风格，`Adaptive:` 前缀优先。结果为空或 403 时跳过预设，不阻塞流程。
3. **导入图片**：
   - 有选择器组件：`asset_add_file {}` 返回空列表属正常，用户选完后用 `read_widget_context` 取回预签名 URL。
   - miniQ 常见情况（无组件）：egress 开启时，对每个本地文件依次 `asset_initialize_file_upload {path, media_type}` → 按返回地址 PUT 字节 → `asset_finalize_file_upload {filename, transfer_document}`。
   - **图像工具绝不接受本地路径**。上传前用 `ask_user` 确认“这些文件将上传到 Adobe 云端”。
4. **收集偏好**：先从对话推断，只问缺的项（`ask_user`，最多 5 问）：风格（单选）、微调（多选）、裁切比例（不裁 / 1:1 / 4:5 / 16:9 / 4:3）、构图方式（居中 / 智能，只有要裁切时才问，未说明默认智能）、是否做分区 AI 增强。复述确认“将按以下设置执行：…”。
5. **耗时提示**：超过 5 张时告知预计耗时（6–10 张约 3–5 分钟，11–20 张约 5–10 分钟，更多 10 分钟以上）。
6. **样张闸门（必做）**：
   - 先把第 1 张缩小：`image_crop_and_resize {imageURI, options:{output:{width:1200,height:1200}, fit:"contain"}, outputFileType:"jpeg"}`。
   - 对缩小图跑完第 7–11 步全流程。
   - 用 `asset_preview_file` 展示原图/效果；无组件时 `curl -L -o` 下载到 `adobe/out/preview/`，再用 `view_image` 自查后给用户看。
   - `ask_user`：确认全部执行 / 调整后重新预览 / 取消。样张不计入最终交付。
7. **拉直**：`image_auto_straighten {imageURIs:[...], options:{uprightMode:"auto", constrainCrop:true}}`。失败就用原图并记录。
8. **自动影调**：`image_apply_auto_tone {imageURIs:[...], options:{type:"cameraRawFilter"}, outputFileType:"jpeg"}`。
9. **风格**：
   - 一次 `image_apply_adjustments` 批量传入所有图，全部用同一组参数（数值见参考表）。色温三参数 `tempA/tempB/tempLuminance` 要么同时给，要么都不给。
   - 如有预设，再逐张 `image_apply_preset {imageURI, options:{presetName}}`，先主后次链式应用。
10. **分区增强（可选）**：`image_select_subject {imageURI, options:{bodyParts:["Face","Torso","Clothing","Skin","Hair","Sky","Background"]}}`，按检测到的区域依次套用 人物 → 身体/衣物 → 天空 → 背景 预设。检测失败就跳过。
11. **微调**：只把用户选的增量合并进一次 `image_apply_adjustments`；背景虚化单独调用 `image_apply_gaussian_blur {blurRadius:12, blurTarget:"background"}`。
12. **裁切**：`image_crop_and_resize {options:{output:"4:5", fit:"reframe", focus:"face"|"subject"}}`；居中裁切改传 `align:{x:0.5,y:0.5}`。
13. **交付**：见下文。可调用 `create_firefly_board {import_adobe_storage:[urls]}` 取得看板链接；失败只注明“Firefly 看板不可用”，不重试。

所有工具输出都从 `results[i].outputUrl` 读取；`success:false` 按失败处理。

## 本地回退（MCP 不可用、未登录或用户拒绝上传）
- **ffmpeg**：先生成命令，确认后执行。
  ```bash
  python3 scripts/local_batch_grade.py --input <目录> --output adobe/out/batch --look warm --crop 4:5
  ```
  默认只打印命令，确认后加 `--run` 执行；`--help` 查看全部风格和参数。
- **Photoshop**：若用户有现成动作，用 `adobe-desktop-scripting` 的 `ps_batch_export.jsx` 播放动作并导出。
- 本地回退没有 AI 拉直、主体识别和自适应预设，交付时需说明。

## 质量检查与失败回退
- 所有图片都必须处理；单张失败记录一次后继续，最后在汇总中列出，不静默丢弃。
- 抽查 2–3 张成品（`view_image`），重点看：肤色是否偏色、高光是否过曝、裁切有没有切掉人脸。
- 批次内拍摄条件差异很大（室内/室外混合）时，提示用户分组处理效果更好。
- 错误码：
  - 401：请用户重新登录。
  - 预设 403：跳过该预设，注明“当前套餐不含”。
  - 裁切失败：用上一步结果作为成品。
  - 整张全失败：返回原图并标红说明。

## 输出交付格式
```
✅ 已完成 N 张，统一风格：<风格名>
流程：拉直 → 自动影调 → <风格参数/预设> → <微调> → 裁切 <比例>
下载：
- 01_xxx.jpg → <URL 或 adobe/out/batch/01_xxx.jpg>
Firefly 看板：<board_url 或“不可用”>
跳过/失败：<清单或“无”>
```
提醒用户：云端链接是临时的，需要长期保存请下载。
