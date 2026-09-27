---
name: creative-layout-deliver
description: 当用户要把已生成的图片素材和文案排版成海报、社媒图、横幅或多尺寸成品并打包交付时使用
origin: installed
---

# 排版成品与交付

## 适用场景
- 把主视觉 + 标题 + 卖点 + CTA + logo 排成海报、小红书封面、朋友圈图、电商主图、Banner。
- 同一设计一次输出多个尺寸（如 1080x1350、1080x1920、1200x628）。
- 汇总所有素材与说明，生成交付清单或提案文档。

## 前置条件
- 素材与文案已就绪（通常来自 `creative-asset-produce`）。
- 渲染 PNG：本机有 Chrome / Chromium / Edge 任一（脚本自动查找）；没有时退回 `browser_automation` 打开 HTML 截图后人工核对。
- 本技能自带 `scripts/layout.html`（CSS 变量驱动的排版模板）与 `scripts/render.sh`（无头浏览器截图）。

## 步骤
1. **准备模板**：`file_read scripts/layout.html`，复制到 `creative/layout/<名称>.html`（`file_write`），用 `file_edit` 修改：
   - 顶部 `:root` 变量：`--w`/`--h` 画布尺寸、`--brand`/`--ink`/`--paper` 颜色、字体；
   - `.hero` 的背景图路径（相对 HTML 文件）、标题/副标题/卖点/CTA 文案、logo 路径；
   - 版式：`data-layout="top"`（文字在上）或 `"bottom"`（文字在下），根据主视觉的留白位置选择。
2. **渲染**：`shell_run`：
   ```bash
   bash scripts/render.sh creative/layout/poster.html 1080x1350 creative/out/poster-1080x1350.png
   ```
   多尺寸时对每个尺寸各跑一次（脚本会通过 URL 参数 `?w=&h=` 覆盖画布尺寸）。
3. **视觉检查**：`view_image`（小字用 original 细节）逐张检查：文字是否溢出/被裁、与背景对比度是否足够、logo 是否清晰、安全区（上下各约 8%）内是否有关键信息。问题用 `file_edit` 调整后重渲染。
4. **可编辑源文件**：HTML 本身就是可编辑源；若用户需要 Figma/Canva 继续编辑，可交给 `figma-design-to-code` 或 `canva-design-studio`。
5. **交付**：
   - `doc_write` 生成 `creative/交付说明.docx`（或 .md）：简报摘要、每个成品的用途/尺寸/路径、使用的字体与授权说明、待确认事项；
   - 需要打包时，先 `ask_user` 确认后 `shell_run`：`cd creative && zip -r ../creative-delivery.zip out 交付说明.docx`。

## 注意事项 / 安全
- 字体版权：模板默认使用系统字体栈（PingFang SC / Noto Sans CJK / 思源黑体等）；商用成品中使用第三方字体前提醒用户确认授权。
- 法务元素（价格、活动时间、免责声明）以用户提供为准，逐字核对。
- 渲染脚本只访问本地文件；不要在模板中引用不可信的外部脚本。
- 覆盖已有成品文件或打包前先 `ask_user`。
