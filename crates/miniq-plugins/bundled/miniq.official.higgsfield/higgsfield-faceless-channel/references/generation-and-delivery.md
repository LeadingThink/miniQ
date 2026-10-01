# 生成与交付

## 批量生成约定
- 每个批量调用 ≤6 个任务；同类任务（素材、视频块、旁白）分组提交，提交后用等待工具（如 `jobs_wait`）按 `{index, job_id}` 等待。
- 结果按 `index` 写回对应编号文件，**绝不按完成顺序排序**。
- 记录台账 `work/jobs.json`：编号、类型、job_id、状态、重试次数、积分（如返回）。
- 连接器返回“推荐预设”而非任务时：用同样参数加 `declined_preset_id` 重提，不算失败。
- 每个视频调用显式带 `aspect_ratio`；图片素材按类型用 2:3 / 画幅 / 1:1。

## 下载与本地校验
- 结果 URL 可能有时效，完成后立即下载到 `work/blocks/blockNN.mp4` 等。
- `ffprobe` 检查：视频流存在、分辨率与画幅一致、时长 ≈10 秒。
- 首帧静止检查：`ffmpeg -i blockNN.mp4 -vf "select='lt(t,1)',freezedetect=n=0.003:d=0.8" -f null -` 若报告 freeze_start=0，说明开头卡住，可裁掉静止段后按剩余时长居中放置，或重生成。

## 合成（固定时长）
推荐流程（每块独立对齐，再拼接）：
```bash
# 每块：视频 10s + 本块旁白居中；旁白过短则两侧补静音
ffmpeg -y -i blocks/block01.mp4 -i voices/voice01.wav -filter_complex \
 "[1:a]aresample=48000,apad=whole_dur=10,adelay={前置留白ms}:all=1,atrim=0:10[a]" \
 -map 0:v -map "[a]" -t 10 -c:v libx264 -crf 18 -c:a aac -ar 48000 tmp/seg01.mp4
# 拼接
printf "file '%s'\n" tmp/seg*.mp4 > tmp/list.txt
ffmpeg -y -f concat -safe 0 -i tmp/list.txt -c copy tmp/joined.mp4
# 响度与可选配乐（配乐 -20dB 左右并被旁白压低）
ffmpeg -y -i tmp/joined.mp4 -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:v copy -c:a aac output/final.mp4
```
前置留白 = (10 − 旁白有效时长)/2，由 `higgsfield-narrator/scripts/speech_metrics.py` 给出。
也可直接用 `higgsfield-storyboard-video/scripts/assemble.sh`（统一尺寸帧率 + 旁白/配乐混音），但它按整段旁白混合，逐块居中需先用上面方式拼旁白。

规则：
- 帧率跟随源（`ffprobe -show_entries stream=r_frame_rate`），不强行改 24/30；分辨率统一到画幅标准（1920x1080 / 1080x1920）。
- 成片时长必须 = 请求秒数（±0.1s）；不得为了配合音频把视频裁短。
- 合成后校验：`ffprobe` 时长、音轨存在；`ffmpeg -v error -i final.mp4 -f null -` 无错误（全片可解码）。

## 最终 QC 清单
- [ ] 只有一个 `final.mp4`，时长 = 请求秒数，有音轨，全片可解码
- [ ] N 块全部完成、顺序正确、无空缺
- [ ] 画风与锚点一致；角色与设定图一致；无对口型/对镜头说话
- [ ] 画幅、分辨率、帧率全片一致
- [ ] 旁白每块在位、同步、密度够；−16 LUFS；音效/配乐在人声之下
- [ ] 字幕（如开启）由 `higgsfield-subtitles` 按转写时间烧录，无裁切
- [ ] 画面和提示词中无品牌/IP/工作室名
- [ ] 抽 3 帧（开头/中间/结尾）`view_image` 目检

## 汇报模板
```
成片：work/output/final.mp4（120.0s，1920x1080，30fps）
字幕版：work/output/final_subs.mp4（如有）
画风：杂志拼贴·钴蓝强调色；音色：{名称}（{voice_id}）
块数：12；重试：block07 ×2（审核改写）
积分：约 {X}（以账户记录为准）
频道 DNA：work/channel_dna.json（下期复用可保持一致）
```
