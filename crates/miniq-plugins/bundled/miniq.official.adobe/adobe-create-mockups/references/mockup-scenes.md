# 样机场景与提示词参考

## 1. 按品牌类型推荐产品（每次推荐 4–5 个）
| 品牌类型 | 推荐产品 |
|---|---|
| 街头 / 潮牌 | 帽衫、棒球帽、滑板面、帆布袋、贴纸 |
| 餐饮 / 饮品 | 马克杯、外带纸杯、帆布袋、围裙、名片 |
| 家居 / 厨具 | 餐盘、马克杯、茶巾、帆布袋、名片 |
| 科技 / SaaS | 手机屏、笔记本贴纸、笔记本、T 恤、名片 |
| 美妆 / 健康 | 瓶身标签、帆布袋、名片、镜卡、海报 |
| 创意工作室 | 海报、名片、笔记本、帆布袋、手机屏 |
| 无法判断 | 马克杯、T 恤、名片、手机屏 |

## 2. 画幅
- 马克杯、T 恤、帆布袋、名片：默认方形。
- 手机屏、海报：竖幅。
- 广告牌、网站首屏、演示场景：横幅。
- 带参考图时，画幅只写在提示词里，例如“square studio composition”，不要传 `aspectRatio`。

## 3. 调性 → 场景语言
| 调性 | 场景起点 |
|---|---|
| 极简 | 柔和棚拍光、白色或浅灰台面、大量留白、不放道具 |
| 活泼 | 品牌色高饱和背景、随意角度、有趣的小道具 |
| 奢华 | 大理石、丝绒、深色木纹，定向硬光，金色点缀 |
| 大胆 | 品牌色纯色背景、高反差、平铺构图 |
| 自然 / 有机 | 原木、亚麻、石材、牛皮纸，暖色漫射光 |

全套样机要固定这几项不变：品牌色 HEX、主光方向、台面材质。

## 4. 提示词模板（英文效果通常更稳定）
```
[台面与背景，含品牌色], [产品描述], [logo 放置位置，如 "logo mark on the front face"],
[尺寸，如 "centered, about 30% of the surface"], [光线], product mockup photography,
[符合调性的道具]. The logo from the reference image must sit naturally on the [surface],
following its curvature and texture, realistically sized, not floating or oversized.
No extra text or lettering. Use the design from the reference image.
```

要点：
- 只描述场景和放置方式，**不要描述 logo 本身长什么样**，logo 由 `referenceImage` 提供。
- 结尾固定加上“Use the design from the reference image.”。
- 用户没有明确给出品牌名时，加上“No extra text”，避免模型编造文字。

## 5. 常见问题与修正提示词
| 问题 | 在提示词中追加 |
|---|---|
| logo 悬浮 | printed directly on the fabric, following folds and shading |
| logo 过大 | small chest logo, about 15% of the shirt width |
| logo 被改形 | keep the exact shape and colors of the reference logo |
| 出现假文字 | no text, no letters, no watermark |
| 风格不统一 | 统一回第 3 节固定的光线和台面 |

## 6. 本地回退（Photoshop 智能对象样机）
1. 用户提供带智能对象图层的 PSD 样机模板。
2. 写一段 .jsx：打开 PSD → 找到智能对象 → `placedLayerReplaceContents` 替换为 logo → 导出 PNG。
3. 通过 `adobe-desktop-scripting/scripts/run_jsx.sh` 执行。先给用户看脚本要点，确认后再运行。
