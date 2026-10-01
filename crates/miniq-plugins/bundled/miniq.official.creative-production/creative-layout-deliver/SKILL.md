---
name: creative-layout-deliver
displayName: 排版成品与交付
description: 把选定的主视觉与确认过的文案确定性排版成海报、社媒图、横幅、轮播或多平台尺寸成品，裁切缩放与核验尺寸（render.sh / fit.sh / export_check.py），并打包交付时使用。
version: 1
---

# 排版成品与交付

## 触发场景
- 用户已在看板上选定方向，需要加标题、卖点、CTA、logo、价格等文字，做成海报 / 小红书封面 / 朋友圈图 / 电商主图 / Banner。
- 同一设计导出多个平台尺寸；社交轮播多页统一排版；样机中贴入真实截图。
- 生成交付清单并打包。

## 前置条件
- 素材来自 `creative-asset-produce`（看板中 selected 的项），文案逐字存于 `creative/copy.md`（遵守 `creative-asset-produce/references/contracts/exact-content.md`）。
- 本技能脚本（`scripts/`）：
  - `layout.html`：CSS 变量驱动的排版模板，支持 `?w=&h=` 覆盖画布尺寸；
  - `render.sh <html> <WxH> <out.png>`：无头 Chrome/Chromium/Edge 截图；
  - `fit.sh <输入> <WxH> <输出> [cover|contain] [补边色HEX]`：确定性裁切 / 缩放，有 ffmpeg 用 ffmpeg（支持视频），否则用 macOS `sips`（仅图片）；
  - `export_check.py <成品目录>`：读取真实尺寸 / 时长，对照文件名中的 `WxH`，生成带 sha256 的 `manifest.json`。
- 平台尺寸与安全区见 `references/platform-sizes.md`；确定性导出规则见 `creative-asset-produce/references/contracts/deterministic-exports.md`。

## 分步流程
1. **收集输入**：`board.py read` 找到 selected 条目的图片路径；`file_read creative/copy.md`。缺必需文案（价格、日期等）时 `ask_user`，不自行补写。
2. **做版式**：`file_read scripts/layout.html`，复制为 `creative/layout/<名称>.html`，`file_edit` 修改：
   - `:root` 变量：`--w`/`--h`、`--brand`/`--ink`/`--paper`、字体栈；
   - `.hero` 背景图（相对 HTML 的路径）、标题 / 副标题 / 卖点 / CTA / logo；
   - `data-layout="top"` 或 `"bottom"`，按主视觉留白位置选择。
   轮播：每页一个 HTML（共享同一 CSS 变量），页码在 HTML 中写。样机：用绝对定位 + `transform` 把截图放到屏幕区域。
3. **渲染**：对每个目标尺寸分别执行
   ```bash
   bash scripts/render.sh creative/layout/poster.html 1080x1350 creative/out/poster-1080x1350.png
   ```
   不需要文字的纯裁切：`bash scripts/fit.sh creative/raw/x.png 1200x628 creative/out/x-1200x628.jpg cover`（主体会被裁时改用 `contain F5F5F5`）。视频：`fit.sh in.mp4 1080x1920 out-1080x1920.mp4`（需 ffmpeg）。
4. **核验**：
   - `python3 scripts/export_check.py creative/out --brief creative/brief.md` → 全部“通过”，退出码 0；
   - 每张成品 `view_image`（小字用 `detail: original`）：逐字对照 `copy.md`、文字不溢出 / 不被裁、对比度足够、关键信息在安全区内、logo 清晰；
   - 视频：`ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of json <文件>`，并抽帧 `view_image`。
   有问题 `file_edit` 调整后重新渲染与核验。
5. **交付文档**：`doc_write creative/交付说明.md`（或 .docx）：简报摘要、每个成品用途 / 尺寸 / 路径、看板中的选择记录、字体与授权提醒、待确认事项。
6. **打包（可选）**：`ask_user` 确认后 `shell_run`：`cd creative && zip -r ../creative-delivery.zip out layout 交付说明.md board`。

## 工具与参数要点
- `render.sh` 尺寸参数为 `宽x高`（小写 x）；输出必须是 .png。
- `fit.sh` 的 `cover` 填满后居中裁切，`contain` 等比缩放后补边；sips 路径输出 png/jpg/tiff/heic。
- `export_check.py --manifest <路径>` 自定义清单位置；文件名中没有 `WxH` 的文件只记录不比对。

## 质量检查
- `export_check.py` 退出码 0，manifest 中 `failed: 0`。
- 每张成品都经 `view_image` 实际查看；成品上的全部文字都能在 `copy.md` 中找到。

## 失败回退
- 没有 Chrome：用 `browser_automation` 打开 HTML，按目标尺寸 `resize` 视口后截图，再用 `fit.sh` 校正到精确尺寸，`export_check.py` 核验。
- 没有 ffmpeg/ffprobe：图片用 `sips`（`fit.sh` 自动切换，尺寸用 `sips -g pixelWidth -g pixelHeight` 读取）；视频无法本地转码时说明需安装 ffmpeg，或让 `generate_video` 按目标画幅重新生成，并如实说明未本地核验。
- 字体缺失导致字形回退：换用系统字体栈，并在交付说明中注明。

## 交付格式
1. 先给用户看成品（逐个一句话：用途 + 尺寸），指出需确认的文字信息。
2. 附：`creative/out/` 成品、`manifest.json`、`交付说明`、可编辑源 `creative/layout/*.html`，打包时附 zip 路径。

## 安全
- 字体版权：商用前提醒用户确认第三方字体授权。
- 价格、活动时间、免责声明以用户提供为准，逐字核对。
- 模板只引用本地资源，不嵌入不可信外部脚本。覆盖已有成品或打包前先 `ask_user`。
