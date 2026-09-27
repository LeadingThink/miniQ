# 视频与音频素材（motion-audio）

## 视频
- 优先图生视频：`generate_video` 的 `image_path` 用已选定并通过质检的关键图；`prompt` 只写动作与运镜（如“镜头缓慢推近，蒸汽上升”），不重复描述画面。
- `aspect_ratio`：竖版信息流 / 故事 9:16，横版 16:9，方形 1:1；`duration` 按渠道（信息流 6–15 秒）。
- 任务异步：记录返回的任务 id 与状态 URL，完成前不要重复提交。完成后保存到 `creative/video/<id>.mp4`，并 `board.py complete --id <id> --image <mp4 绝对路径>` 登记。
- 核验：
  ```bash
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of json creative/video/x.mp4
  ffmpeg -v error -ss 1 -i creative/video/x.mp4 -frames:v 1 creative/video/x-frame.png
  ```
  抽帧后 `view_image` 检查主体是否走样、有无伪文字。无 ffmpeg 时说明未做本地核验。
- 字幕与文字：同样后期叠加（ffmpeg `drawtext` / `subtitles`，或交给剪辑类技能），不让视频模型生成文字。

## 配音
- `synthesize_speech`：输入 `creative/copy.md` 中确认过的口播稿；声音与品牌语气匹配。
- 核验：`transcribe_audio` 转写后与稿件逐句比对；`ffprobe` 看时长是否符合要求。

## 配乐
- `generate_music`：`instrumental: true`，提示词写清情绪、BPM、时长、乐器与结构（如“前 2 秒铺垫，第 3 秒进入主旋律”）。
- 裁时长 / 淡出：`ffmpeg -i in.mp3 -t 15 -af afade=t=out:st=13:d=2 out.mp3`。
- 不模仿具体在世艺人或受版权保护的曲目。

## 合成
- 视频 + 配音 + 配乐：`ffmpeg -i v.mp4 -i vo.mp3 -i bgm.mp3 -filter_complex "[2:a]volume=0.25[b];[1:a][b]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -shortest out.mp4`
- 输出后用 `ffprobe` 确认有一条视频流和一条音频流。
