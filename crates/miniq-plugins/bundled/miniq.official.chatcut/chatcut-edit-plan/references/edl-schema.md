# EDL 字段与剪辑节奏

## 字段
```
output      输出路径（相对 JSON 所在目录），默认 out/final.mp4
canvas      width/height 必须为偶数；fps 默认 30；fit = blur（模糊补边）| pad（黑边）| crop（居中裁切）
clips[]     按顺序拼接
  视频片段  src, in, out（秒）, speed(0.25–4, 默认 1), fade{in,out}(秒), mute(bool), note(备注，不参与渲染)
  图片片段  image, duration(秒), fade{in,out}, note
music       src, volume_db（默认 -18）。音乐会自动循环补足，结尾 2 秒淡出
subtitles   SRT 路径。时间轴以“成片”为准，不是原素材的时间轴
loudness    目标 LUFS（如 -14）。省略则不做响度标准化
```
片段时长 = (out − in) / speed。总时长是各片段时长之和，片段之间没有重叠转场。需要交叉转场时，先渲染成片，再按 `chatcut-ffmpeg-edit/references/ffmpeg-recipes.md` 用 xfade 处理。

## 成片字幕的做法
1. 先渲染不带 `subtitles` 的版本。
2. 对成片做转写和对齐（见 `chatcut-subtitles`），得到以成片为时间轴的 SRT。
3. 在 `edit.json` 里填入 `subtitles`，再加 `--overwrite` 重新渲染。
   或者直接对成片运行 `cutkit.sh subtitle`，这样更快。

## 默认值
- 竖屏短视频：1080x1920、30fps、fit=blur（素材是竖屏时用 crop）、loudness -14、音乐 -18dB（没有人声时 -8dB）。
- 横屏：1920x1080、fit=pad。
- 图片片段：每张 2–3 秒，首尾 0.3 秒淡入淡出。
- 开头片段不加淡入，钩子要第一帧就出现。

## 节奏经验
- 前 3 秒决定完播率：开头放最有冲击力的画面或一句结论，不要用 logo 片头开场。
- 镜头时长：信息类 2–4 秒一刀；情绪类可以到 5–6 秒；卡点视频按音乐 BPM 算，一拍 = 60/BPM 秒，每 2 或 4 拍切一刀。
- 口播精剪：删掉重复和口误的句子，保留完整的意群，切点落在句尾停顿处。
- 结尾 2–3 秒放行动号召或结尾卡，音乐淡出。

## 常用结构
- 产品宣传 30s：痛点(3s) → 产品亮相(4s) → 3 个卖点×5s → 使用场景(5s) → 结尾卡(3s)。
- 图文成片：标题卡 → 每张图 2.5s → 结尾卡；配音乐。有旁白时按旁白段落长度分配图片时长。
- 访谈精选：金句钩子(5s) → 3–5 段回答 → 收尾金句。
