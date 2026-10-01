---
name: higgsfield-subtitles
description: 需要给视频加字幕时使用：用 Whisper 转写取得准确时间轴，文字优先采用脚本原文，按画幅与语言切分成易读的一到两行，生成 SRT/ASS，并用 ffmpeg 烧录成干净、醒目或卡拉 OK 样式。无 Whisper 时给出替代方案。适用于 Higgsfield 生成的成片或任意本地视频。
version: 1
---

# 字幕（Subtitles）

## 触发场景
- 无出镜频道/分镜短片开启了字幕（`higgsfield-faceless-channel` 的 `subtitles=true`、儿歌默认开启）。
- “给这个视频加中文字幕”“导出 SRT”“做成抖音那种大字幕”“字幕跟着歌词高亮”。
- 不适用：需要翻译多语种字幕（可先翻译脚本再按本流程生成）。

## 前置条件
- 本地：`python3`、`ffmpeg`/`ffprobe`（烧录需带 libass 的 ffmpeg，`ffmpeg -filters | grep subtitles` 可确认）。
- 转写：`whisper`（openai-whisper）或 `whisper-cli`（whisper.cpp，需用 `--model` 指定真实 ggml 模型，如 `ggml-base.bin`/`ggml-small.bin`；Homebrew 自带的 `for-tests-*` 模型只能测流程，转写为空）。`python3 scripts/transcribe.py --check` 查看；都没有时见下方回退。
- 本技能默认不调用 Higgsfield MCP、不消耗积分。只有用户要求“重新生成配音再对字幕”时才转给 `higgsfield-narrator`（需登录与积分确认）。

## MCP 工具与关键参数
- 无必需 MCP 工具。若需取回已生成的音频/视频地址，可用连接器的作品查询工具（对标 `show_generation_by_ids`，**以连接器 tools/list 实际列出的工具为准**），下载到本地后再处理。

## 分步流程
1. **取音频**：对成片或整段旁白转写（成片含配乐时优先用纯旁白音轨，准确率更高）。
   `python3 scripts/transcribe.py work/output/final.mp4 --language zh -o work/transcript.json`
2. **生成字幕**：有脚本原文时一定传 `--script`，文字用原文（避免同音错字），时间来自转写：
   `python3 scripts/captions.py --aspect 16:9 --style clean -o work/output/captions.srt build work/transcript.json --script work/vo.txt`
   得到 `captions.srt` 与 `captions.ass`。切分规则见 `references/caption-rules.md`。
3. **抽查**：打开 SRT 看前 10 条和最后 5 条；最长行不超过设定；首条不早于语音开始、末条不晚于成片结束。
4. **烧录**：
   `python3 scripts/captions.py burn work/output/final.mp4 work/output/captions.ass --output work/output/final_subs.mp4 --run`
   （不带 `--run` 只打印命令；样式来自 ASS。）
5. **验证**：`ffprobe` 时长与原片一致、音轨仍在；抽 3 帧目检字幕位置未遮挡主体、没有出画。

## 质量检查与失败回退
- 字幕与语音偏移 >0.3s：确认转写的是同一文件；成片有前置留白时不要转写单条旁白而要转写成片。
- 脚本与实际念词差异较大（改写过台词）：以最新 `script_manifest.json` 的 `vo_line` 重新导出 `--script`，或不传 `--script` 直接用转写文本后人工校对。
- **无 whisper**：① 安装 `pip install -U openai-whisper` 或 `brew install whisper-cpp`；② 暂无法安装时用 `captions.py even lines.json`，按每块窗口与 `speech_metrics.py` 测得的 `speech` 均分时间（精度较低，汇报时注明）。
- 烧录报错 “No such filter: subtitles”：ffmpeg 缺 libass，改交付外挂 SRT 并说明。
- 中文显示方块：用 `--font` 指定本机已有中文字体（macOS 用 `PingFang SC`）。

## 输出交付格式
- `captions.srt`（通用外挂）、`captions.ass`（样式版）、`final_subs.mp4`（烧录版，原片保留不覆盖）。
- 汇报：字幕条数、最长行字符数、样式、时间来源（whisper 引擎名 / 均分回退）、烧录版路径。
深度内容：`references/caption-rules.md`（分行、时长、样式与位置）。
