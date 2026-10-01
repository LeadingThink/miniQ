---
name: chatcut-subtitles
displayName: 字幕生成与校对
description: 为视频生成、校对、翻译和烧录字幕时使用：语音转写成 SRT，按停顿对齐已有文稿，检查字幕的阅读速度和行宽，平移时间轴，导出 VTT，烧录硬字幕或封装软字幕。全程在本机处理。
version: 1
---

# 字幕生成与校对

## 触发场景
- “给这个视频加字幕”“把口播转成字幕文件”“我有文稿，帮我对上时间”“字幕整体晚了半秒”“出一版英文字幕”“导出 VTT 给网页用”。

## 前置条件
- ffmpeg/ffprobe 可用（检查方法见 `chatcut-ffmpeg-edit`）；python3 可用。
- 脚本：
  - `scripts/srt_tool.py`（align/fromjson/shift/wrap/validate/tovtt）
  - `../chatcut-ffmpeg-edit/scripts/cutkit.sh`（wav16k/silences/subtitle）
  - 执行前先用 `glob` 找到这两个脚本的实际路径。
- 字幕风格、断句规范和翻译规则见 `references/subtitle-style.md`。

## 分步流程
1. **探测素材**：运行 `cutkit.sh probe in.mp4`，记下总时长 D 以及是否有音轨。没有音轨就不能转写，只能走“已有文稿”路线。
2. **拿到带时间的文本**，按优先级选一条路线：
   - **A. 本机已有 whisper**：用 `command -v whisper` 检查。有的话执行 `whisper in.wav --language zh --output_format json`，然后用 `srt_tool.py fromjson in.json -o subs.srt` 转成字幕。这条路线的时间戳最准。
   - **B. 用 miniQ 转写**：
     1. 运行 `cutkit.sh wav16k in.mp4 /tmp/cc/in.wav`，再用 `transcribe_audio`（path=该 wav，language 填 `zh` 或对应语种）拿到全文。
     2. 如果返回里带分段时间戳，就整理成 `{"segments":[{"start","end","text"}]}`，用 `fromjson` 转换。
     3. 如果只有纯文本，就把全文写成 `/tmp/cc/text.txt`，接着运行 `cutkit.sh silences in.mp4 > /tmp/cc/sil.txt`，然后执行 `srt_tool.py align --text /tmp/cc/text.txt --silences /tmp/cc/sil.txt --duration D -o subs.srt`。
     4. 超过 20 分钟的长音频，先用 `cutkit.sh trim` 或 `ffmpeg -f segment` 切成 10 分钟一段分别转写。拼接字幕时，用 `shift` 给后面各段加上时间偏移。
   - **C. 用户提供了文稿**：先让文稿每行一句，再用 `align --lines` 保留用户自己的断句。
3. **校对文本**：先看转写结果里的专有名词、人名、品牌和数字。拿不准的地方汇总成一个问题，用 `ask_user` 一次问清，不要逐条打扰用户。纠正后的文本用 `file_write` 写回 SRT，只改文字，时间码不动。
4. **规范化**：运行 `srt_tool.py wrap subs.srt --width 16 -o subs.srt`，然后运行 `srt_tool.py validate subs.srt`。
   - 阅读速度超标：把句子拆开，或精简成口语摘要，但必须先征得用户同意。
   - 条目过短：与相邻条合并。
   - 条目重叠：调整时间。
5. **翻译（可选）**：逐条翻译，条数和时间码保持不变。英文按每行 ≤42 字符折行，然后运行 `validate --max-cps 20 --width 42`。双语字幕在同一条里放两行，中文在上。
6. **输出**：
   - 软字幕（不重编码，可以开关）：`ffmpeg -i in.mp4 -i subs.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=chi out.mp4`
   - 硬字幕：`cutkit.sh subtitle in.mp4 subs.srt out.mp4 [字体]`。竖屏素材要先转竖屏再烧字幕，否则字幕位置会错。
   - 网页用：`srt_tool.py tovtt subs.srt -o subs.vtt`。
   - 如果视频之后还要剪辑，就等剪完再生成字幕。剪辑会改变时间轴；只是整体平移时，可以用 `shift` 修正。

## 质量检查
- 运行 `srt_tool.py validate subs.srt --strict`，退出码应为 0。确有无法避免的问题时，在汇报里写明。
- 烧录后抽 3 帧检查，分别取在第一条字幕、最长的一条字幕、最后一条字幕的中点时刻：`ffmpeg -ss T -i out.mp4 -frames:v 1 f.jpg`。用 `view_image` 确认字没有出界、中文不是方框、没有被平台界面区域遮挡。
- 运行 `cutkit.sh check out.mp4`，确认输出时长与原片一致。
- `align` 生成的时间是近似值。在开头、中段、结尾各挑一句，把抽帧和音频时间对照着抽查。误差超过 0.5 秒时，改走 A 路线，或者按停顿手动调整。

## 失败回退
- `transcribe_audio` 失败或语种识别错误：显式指定 language 重试一次。仍然失败就改用本机 whisper；两者都不可用时，请用户提供文稿，改走 C 路线。
- 没有检测到静音（背景音乐很满）：`silences` 的阈值改成 `-30`。再不行就不传 `--silences`，按全时长均匀分配，并告诉用户时间只是粗对齐。
- 缺少 `subtitles` 滤镜（没有 libass）：改为输出软字幕，同时交付 SRT 文件。
- 中文显示成方框：换字体参数，Linux 上用 `Noto Sans CJK SC`。

## 交付格式
- 交付物：`subs.srt`，以及可选的 `subs.vtt`、`subs.en.srt`、带字幕的视频。
- 说明字幕条数、总时长、`validate` 结果，以及用了哪条时间戳路线（精确或近似）。
- 列出改动过的专有名词。
- 最后只提一个下一步建议，例如：“需要我把字幕烧进竖屏版吗？”
