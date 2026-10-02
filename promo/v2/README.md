# miniQ v2 · 把时间留给你的想法

交付：`promo/out/miniq-promo-v2.mp4`。68 秒，1920×1080，30fps，H.264 / AAC，立体声中文旁白，约 15.9 MB。

## 创作方向

同一个用户场景贯穿全片：明早要提案，今晚资料还散着。miniQ 把资料连成可讨论的方向；春日活动想法变成主视觉和配乐；这次磨合的做法，下次继续用。结尾回到人的判断与想法，而非工具清单。

| 时间 | 内容 |
| --- | --- |
| 00–14s | 深夜：简报、预算、会议记录散落 |
| 14–23s | 一句话说清提案目标，资料逐步归位 |
| 23–31s | 讨论稿：推荐方向、预算重点、待确认及资料依据 |
| 31–40s | “春日慢聚”真实生成的视觉占据全画幅 |
| 40–47s | 原创活动配乐与视觉形成统一氛围 |
| 47–56s | 保存这次做法，下次带新资料接着用 |
| 56–68s | 从 22:48 到 09:00，把时间留给重要的讨论与想法 |

画面采用深森林绿、象牙白和鼠尾草绿；正文、标题、字幕分区；展示提案时让内容本身成为主角。包含缓动、分步信息出现、纸张空间运动、图片慢推及配乐波形，不使用开发工具名、模型名或功能目录。

## 素材与真实性

- 所有产品画面与示例文件为本片设计的场景动效，并在右上角持续标注“场景动效演示 · 示例资料”（品牌结束页除外）。它们不是一次真实端到端操作录屏，也不表示自动审核通过；提案显示“供你审阅”，决策保留待确认事项。
- `assets/spring-tea.png`：本次通过原生图像生成工具实际生成，茶器、梨花、透光薄纱的原创活动视觉，无外部照片。生成资产 ID：`f450921d-3f8a-4b5f-bf75-7bb1665f11fd`。无真实客户或商业活动背书。
- `assets/spring-music.wav`：本片新编的 68 秒音乐。`music.py` 复用经检查的 `../audio.py` 合成器函数，重新编写和弦、旋律、节奏与音色，没有取用第三方歌曲或音频采样。画面中的播放卡是动效示意，所听配乐确为本地合成。
- 中文旁白：原生 `synthesize_speech` 返回 HTTP 502，已使用 macOS `say` 的 Tingting 音色本地生成并分段混音，保留文本和原始 AIFF/WAV。属于合成旁白，未冒充真人配音。
- 结束页图标复用 `../assets/icon.png`，已核对 SHA-1 与 `apps/desktop/src-tauri/icons/icon.png` 一致：`5ed06c4ded45e4d3c0770084307469f280f8d992`。
- 字体使用本机 PingFang SC / Songti SC；MiSans 为仓库已有回退字体。未复用旧版工程录屏、旧版渲染文件或未知来源网页截图。

## 重建

在仓库根目录运行 `sh promo/v2/build.sh`。依赖现有 `promo/node_modules/puppeteer-core`、Google Chrome、ffmpeg、ffprobe、macOS say、Python 3 + NumPy。脚本会把 `/usr/local/bin:/opt/homebrew/bin` 加入 PATH。

本仓库不存在 AGENTS.md 中提及的 backend/pyproject.toml 或 uv.lock，且没有 uv 命令；因此本地音频采用已安装并验证可用的 Python 3 / NumPy。制作文件全部新增在 v2，旧版源码和成片未覆盖。

- `story.mjs`：时长、场景、旁白与字幕
- `index.html` / `style.css` / `timeline.mjs`：构图与确定性时间轴
- `render.mjs`：Puppeteer 逐帧 → ffmpeg；`--preview` 生成九张关键帧
- `music.py` / `audio.mjs`：原创配乐、分段旁白及混音
- `build.sh`：渲染、合成及完整解码

## 已完成验证

- ffprobe：68.000 秒；2040 视频帧；1920×1080 / 30fps；H.264 yuv420p；AAC 48kHz 双声道，音视频时长一致。
- `ffmpeg -v error -xerror -i ... -f null -` 全长音视频解码通过，退出码 0，无解码错误。
- 综合响度 −17.1 LUFS，真峰值 −3.9 dBFS，无削波；各段旁白按场景槽位放置，不跨场重叠。
- 使用 view_image 检查九个场景的 1080p 关键帧，并检查最终 MP4 抽出的主视觉帧与九宫格；未发现标题遮盖 UI、越界、缺失图片或文字乱码。
- JavaScript 语法检查通过，v2 范围 diff 空白检查通过。旧版 `promo/audio.py` 的原有尾随空白未改动。

验证资料：`build/ffprobe.json`、`build/loudness.log`、`build/voice-timing.json` 与 `promo/out/v2-check/`。本轮完成视觉与媒体结构检查，未进行真人听审。
