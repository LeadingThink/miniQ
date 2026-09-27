# 社媒尺寸参考表

> 各平台规格会调整，交付前如有疑问请以平台官方说明为准。本表与 `scripts/social_crop_plan.py` 中的 `PRESETS` 保持一致。

## 1. 图片尺寸
| 键名 | 平台 | 用途 | 尺寸 | 比例 | 建议 quality | 来源画布 |
|---|---|---|---|---|---|---|
| instagram_square | Instagram | 动态方图 | 1080×1080 | 1:1 | 7 | 原图 |
| instagram_portrait | Instagram | 动态竖图 | 1080×1350 | 4:5 | 7 | tall |
| instagram_story | Instagram | 快拍/Reels | 1080×1920 | 9:16 | 7 | tall |
| tiktok | TikTok/抖音 | 图文/视频封面 | 1080×1920 | 9:16 | 7 | tall |
| linkedin_landscape | LinkedIn | 横图帖 | 1200×627 | ≈1.91:1 | 6 | wide |
| linkedin_square | LinkedIn | 方图帖 | 1080×1080 | 1:1 | 6 | 原图 |
| facebook_landscape | Facebook | 横图 | 1200×630 | ≈1.91:1 | 7 | wide |
| facebook_square | Facebook | 方图 | 1080×1080 | 1:1 | 7 | 原图 |
| facebook_story | Facebook | 快拍 | 1080×1920 | 9:16 | 7 | tall |
| x_landscape | X/Twitter | 信息流 | 1200×675 | 16:9 | 6 | wide |
| x_square | X/Twitter | 方图 | 1080×1080 | 1:1 | 6 | 原图 |
| youtube_thumbnail | YouTube | 缩略图 | 1280×720 | 16:9 | 5 | wide |
| snapchat | Snapchat | 快照/故事 | 1080×1920 | 9:16 | 2（≤250 KB） | tall |
| pinterest | Pinterest | 标准 Pin | 1000×1500 | 2:3 | 7 | tall |
| threads | Threads | 竖图 | 1080×1350 | 4:5 | 7 | tall |
| xiaohongshu | 小红书 | 笔记竖图 | 1080×1440 | 3:4 | 7 | tall |
| xiaohongshu_square | 小红书 | 笔记方图 | 1080×1080 | 1:1 | 7 | 原图 |
| weibo_landscape | 微博 | 横图 | 1200×675 | 16:9 | 7 | wide |
| wechat_cover | 微信公众号 | 头条封面 | 900×383 | 2.35:1 | 7 | wide |
| wechat_moments | 微信朋友圈 | 方图 | 1080×1080 | 1:1 | 7 | 原图 |
| bilibili_cover | B 站 | 视频封面 | 1920×1080 | 16:9 | 6 | wide |

quality 是 `image_crop_and_resize` 的质量等级（数值越大画质越高）；本地脚本会换算成 ffmpeg 的 `-q:v`。

## 2. 画布选择规则
- 目标比例（宽/高）< 0.9：用竖版画布 tall。
- 目标比例 > 1.2：用横版画布 wide。
- 其他情况：直接用原图。
- 扩图量：竖向上下各 960 px（横构图原图 2000），横向左右各 960 px（横构图原图 1500）。
- 始终从原图扩图，不要叠加扩图。

## 3. 视频同比例安全尺寸
| 源比例 | 可选输出 |
|---|---|
| 9:16 | 1080×1920、720×1280、540×960 |
| 1:1 | 1080×1080、720×720 |
| 16:9 | 1920×1080、1280×720、854×480 |

## 4. 安全区
- 9:16 快拍：顶部约 14%、底部约 20% 会被界面遮挡，文字和 logo 不要放在这两个区域。
- YouTube 缩略图：右下角会显示时长角标，避开该区域。
- 公众号封面 2.35:1：分享卡片会裁成中间 1:1，主体要放在正中间。

## 5. 命名
格式：`<原名>_<平台>_<用途>_<比例>.jpg`，比例里的冒号写成 x，例如 `hero_xiaohongshu_note_3x4.jpg`。
