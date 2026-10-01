# 人像精修参数与风格预设参考

## 1. 氛围 → 预设命名线索
挑预设时按名称关键词匹配，找不到就留空。

| 氛围 | 氛围/影调桶关键词 | 风格桶关键词（与氛围互补） | 建议微调 |
|---|---|---|---|
| 自然干净 | natural、clean、soft | subtle、clean | 一般不需要 |
| 暖调通透 | warm、glow、golden | soft glow、warm film | vibrance +15 |
| 暗调戏剧 | moody、dramatic、dark | matte、shadow | contrast +20, highlights -40 |
| 明亮清新 | bright、airy、light | pastel、fade | darks +30 |
| 电影感 | cinematic、teal、film | grain、anamorphic | saturation -20 |
| 浓郁鲜明 | vivid、bold、pop | punch、color | vibrance +25 |

## 2. 四个预设桶
| 桶 | 数量 | 名称线索 | 触发条件 |
|---|---|---|---|
| 人物自适应 | 1–3 | Adaptive: Portrait / Subject / Skin / Teeth / Whiten | 检测到脸或身体 |
| 氛围/影调 | 1 | 见上表 | 用户选了“氛围影调”或“全部” |
| 风格/Look | 1 | 见上表 | 用户选了“风格”或“全部” |
| 背景虚化 | 1 | Blur Background、Background Soft | 选中后跳过第 10 步 |

## 3. 手动微调区间（按严重程度取单个数值，不要传区间）
| 选项 | 参数 | 轻度 | 重度 |
|---|---|---|---|
| 压高光 | highlights | -40 | -70 |
| 提暗部 | darks | +30 | +50 |
| 加对比 | contrast | +15 | +30（仅限画面很平时） |
| 加鲜艳度 | vibrance | +15 | +30 |
| 降饱和 | saturation | -20 | -40（接近黑白） |
| 提亮 | brightness | +5 | +20 |
| 曝光 | exposure | +0.3~+0.7 或 -0.3~-0.5 | — |

判断依据（先用 `view_image` 看原图）：
- 天空或额头发白 → 压高光。
- 眼窝、下巴阴影死黑 → 提暗部；皮肤发灰时用 vibrance 补偿。
- 整体灰蒙 → 加对比，取较低值。

## 4. 虚化
| 方式 | 工具 | 参数 |
|---|---|---|
| 景深虚化（默认） | `image_apply_lens_blur` | blurRadius 6–10，常用 8 |
| 强虚化（风格化） | `image_apply_gaussian_blur` | blurRadius 12，blurTarget "background" |
| 自适应预设 | `image_apply_preset` | 背景虚化桶里的预设 |

三种方式只选一种，不要叠加。

## 5. 裁切
- 自动：横图用 4:3，竖图用 3:4。
- 统一使用 `fit:"reframe"` 和 `focus:"face"`，检测不到人脸时改用 `"subject"`。
- 证件照/头像建议 1:1 或 4:5，头顶留白约 10%。

## 6. 禁止事项
- 不做生成式的五官、体型、皮肤重绘。
- 不擅自去除痣、疤、纹身等身份特征；只有用户明确要求时才处理，并建议在 Photoshop 中手工完成。
