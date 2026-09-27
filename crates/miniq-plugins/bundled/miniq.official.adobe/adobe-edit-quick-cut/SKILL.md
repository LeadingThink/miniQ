---
name: adobe-edit-quick-cut
description: 当用户想把一段较长的视频自动剪成 15 秒、30–60 秒或 90 秒左右的高光集锦/短视频（节奏快剪、口播要点、电影感）时使用；优先用 Adobe Quick Cut，不可用时用本机 ffmpeg 按节奏规则拼接。
version: 1
---

# 视频快剪高光集锦（Adobe Quick Cut）

## 触发场景
- “把这段 10 分钟的活动视频剪成 30 秒精彩片段”“做个 15 秒抖音预告”。
- 从访谈、Vlog、运动视频中自动挑选高光片段。
- 只需要改视频尺寸请用 `adobe-create-social-variations`（视频分支）。

## 前置条件
- MCP：`adobe-creativity` 已连接并登录（见 `adobe-creativity-cloud`），调用方式为 `mcp_call {"server":"adobe-creativity","tool":"...","arguments":{...}}`。
- **工具名以 `tools/list` 为准**。常见名称：
  - `video_create_quick_cut`（发起剪辑）
  - `quickCutPoll`（轮询；可能是延迟加载的工具，需先确认已列出）
  - `asset_preview_file`
  - 上传用 `asset_initialize_file_upload` / `asset_finalize_file_upload`
- 视频工具只接受 Creative Cloud 的 `assetId`，**不接受本地路径或普通 URL**。本地文件先上传，上传前需征得用户同意。
- 本地回退需要 `ffmpeg` / `ffprobe`，并使用 `scripts/quickcut_plan.py`。

## 分步流程
1. **初始化**：先 `tools/list`；若有 `adobe_mandatory_init`，传 `{"skill_name":"adobe-edit-quick-cut","skill_version":"1"}`，确认 egress 状态。
2. **获取视频**：上传后拿到 `assetId`；检查 `mediaType`，如果用户传的是图片，要提示“需要视频文件”。
3. **提问（能推断就跳过）**，一次 `ask_user` 问完：
   - 时长：短（约 15 秒，`target_duration:15`）/ 中（30–60 秒，`45`）/ 长（约 90 秒，`90`）
   - 风格：高能快节奏 / 口播要点 / 电影叙事 / 不限（平衡）
   风格对结果的影响比时长更大，要映射成 `references/pacing-rules.md` 中的 `user_prompt`。
4. **并行生成 3 个变体**：参数完全相同，发起 3 次 `video_create_quick_cut {assetIds:[assetId], target_duration, user_prompt}`，靠模型随机性得到不同剪法。每次返回一个 `statusId`。
5. **轮询**：对每个变体调用 `quickCutPoll {statusId}`，间隔几秒，直到 `jobStatus:"completed"`（通常 3–5 轮），然后取出 `presignedAssetUrl`。超过 5 轮没有进展时告知用户，并建议重新上传或缩短素材。
6. **预览**：
   - 有组件：`asset_preview_file {assets:[{name, presignedAssetUrl}], source:"acp"}`。
   - 无组件：`curl -L -o adobe/out/quickcut/variant_<n>.mp4 <URL>`，再用 `ffprobe` 报告实际时长。
7. **让用户挑选**：展示变体表格，说明实际时长与目标时长可能有偏差，询问要保留哪个。
8. **后续处理**：输出的是临时 URL，不是 CC 资产。如需继续改尺寸或增强人声，要先下载再重新上传。

## 本地回退（Quick Cut 不可用 / 403 / 用户不愿上传）
1. `ffprobe` 获取总时长；如果能拿到场景切点更好：`ffmpeg -i in.mp4 -vf "select='gt(scene,0.35)',showinfo" -f null - 2>&1 | grep pts_time`。
2. 生成剪辑计划和命令：
   ```bash
   python3 scripts/quickcut_plan.py --input in.mp4 --duration 612.4 --target 30 --style energy --output adobe/out/quickcut/cut.mp4
   ```
   - 可选参数：`--scenes 12.1,40.2,...` 传入场景切点；`--vertical` 输出 9:16。
   - 默认只打印命令，确认后再加 `--run`。
3. 告知用户：本地回退按节奏规则均匀取片段，不理解画面和对白语义，只是“粗剪初稿”。

## 质量检查与失败回退
- 用 `ffprobe` 确认时长和分辨率；抽几帧检查（`ffmpeg -ss <t> -frames:v 1 x.jpg` 后用 `view_image` 查看），确认没有黑帧、没有停在半句话。
- 错误处理：
  - 403：套餐不含该功能，不要重试；改走本地回退，或建议使用 Premiere Rush/Pro。
  - 401：请用户重新登录。
  - `StoryBuilderNoARoll`：素材里没有人说话的主画面（只有空镜），重试也没用，改用高能风格或本地回退。
  - 其他错误：重试一次。
  - 部分变体失败：交付成功的变体，并注明失败的。
- 能力边界：不能按指定台词剪，不能指定时间戳，不理解对白含义。

## 输出交付格式
```
✅ 已生成 3 个快剪版本（目标 30 秒，风格：高能快节奏）
| 变体 | 风格 | 目标时长 | 实际时长 | 状态 | 文件/链接 |
| A | 高能 | 30s | 32.4s | ✅ | adobe/out/quickcut/variant_1.mp4 |
| B | 高能 | 30s | — | ❌ 失败 | — |
实际时长会与目标略有偏差。要保留哪一个？需要改成竖屏或其他尺寸吗？
```
