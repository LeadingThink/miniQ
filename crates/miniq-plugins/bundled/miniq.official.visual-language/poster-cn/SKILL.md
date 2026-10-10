---
name: poster-cn
displayName: 中文海报与封面
description: 当用户要做活动海报、公众号封面（900×383）、小红书封面（1242×1660）、朋友圈海报（1080×1920）、直播预告海报等带插画底图的中文宣传图时使用；流程为收集信息 → generate_image 生成无文字底图 → HTML 叠加文字层 → 浏览器截图导出 PNG → view_image 核对文字。不用于以数据/要点为主的信息图或多页演示。
version: 1
origin: installed
requires:
  bins: [python3]
---

# 中文海报与封面

## 适用场景
- 用户原话示例：
  - "帮我做一张周六读书会的活动海报，发朋友圈。"
  - "这篇文章要个公众号封面图，国风一点。"
  - "做个小红书封面，标题是'三天学会 Excel 透视表'。"
  - "周四晚 8 点直播，做张预告海报，要有二维码。"
- 输出：底图 PNG + 单文件 HTML（文字层，可继续编辑）+ 最终合成 PNG。
- 不适用：以数字、步骤、对比为主的内容（`infographic-cn`）；多页演示（`web-deck-cn`）；纯排版文档（`cn-typography`）。

## 前置条件
1. 先读 `../visual-language-core/SKILL.md` 与 `../visual-language-core/references/tokens.md`；字体栈与主色板按其约定。
2. 读 `references/styles.md`，选一种风格方向并套用提示词模板。
3. `generate_image` 可用（会产生一次图像生成调用，动手前告知用户）。
4. `browser_automation` 不支持 `file://`，导出前需起本地 http 服务。
5. 默认落点 `<工作区>/海报/<主题>/`，内含 `bg.png`、`poster.html`、`poster.png`；同名存在先 `ask_user`。

## 步骤

### 1. 收集信息
一次性用 `ask_user` 问清（已知的不重复问）：
- 主题 / 主标题（≤ 12 字）、副标题或一句话卖点（≤ 24 字）。
- 时间（`YYYY-MM-DD HH:mm`，口头"本周六"要换算成具体日期并复述确认）、地点或平台。
- 主办方 / 品牌名；Logo 文件路径；二维码图片路径（没有就留占位框并说明）。
- 用途与尺寸（见下表）；风格关键词（国风 / 极简 / 科技 / 手绘 / 商务，详见 `references/styles.md`）；品牌主色（无则按风格默认）。

| 用途 | 尺寸（px） | 安全区 | 备注 |
|---|---|---|---|
| 公众号封面 | 900×383 | 中间 383×383 为头条缩略区 | 标题 ≤ 10 字，放左侧或居中 |
| 小红书封面 | 1242×1660 | 四边各 80px | 标题可大到 120px，3 行以内 |
| 朋友圈 / 竖版海报 | 1080×1920 | 顶部 160px、底部 200px 留空 | 二维码放底部居中或右下 |
| 直播预告 | 1080×1920 或 1080×1350 | 同上 | 必含：时间、平台、主播 / 嘉宾、二维码 |
| 活动海报（打印 A3/A4） | 2480×3508（A4 @300dpi） | 四边 ≥ 120px | 导出时 `--force-device-scale-factor` 调高 |

### 2. 生成底图（`generate_image`）
- 提示词 = `references/styles.md` 的风格模板 + 主题意象 + 构图留白要求。**必须写明**："画面中不出现任何文字、字母、数字、水印、Logo"，并指定文字预留区（如"上三分之一留空、底部留空"）。
- `size` 选与目标比例最接近的；比例不一致时在 HTML 中用 `background-size: cover` 裁切，并把主体放在不会被裁的一侧。
- 生成后 `view_image` 检查：有没有误生成的文字 / 乱码字符、主体是否挡住文字预留区、色调是否与主色协调。有问题就 `edit_image`（如"去掉右上角的文字"）或换提示词重生，最多三次。
- 保存为 `<落点>/bg.png`。

### 3. HTML 叠加文字层
用 `file_write` 写 `poster.html`：
```html
<style>
/* 粘贴 tokens.md 令牌；--primary 换成本海报主色 */
html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; }
.poster { position: relative; width: 100%; height: 100%; background: url(./bg.png) center/cover no-repeat; font-family: var(--font); color: #fff; }
.scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,.55) 100%); }
.title { position: absolute; left: 80px; top: 200px; font-size: 96px; font-weight: 600; line-height: 1.2; letter-spacing: .02em; text-shadow: 0 2px 12px rgba(0,0,0,.25); }
.sub { position: absolute; left: 80px; top: 460px; font-size: 36px; line-height: 1.5; opacity: .92; }
.meta { position: absolute; left: 80px; bottom: 260px; font-size: 32px; line-height: 1.8; font-variant-numeric: tabular-nums; }
.tag { display: inline-block; padding: 8px 20px; border-radius: 999px; background: var(--primary); color: var(--primary-fg); font-size: 28px; }
.qr { position: absolute; right: 80px; bottom: 120px; width: 220px; height: 220px; background: #fff; border-radius: 16px; padding: 12px; }
.qr img { width: 100%; height: 100%; display: block; }
.brand { position: absolute; left: 80px; bottom: 120px; display: flex; align-items: center; gap: 16px; font-size: 26px; }
.brand img { height: 56px; }
</style>
```
- 文字全部是 HTML 文本；Logo、二维码用 `<img>` 引用用户给的本地路径（复制到落点目录后用相对路径）。
- 底图偏亮时用深色文字并去掉 `.scrim`；偏暗时用白字 + 渐变遮罩。对比度 ≥ 4.5:1（大标题 ≥ 3:1）。
- 标题允许用更有表现力的字重（600–800），但仍是中文字体栈；不用斜体、不用渐变文字、不描边堆叠。
- 日期格式：`10 月 18 日（周六）19:30`；数字与汉字之间留空格。

### 4. 截图导出
1. `shell_run`（`runInBackground: true`）：`python3 -m http.server 0 --directory <落点>`，`process_output` 读端口。
2. `browser_automation`：`resize` 到目标尺寸 → `open http://127.0.0.1:<端口>/poster.html` → `wait 800` → `screenshot`，保存为 `poster.png`。
3. 需要 2x 高清或 A4 300dpi 时改用 Chromium headless：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
     --window-size=1080,1920 --force-device-scale-factor=2 \
     --screenshot="<落点>/poster@2x.png" "http://127.0.0.1:<端口>/poster.html"
   ```

### 5. 核对（`view_image`，用 `detail: original`）
- 每个字逐一核对：无错字、无方块、无被底图抢眼处遮挡、标题不被安全区外裁掉。
- 时间 / 地点 / 平台 / 主办方与用户给的信息一字不差；二维码清晰可扫（四角完整、白底）。
- 底图没有生成出的伪文字；只有一个主色。
- 不合格就改 HTML 或底图再截，最多三轮。结束后 `kill` 服务进程、关闭标签页。

## 注意事项 / 安全
- 底图由 AI 生成：不要生成真实人物肖像、他人商标、名人形象；用户要求用真人照片时让其提供文件。商用前提醒核对图像生成服务的授权条款。
- 二维码、Logo 只用用户提供的文件；不生成假二维码、不臆造联系方式。缺失时留虚线占位框并在交付时说明。
- 公众号封面中间 383×383 区域会被裁成头条缩略图，关键文字必须在此区域内或完全避开。
- 若用户要"可编辑源文件"：说明 miniQ 交付的是 HTML 源文件（文字、位置、颜色可直接改，改完重截即可），不输出 PSD/AI；需要 Canva/Figma 可编辑稿时提示切换到对应连接器技能。
- 覆盖已有文件先 `ask_user`；文件名不含空格。

## 如何确认完成
- 回复给出 `bg.png`、`poster.html`、`poster.png` 的绝对路径与尺寸。
- 一句话说明：风格方向、主色、底图提示词要点（便于用户复用）。
- 核对结论：文字已逐字核对、时间地点无误、二维码 / Logo 已嵌入或留占位；以及"HTML 可继续编辑"的提示。
