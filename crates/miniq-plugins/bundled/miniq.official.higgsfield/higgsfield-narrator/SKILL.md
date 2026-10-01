---
name: higgsfield-narrator
displayName: 旁白配音（Narrator）
description: 需要用 Higgsfield 语音模型为视频生成旁白配音时使用：把台词逐条生成一致音色的配音，并让每条落在指定时间窗（如 10 秒块内有效语音 9.4–9.8 秒），测算语速、时长、静音与响度，必要时改写台词重生成。供无出镜频道、分镜短片调用，也可单独使用。
version: 1
---

# 旁白配音（Narrator）

## 触发场景
- 无出镜频道/分镜短片需要逐块旁白（由 `higgsfield-faceless-channel`、`higgsfield-storyboard-video` 调用）。
- “把这几句话配成同一个声音”“这段旁白要刚好 30 秒”“检查配音语速是否太快”。

## 前置条件
- Higgsfield MCP（连接器 `higgsfield`）已登录；先 `tools/list` 确认音频生成与音色列表工具的实际名称和参数。配音消耗积分：开跑前告知条数并获同意。
- 本地：`python3`、`ffprobe`、`ffmpeg`（测算静音与响度）。
- 已锁定音色对 `voice_id` + `voice_type`（来自 `list_voices` 或频道 DNA）。缺少 `voice_type` 时再查一次 `list_voices` 补齐，**绝不猜测，也不在缺音色时交无声成片**。

## MCP 工具（以连接器实际列出的为准）
| 用途 | 对标名称 | 参数要点 |
|---|---|---|
| 列音色 | `list_voices` | 语言、性别/风格；取 `voice_id`、`voice_type`、名称 |
| 生成语音 | `generate_audio`（批量 `generate_audio_batch`） | 模型（对标 `seed_audio`）、文本、`voice_id`+`voice_type`、语气提示；每条一个任务 |
| 等待 | `jobs_wait` / `job_status` | `{index, job_id}` |

## 分步流程
1. **准备台词表** `lines.json`：`[{"n":1,"text":"...","window":10.0}]`。只放要念的字；数字、缩写写成念法（“2024年”→“二〇二四年”视语境；“AI”保留）。
2. **预估**：`python3 scripts/speech_metrics.py plan lines.json` 按语速预测时长，超出窗口的先改写（删修饰语、拆句），不要指望加速。语速基线见 `references/pacing.md`。
3. **生成**：每条一个任务，全部使用同一音色对与同一语气提示；批量 ≤6。语气提示单独给出（如“平稳、清晰、带一点笑意”），不塞进台词。
4. **下载** 到 `voices/voiceNN.wav|mp3`，按编号而非完成顺序。
5. **测算**：`python3 scripts/speech_metrics.py measure voices/voice01.wav --window 10 --text "台词"`（或 `batch lines.json voices/`），得到总时长、首尾静音、有效语音时长、语速、响度与“居中前置留白”。
6. **判定**：
   - 有效语音 > 窗口 − 0.2s → 缩短台词重生成（每次删约 10%）。
   - 有效语音 < 目标下限（默认窗口×0.94）超过 1 秒 → 适当加字重生成；略短可接受。
   - **禁止用 atempo 等变速手段**硬塞进窗口（音色会变），最多裁掉首尾静音。
   - 两条之间音色/音量明显不一致 → 用同参数重生成该条。
7. **交付** 给合成：每条的 `lead_in`（居中留白秒数）写入 `voices/metrics.json`。

## 质量检查与失败回退
- 同一条累计 4 次仍不达标：接受最接近的一条并在汇报中注明偏差。
- 生成失败/审核拦截：检查台词中的敏感词、人名，改写后重提；仍失败向用户说明。
- 无 `ffprobe`：提示安装（`brew install ffmpeg`），期间只能用 `plan` 模式按字数估算。
- 整片响度在合成阶段统一到 −16 LUFS；单条测得的响度只用于发现异常（相差 >4 LU 即重生成）。

## 输出交付格式
- `voices/voiceNN.*` 音频文件、`voices/metrics.json`（每条：时长、有效语音、语速、lead_in、是否达标）。
- 汇报：音色名称与 id、条数、达标数、未达标条目及偏差。
深度内容：`references/pacing.md`（语速、节奏、写稿技巧）。
