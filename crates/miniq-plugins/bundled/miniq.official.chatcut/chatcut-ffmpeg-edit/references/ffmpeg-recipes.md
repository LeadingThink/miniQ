# FFmpeg 配方与排错

以下命令都通过 `shell_run` 执行。`in.mp4`/`out.mp4` 替换成实际路径；路径有空格要加引号。

## 常用配方
- 首尾淡入淡出（时长 D 秒，淡 0.5 秒）：
  `ffmpeg -i in.mp4 -vf "fade=t=in:st=0:d=0.5,fade=t=out:st=D-0.5:d=0.5" -af "afade=t=in:d=0.5,afade=t=out:st=D-0.5:d=0.5" -c:v libx264 -crf 20 -c:a aac out.mp4`（把 `D-0.5` 算成具体数字）。
- 两段交叉转场（第一段长 L 秒，转场 0.5 秒）：
  `ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=L-0.5[v];[0:a][1:a]acrossfade=d=0.5[a]" -map "[v]" -map "[a]" out.mp4`。两段的分辨率、帧率必须一致，否则先用 cutkit `concat` 统一。
- 画中画（右下角 1/4 大小）：
  `ffmpeg -i main.mp4 -i cam.mp4 -filter_complex "[1:v]scale=iw/4:-2[p];[0:v][p]overlay=W-w-24:H-h-24" -map 0:a? -c:a copy out.mp4`。
- 加水印/Logo（右上角、70% 不透明）：
  `ffmpeg -i in.mp4 -i logo.png -filter_complex "[1]format=rgba,colorchannelmixer=aa=0.7,scale=160:-1[l];[0][l]overlay=W-w-24:24" -c:a copy out.mp4`。
- 文字标题（前 3 秒）：用 `drawtext` 并指定中文字体文件，比如 macOS 下 `fontfile=/System/Library/Fonts/PingFang.ttc`，加上 `enable='lt(t,3)'`。
- 定格 2 秒（在 T 秒）：先 `trim` 出 0–T 与 T–结尾两段，再用 `ffmpeg -ss T -i in.mp4 -frames:v 1 f.png` 取帧，把静帧作为 2 秒的图片片段放进 `chatcut-edit-plan`。
- 倒放（仅短片段，占内存）：`ffmpeg -i in.mp4 -vf reverse -af areverse out.mp4`。
- 视频转 GIF（宽 480、12fps、调色板）：
  `ffmpeg -i in.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif`。
- 封面图：`ffmpeg -ss 1.5 -i in.mp4 -frames:v 1 -q:v 2 cover.jpg`，再用 `view_image` 确认；需要设计感封面可以交给 creative-production 插件。
- 降噪（轻度）：`-af "highpass=f=80,afftdn=nf=-25"`。
- 去除原声只留画面：`-an`；替换音轨：`-i v.mp4 -i a.m4a -map 0:v -map 1:a -shortest -c:v copy`。

## 排错
| 现象 / 报错 | 原因 | 处理 |
|---|---|---|
| `height not divisible by 2` | libx264 要求宽高为偶数 | 缩放时用 `-2`，例如 `scale=1080:-2` |
| `No such filter: subtitles` / `drawtext` | 编译时没有 libass/freetype | Homebrew 安装的 ffmpeg 自带；否则改用软字幕 `-c:s mov_text` |
| 音画逐渐不同步 | 素材是可变帧率（VFR） | 先转成恒定帧率：`-vf fps=30`，再剪 |
| `-c copy` 截取后开头黑屏或卡顿 | 切点不在关键帧上 | 改为重编码截取（cutkit `trim` 默认就是重编码） |
| concat 报 `Input link parameters do not match` | 各段尺寸、帧率或采样率不同 | 用 cutkit `concat`，它会先统一参数 |
| `atempo` 报超出范围 | 单个 atempo 只支持 0.5–2 | 串联多个 atempo（cutkit `speed` 会自动处理） |
| 字幕中文显示为方框 | 缺少字体 | 用 `force_style='FontName=PingFang SC'`；Linux 上改用 `Noto Sans CJK SC` |
| HEVC/HDR 手机素材颜色发灰 | HDR 被直接转成 SDR，没有做色调映射 | 加 `-vf "zscale=t=linear,tonemap=hable,zscale=t=bt709:m=bt709,format=yuv420p"`（需要 zimg）；没有 zimg 时告诉用户颜色可能有偏差 |
| 处理超时 | 素材长、编码慢 | 调大 `timeoutSecs`，或加 `-preset veryfast`；也可以先试剪一段 |
