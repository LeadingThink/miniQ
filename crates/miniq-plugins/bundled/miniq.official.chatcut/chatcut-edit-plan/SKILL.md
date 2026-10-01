---
name: chatcut-edit-plan
displayName: 剪辑计划成片（EDL）
description: 把多段素材、图片和 AI 生成的配音配乐编排成一条完整短视频时使用。先写 JSON 剪辑计划（EDL），校验后用一条 ffmpeg 命令渲染：统一画幅、变速、淡入淡出、配乐、字幕、响度。适合产品宣传、口播精剪、图文成片。
version: 1
---

# 剪辑计划成片（EDL）

## 触发场景
- “用这几段素材剪一条 30 秒的宣传片”“把这些照片做成带音乐的视频”“按这个脚本出片”“剪一版竖屏、一版横屏”。
- 需要反复调整顺序、入点和出点的多素材剪辑。改 JSON 后重新渲染，比逐步串联 ffmpeg 命令更稳定，也便于复现。

## 前置条件
- 需要 ffmpeg、ffprobe、python3。脚本位置：`scripts/edl_render.py`（template/validate/render）。
- 计划字段、镜头节奏和脚本结构见 `references/edl-schema.md`；AI 素材的生成要点见 `references/generated-assets.md`。
- 素材路径以 JSON 文件所在目录为基准解析。建议建一个项目目录，例如 `cut-<主题>/`，把 `raw/`、`assets/`、`edit.json`、`out/` 都放在里面。

## 分步流程
1. **定需求**：确认成片时长、画幅、平台、调性、是否需要配音、音乐和字幕。缺少关键信息时用 `ask_user` 一次问清，最多 3 个问题；其余按 `references/edl-schema.md` 的默认值处理。
2. **看素材**：对每段视频运行 `cutkit.sh probe`、`frames`、`scenes`，用 `view_image` 浏览抽出的帧，记下可用片段的时间点（好的镜头、表情、产品特写）。有口播时先转写（见 `chatcut-subtitles`），再按语义挑选句子。
3. **写脚本和分镜**：按“钩子(0–3s) → 主体 → 收尾/行动号召”的结构，列出每个镜头的来源、入点、出点和作用。先给用户看这张表，确认后再渲染。短任务或者用户说“直接做”时可以跳过确认。
4. **补齐缺失素材**（可选，按需使用，并如实告诉用户哪些素材是 AI 生成的）：
   - 配乐：`generate_music`（instrumental=true，prompt 写风格、BPM、情绪、时长）。
   - 配音：`synthesize_speech`（input 填旁白稿，按段落分别生成，方便对齐）。
   - 空镜、封面、结尾卡：`generate_image`。需要在已有图片上改字或换背景时用 `edit_image`。
   - 动态空镜：`generate_video`（只生成少量几秒的短镜头；这是异步任务，要记录任务 id，不要重复提交）。
5. **生成计划**：运行 `python3 edl_render.py template > edit.json` 拿到模板，再用 `file_write` 或 `file_edit` 填写内容。
6. **校验**：运行 `python3 edl_render.py validate edit.json`，它会检查文件是否存在、入点和出点是否越界、画布尺寸是否为偶数，并打印每个镜头的时长和预计总时长。总时长偏离目标时，调整入点、出点或变速后重新校验。
7. **渲染**：运行 `python3 edl_render.py render edit.json`，用 `shell_run` 执行，`timeoutSecs` 设为 600。输出文件已存在时，需要用户确认后才加 `--overwrite`。只想看将要执行的命令时加 `--dry-run`。
8. **配音混音**（有旁白时）：见 `references/generated-assets.md` 的“旁白混音”一节。用 adelay 把每段旁白放到指定时间点，原声和音乐做 ducking（压低）。
9. **多版本**：复制一份 `edit.json` 为 `edit-16x9.json`，改 canvas 和 output 后重新渲染。

## 质量检查
- 渲染脚本会自动比对实际时长和预期时长，误差需在 ±0.5 秒以内，超出时会警告。
- 运行 `cutkit.sh check out/final.mp4`，确认没有黑场，也没有意外的长静音。
- 抽帧检查：在每个剪辑点前后 0.2 秒以及首帧、尾帧抽帧，用 `view_image` 查看是否有黑帧、跳帧，画幅适配是否裁掉主体，字幕和结尾卡文字是否正确。
- 听感：运行 `ffmpeg -i out/final.mp4 -af ebur128 -f null -` 查看整体响度，应接近目标值 -14 LUFS。

## 失败回退
- validate 报错时，按提示逐项修正（路径、时间、尺寸），不要跳过校验直接渲染。
- 渲染失败时，先用 `--dry-run` 拿到完整命令，并读 ffmpeg stderr 的最后 20 行。常见原因是字幕路径含特殊字符（复制到一个简单路径即可）或图片尺寸为奇数（脚本已做缩放，但仍需检查原图是否损坏）。
- 缺少 libass 时，从计划中去掉 `subtitles`，渲染后改为封装软字幕。
- 生成类工具失败或额度不足时，不要编造素材。改用纯色卡或用户提供的素材，并告诉用户缺了什么。
- 渲染太慢时，先把 canvas 改成 540x960 出一版小样确认节奏，再渲染全尺寸。

## 交付格式
- 交付物：成片路径、时长、分辨率、大小；`edit.json` 路径（方便以后改版）；镜头表（序号、来源、时间、作用）；标注哪些素材是 AI 生成的。
- 如实写出质检发现。
- 最后只给一个下一步建议，例如“要不要再出一版 16:9？”
