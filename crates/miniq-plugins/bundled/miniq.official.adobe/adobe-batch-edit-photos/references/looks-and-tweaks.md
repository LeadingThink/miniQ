# 风格预设与微调参数参考

## 1. 七种风格 → `image_apply_adjustments` 参数
不需要色温的风格，`tempA`/`tempB`/`tempLuminance` 三个参数整组省略，不要传 0。

| 风格（中文 / 本地脚本 id） | 色温三参数 | 其他参数 | 预设关键词（按名称匹配） |
|---|---|---|---|
| 自动均衡 / `auto` | 无 | 无，只做自动影调 | balanced、natural、auto |
| 暖金 / `warm` | tempA 32, tempB 120, tempLuminance 67 | vibrance +15 | warm、golden、sunset |
| 明亮通透 / `airy` | tempA 20, tempB 60, tempLuminance 62 | saturation -10, vibrance +10, brightness +15 | bright、airy、light、pastel |
| 暗调电影 / `moody` | tempA 20, tempB -50, tempLuminance 45 | saturation -20, contrast +25 | moody、cinematic、dark、dramatic |
| 冷调清新 / `cool` | tempA 18, tempB -123, tempLuminance 45 | vibrance +10 | cool、fresh、blue、crisp |
| 鲜艳活力 / `vibrant` | 无 | vibrance +30, saturation +15, contrast +10 | vivid、vibrant、pop、punch |
| 低饱和胶片 / `film` | 无 | saturation -35, vibrance -10, contrast +10 | film、matte、muted、vintage |

预设挑选规则：
- 每种风格最多选 2 个（主、次），一个预设只归入一种风格。
- 名称以 `Adaptive:` 开头的预设优先。
- 找不到合适的就留空，不要硬套。

分区自适应预设分 4 个桶，每桶最多 1 个：
- 人物/主体：关键词 subject、person、portrait
- 天空：sky
- 背景：background、bg
- 身体/衣物：skin、clothes、hair、body

## 2. 微调增量（与风格叠加时只传增量，不要自己相加）
| 选项 | 参数 |
|---|---|
| 压高光 | highlights -60 |
| 提暗部 | darks +40 |
| 加对比 | contrast +30 |
| 加色彩浓度 | vibrance 30 |
| 降饱和 | saturation -30 |
| 曝光 | exposure ±0.5；未说明方向时 +0.3 |
| 提亮亮部 | lights +20 |
| 背景强虚化 | 单独调用 `image_apply_gaussian_blur`：blurRadius 12，blurTarget "background" |

## 3. 裁切
- 比例：1:1、4:5、16:9、4:3。统一用 `fit:"reframe"`。
- 智能构图：可能有人物时用 `focus:"face"`，否则用 `"subject"`。
- 居中构图：`align:{x:0.5,y:0.5}`。
- 样张缩略：`output:{width:1200,height:1200}` 配合 `fit:"contain"`，只用于预览。

## 4. 本地 ffmpeg 近似映射（`scripts/local_batch_grade.py`）
| 风格 | 滤镜要点 |
|---|---|
| warm | `colortemperature=temperature=5200`（偏暖）+ `eq=saturation=1.1` |
| airy | `eq=brightness=0.06:saturation=0.92` + `curves=preset=lighter` |
| moody | `eq=contrast=1.2:saturation=0.8:brightness=-0.03` + `colortemperature=7500`（偏冷）|
| cool | `colortemperature=temperature=8000` + `eq=saturation=1.05` |
| vibrant | `eq=contrast=1.1:saturation=1.35` |
| film | `eq=contrast=1.08:saturation=0.65` + `curves=preset=vintage` |

上表只是视觉近似，与 Camera Raw 结果不会完全一致，交付时需说明。
