# 契约：确定性导出（deterministic-exports）

适用：用户要最终成品——指定像素尺寸、多平台尺寸、带文字的海报、视频规格。

## 规则
1. **尺寸不靠生图保证**。生图只提供主视觉；最终尺寸由确定性工具产生：
   - 带文字 / 版式：`creative-layout-deliver/scripts/layout.html` + `render.sh <html> <WxH> <out.png>`
   - 纯裁切 / 缩放：`creative-layout-deliver/scripts/fit.sh <in> <WxH> <out> [cover|contain]`（有 ffmpeg 用 ffmpeg，否则 macOS `sips`）
   - 视频：`ffmpeg`（缩放、裁切、编码 H.264 / yuv420p、音频）
2. **文件名带尺寸**：`<名称>-<W>x<H>.<ext>`，便于自动核验。
3. **导出后核验**：
   - `python3 creative-layout-deliver/scripts/export_check.py creative/out` —— 自动读图片头 / ffprobe，对照文件名中的尺寸，生成 `manifest.json`（含 sha256）。
   - 图片再用 `view_image` 实际查看：文字未被裁切、安全区内无关键信息被遮挡。
   - 视频：`ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt:format=duration -of json <文件>`。
4. 同一输入、同一参数应得到相同输出；不要在导出阶段再调用生图工具“顺便改一改”。

## 无 ffmpeg / ffprobe 时
- 图片：`sips -g pixelWidth -g pixelHeight <文件>` 读尺寸；`fit.sh` 自动退回 sips。
- 视频：无法本地转码时，告诉用户需要安装 ffmpeg（如 `brew install ffmpeg`），或让 `generate_video` 直接按目标 `aspect_ratio` 生成，并如实说明未做本地核验。
