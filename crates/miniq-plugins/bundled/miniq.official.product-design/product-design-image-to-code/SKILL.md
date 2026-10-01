---
name: product-design-image-to-code
displayName: 图片还原为代码
description: 把截图、设计稿、效果图或手绘草图高保真还原成可运行的前端页面。用户给图片要求照着做、还原、切图、转代码，或 ideate 选定方向后要落地时使用；以匹配原图为准不自行改进，完成后必须经设计 QA 并排比对
version: 1
---

# 图片还原为代码

目标是**像素级接近原图**，并让图中的交互元素真正可用。原图就是规格：不“优化”配色、不改布局、不换文案，除非用户要求。

## 触发场景

- “照这张图做出来”“把设计稿转成 HTML/React”“切图”
- 用户上传 App/网页截图、Figma 导出图、生成的方向图、手绘草图
- `product-design-ideate` 定稿后的高保真落地

## 前置条件

- 至少一张可读取的图片；多屏时每屏一张。
- 已通过 `product-design-brief` 关卡（通常一句话复述即可：“按原图 1:1 还原为 <技术路线>，视口 <宽×高>”）。
- 已运行预检；现有代码库中工作时先读 `../product-design-router/references/existing-codebase.md`。
- 还原检查清单见 `references/fidelity-checklist.md`。

## 分步流程

1. **看图并量取**：对每张图用 `view_image`（先 `high` 看整体，再 `detail: original` 看细节）。记录：画布尺寸（推断视口：宽≈390/375 为手机，≈1440/1280 为桌面）、网格与边距、区块顺序、字号层级、颜色、圆角、阴影、图标风格、所有文案原文。
2. **写规格表**：`file_write` 到 `design/qa/spec-<屏名>.md`，列出区块树、token、资产槽位、可交互元素。拿不准的值写“估计”并在 QA 时重点核对。
3. **发构建预告**：一句话说明还原哪几屏、技术路线、预计耗时。
4. **准备参考图**：把原图复制到 `design/qa/reference/<屏名>.png`（`shell_run cp`），作为 QA 基准。
5. **资产**：
   - 图中的照片/插画/产品图：用 `generate_image` 按槽位比例生成内容与构图相近的替代图；或在用户提供原始素材时直接使用。
   - 图标：用开源图标库中形状最接近的图标；Logo 用用户提供的文件，没有时用文字 Logo 并在交付中注明。
   - 不用 emoji、CSS 画图或手写 SVG 冒充图中资产。
6. **实现**：技术路线同 `product-design-prototype`（现有项目 > 单文件 HTML > Vite）。先搭布局骨架，再填 token 与文案，最后做交互（按钮 hover/focus、导航、Tab、表单等图中可见控件都要可用）。文案逐字照抄原图。
7. **预览并截图**：`shell_run` 启动 `../product-design-prototype/scripts/serve.py`；`browser_automation` 把视口设为与原图一致，截图到 `design/qa/screenshots/<屏名>.png`。
8. **设计 QA（阻塞）**：交给 `product-design-qa`：参考图与截图同视口并排比较，修 P0–P2 并循环，直到 `final result: passed`。
9. **交付**。

## 工具与参数要点

- `view_image`：小字、1px 边框、颜色取值必须用 `detail: original`；可对局部裁剪图（`shell_run` 用 python 标准库无法裁 PNG 时，直接多次观察并描述位置）。
- `generate_image`：只替代图中的图片内容，不生成整页；`size` 与槽位比例一致。
- `browser_automation`：`resize` 到原图的 CSS 像素尺寸（Retina 截图宽度除以 2 或 3）。
- `file_edit`：QA 修复时做小改动，避免整文件重写。

## 质量检查

- 与原图并排比较：布局、间距、字号、颜色、圆角、文案一致；差异都已在 `design-qa.md` 中记录并处理到 P3 以下。
- 图中所有可交互元素都可用；hover/focus 有反馈。
- 没有“自作主张的改进”；如果确实发现原图有问题（如对比度不足），只在交付中作为建议提出。

## 失败回退

- 图片模糊或被裁切：说明看不清的部分，用 `ask_user` 请用户补图；用户说继续则按合理推断实现并在 QA 中标注。
- 手绘草图：先确认保真度（线框还是高保真），高保真时转 `product-design-ideate` 先出视觉方向。
- 截图工具不可用：QA 写 `final result: blocked`，停止并告诉用户需要什么才能继续。

## 交付格式

- 文件：实现代码、`design/prototype/assets/`、`design/qa/reference/`、`design/qa/screenshots/`、`design/qa/design-qa.md`。
- 消息：一句话结果与本地地址；QA 结论与剩余 P3；与原图的已知差异（如字体替代、Logo 待提供）；一句分享提示；恰好一个下一步。
