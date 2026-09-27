# 用 AI 生成补充素材

原则：只在用户需要或同意时生成；交付时标注哪些素材是 AI 生成的；不冒充真人的声音或肖像，不生成误导性的“实拍”画面（比如虚构的产品效果、虚构的用户证言）。

## 配乐 generate_music
- 设 `instrumental=true`。prompt 写清：风格（lo-fi / 电子 / 钢琴 / 轻快流行）、情绪、BPM、时长（比成片长 5–10 秒）、“无人声、适合做背景”。
- 返回的是异步片段 id，按工具提示轮询到完成，并下载到 `assets/bgm.mp3`。
- 检查：用 `ffprobe` 看时长，前 10 秒要听得出节奏。
- 版权：用户自带的音乐需要自己确认授权；平台热门曲目建议上传时在平台内添加。

## 旁白 synthesize_speech
- 旁白稿按每段 1–3 句拆开，逐段生成 `assets/vo-01.mp3` 等文件。这样每段可以单独放置，改稿时只需重做一段。
- 中文口播语速约 4–5 字/秒，据此估算每段时长，再反推镜头时长。
- 用 `ffprobe` 拿到每段的实际时长，回填到镜头表。

## 旁白混音
渲染成片 `out/final.mp4` 后，用 `shell_run` 执行：
```
ffmpeg -i out/final.mp4 -i assets/vo-01.mp3 -i assets/vo-02.mp3 -filter_complex \
 "[1:a]adelay=500|500[v1];[2:a]adelay=6200|6200[v2];[v1][v2]amix=inputs=2:normalize=0[vo];\
  [vo]asplit[vo1][vo2];[0:a][vo1]sidechaincompress=threshold=0.03:ratio=8:release=300[duck];\
  [duck][vo2]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5[a]" \
 -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k out/final-vo.mp4
```
- adelay 的单位是毫秒，填各段旁白的起始时间。sidechaincompress 会在旁白响起时自动压低原声和音乐。
- 只有一段旁白时，去掉第二个输入，并把 `amix=inputs=2` 改为直接使用 `[1:a]adelay=...[vo]`。

## 画面 generate_image / edit_image / generate_video
- 结尾卡、标题卡、空镜的尺寸要与画布一致（竖屏 1080x1920），写进 prompt，并说明文字要留白，或文字另外叠加。
- 画面中需要精确文字（价格、品牌名）时，优先让 AI 生成无字底图，再用 ffmpeg 的 `drawtext` 或 `edit_image` 加字，并用 `view_image` 逐字核对。
- `generate_video` 只用来补 3–6 秒的空镜。它是异步任务：记录任务 id 并轮询，不要重复提交。生成结果先用 `cutkit.sh probe` 和 `frames` 检查，再放进计划。
- 所有生成的图片都要先用 `view_image` 看过再使用。
