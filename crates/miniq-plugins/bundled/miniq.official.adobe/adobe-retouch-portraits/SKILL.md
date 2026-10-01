---
name: adobe-retouch-portraits
displayName: 批量人像精修（Adobe）
description: 当用户想批量精修一组人像/证件照/活动合影（拉直、影调、提亮肤色、美白牙齿、背景虚化、按人脸裁切）时使用；默认非生成式，调用 Adobe 云端图像工具，不可用时回退本机脚本。
version: 1
---

# 批量人像精修（Adobe）

## 触发场景
- “帮我把这个文件夹的人像都修一下”“团队头像统一修成 1:1、背景虚化”。
- 活动跟拍、婚礼、证件照、电商模特图的批量修饰。
- 非人像的统一调色请用 `adobe-batch-edit-photos`。

## 前置条件
- MCP：`adobe-creativity` 已连接并登录（见 `adobe-creativity-cloud`）。调用方式为 `mcp_call {"server":"adobe-creativity","tool":"...","arguments":{...}}`。
- **工具名以 `tools/list` 实际返回为准**。常见名称：`image_list_presets`、`image_auto_straighten`、`image_apply_auto_tone`、`image_apply_adjustments`、`image_select_subject`、`image_apply_preset`、`image_apply_lens_blur`、`image_apply_gaussian_blur`、`image_crop_and_resize`、`asset_preview_file`、`create_firefly_board`，上传用 `asset_initialize_file_upload` / `asset_finalize_file_upload`。
- **原则：非生成式。** 面部、皮肤、头发、身体、衣物一律不做生成式修改（不换脸、不瘦身、不生成填充）。`image_fill_area` 之类的生成式填充仅可用于背景中的灰尘、划痕等微小瑕疵，而且必须先征得同意。
- 本地回退需要 Photoshop（`adobe-desktop-scripting`）或 `ffmpeg`。

## 分步流程
1. **初始化**：先 `tools/list`；若有 `adobe_mandatory_init`，传 `{"skill_name":"adobe-retouch-portraits","skill_version":"1"}`，并遵守返回的 egress 状态和注意事项。
2. **建立预设方案**：调用 `image_list_presets {}`，按 `references/retouch-params.md` 分 4 个桶挑选：
   - 人物自适应：1–3 个，含美白牙齿
   - 氛围/影调：1 个
   - 风格/Look：1 个
   - 背景虚化：1 个
   无合适预设就留空。整体为空或 403 时跳过第 9 步，并注明“当前套餐无自适应预设”。
3. **导入**：与批量调色相同。miniQ 默认走 `asset_initialize_file_upload` → PUT → `asset_finalize_file_upload`；上传前用 `ask_user` 确认。绝不把本地路径传给图像工具。
4. **收集偏好**（能推断的就不问，`ask_user` 一次问完）：
   - 氛围：自然干净 / 暖调通透 / 暗调戏剧 / 明亮清新 / 电影感 / 浓郁鲜明
   - 自适应增强（多选）：全部 / 人物增强 / 氛围影调 / 风格 / 背景虚化 / 美白牙齿 / 不用。**默认不开启。**
   - 手动微调（多选）：压高光 / 提暗部 / 加对比 / 加鲜艳度 / 降饱和 / 景深虚化 / 强虚化 / 不用
   - 裁切：自动（横图 4:3、竖图 3:4）/ 1:1 / 4:5 / 16:9
5. **复述方案**：列出氛围、已选预设名、微调、裁切、虚化方式；超过 5 张时附上耗时估计。
6. **样张闸门（必做，每次调整设置后都要重做）**：
   - 第 1 张先用 `image_crop_and_resize {output:{width:1200,height:1200}, fit:"contain"}` 缩小，跑完第 7–12 步。
   - 展示原图/效果（`asset_preview_file`，或下载后 `view_image`）。
   - `ask_user`：全部执行 / 调整 / 取消。全量处理时从原始全分辨率图重新开始，不复用样张。
7. **拉直**（逐张）：`image_auto_straighten {imageURIs:[uri], options:{uprightMode:"auto", constrainCrop:true}}`。
8. **影调**：
   - 逐张 `image_apply_auto_tone {imageURIs:[uri], options:{type:"cameraRawFilter"}}`。
   - 微调合并为一次 `image_apply_adjustments`，数值按照片严重程度在参考区间内取**单个数值**。
9. **自适应增强（仅用户选择时）**：
   - 先 `image_select_subject {imageURI, options:{bodyParts:["Face","Torso","Clothing","Skin","Hair"]}}`：没检测到脸就不美白牙齿；没有身体就跳过身体/衣物预设；什么都没检测到则只套氛围和风格预设。
   - 按 人物 → 氛围 → 风格 → 背景虚化 的顺序链式调用 `image_apply_preset {imageURI, options:{presetName}}`。
10. **虚化**：已套用背景虚化预设就跳过这一步。
    - 标准：`image_apply_lens_blur {imageURI, options:{blurRadius:8}}`，景深感知，优先使用。
    - 强虚化：`image_apply_gaussian_blur {imageURIs:[uri], options:{blurRadius:12, blurTarget:"background"}}`，仅在用户明确要求时使用。
11. **裁切**：`image_crop_and_resize {imageURI, options:{output:"4:3"|"3:4"|用户比例, fit:"reframe", focus:"face"}, outputFileType:"jpeg"}`；检测不到人脸时改用 `focus:"subject"`。
12. **交付**：`asset_preview_file` 直接使用最终 URL，不要再缩放；可选 `create_firefly_board`。

## 本地回退
- **Photoshop**：用户有“人像精修”动作时，执行 `bash ../adobe-desktop-scripting/scripts/run_jsx.sh photoshop ../adobe-desktop-scripting/scripts/ps_batch_export.jsx input=... output=... actionSet=... action=...`。
- **ffmpeg**：只能做整体影调和居中裁切，没有人脸识别和自适应预设。可借用 `python3 ../adobe-batch-edit-photos/scripts/local_batch_grade.py --look airy --tweak shadows --crop 4:5`，并告知用户这是降级处理。

## 质量检查与失败回退
- 用 `view_image` 抽查：肤色不偏橙/偏灰；牙齿不能过白发蓝；虚化边缘不能吃掉发丝；裁切不能切到下巴或头顶。
- 人像提色优先用 `vibrance`，少用 `saturation`，以保护肤色。
- 失败处理：
  - 拉直失败：用原图。
  - 影调失败：沿用上一步结果。
  - 主体检测失败：跳过需要检测的预设。
  - 预设 403：跳过并注明套餐不含。
  - 景深虚化失败：改用高斯 `blurRadius:8`。
  - 裁切失败：用上一步结果。
  - 401：请用户重新登录。
- 每张都要有结果；全部失败的返回原图并标明。批次内光线条件差异大时提醒用户分组。

## 输出交付格式
```
✅ 已精修 N 张人像
流程：拉直 → 自动影调 → <微调> → <自适应预设名> → <虚化> → 裁切 <比例，focus=face>
下载：
- portrait_01.jpg → <URL 或本地路径>
Firefly 看板：<链接或“不可用”>
跳过项：<如“Whiten Teeth 未检测到人脸已跳过”>
```
