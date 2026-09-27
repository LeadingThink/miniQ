# 快剪节奏规则

## 1. 时长档位
| 档位 | target_duration | 典型用途 |
|---|---|---|
| 短 | 15 | 抖音/Reels 预告、广告前贴 |
| 中 | 45（覆盖 30–60 秒） | 活动回顾、产品介绍 |
| 长 | 90 | 精华版、YouTube 开场 |

## 2. 风格 → user_prompt（自行改写的英文指令，传给 `video_create_quick_cut`）
| 风格 | user_prompt 要点 | 本地回退节奏（`--style`） |
|---|---|---|
| 高能快节奏 | "Fast-paced highlight reel: keep the most dynamic, high-motion moments, cut on action, short punchy shots, energetic momentum from start to finish." | `energy`：每个镜头 1.2–2 秒 |
| 口播要点 | "Keep the clearest spoken key points with the speaker on camera, preserve complete sentences, steady professional pacing, minimal filler." | `talk`：每段 4–7 秒 |
| 电影叙事 | "Cinematic story arc: establishing shot, build-up, emotional peak and a calm ending; allow shots to breathe, favour wide and atmospheric moments." | `cinematic`：每个镜头 3–5 秒，开头和结尾略长 |
| 不限 | "Balanced highlight edit mixing action and key moments with natural pacing." | `balanced`：每个镜头 2.5–3.5 秒 |

## 3. 通用剪辑原则
- 开头 2 秒内必须有吸引注意的画面，不要以黑场或空镜开场。
- 结尾留 0.5–1 秒收尾，可以淡出。
- 避免同一个机位的相邻片段直接拼接（会跳切），中间至少间隔一个其他镜头。
- 口播内容尽量在句子停顿处切。本地回退没有语音识别，可用 `silencedetect` 找停顿点：
  `ffmpeg -i in.mp4 -af silencedetect=noise=-30dB:d=0.4 -f null -`
- 素材开头和结尾各 3% 通常是开机、关机画面，取片段时跳过。
- 竖屏输出（9:16）：居中裁切 `crop=ih*9/16:ih`，再 `scale=1080:1920`；主体偏离中心时需提示用户。

## 4. 本地片段选取算法（`scripts/quickcut_plan.py`）
1. 可用区间 = [总时长 × 3%，总时长 × 97%]。
2. 片段数 = 目标时长 ÷ 该风格的平均镜头长度（向上取整）。
3. 提供了场景切点（`--scenes`）时，优先从切点之后 0.2 秒开始取；否则在可用区间内等距取点。
4. 电影风格：第一段和最后一段长度 × 1.5。
5. 用 `trim`/`atrim` 截取后 `concat` 拼接，统一重新编码为 H.264 + AAC，避免关键帧导致的裁切误差。

## 5. 质量验收
- 实际时长与目标偏差不超过 ±15%（Adobe 生成结果可能偏差更大，需要说明）。
- 不能有黑帧、音画不同步；抽 3 帧看画面。
- 输出统一用 `.mp4`（H.264 / AAC / yuv420p），保证手机端能播放。
