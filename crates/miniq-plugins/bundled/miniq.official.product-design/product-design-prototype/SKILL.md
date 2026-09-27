---
name: product-design-prototype
description: 当用户需要把产品想法或页面清单快速做成低保真线框图或可点击的 HTML 原型，并在浏览器中演示或截图时使用
origin: installed
---

# HTML 线框图与可点击原型

## 适用场景
- 把 `design/brief.md` / `design/flows.md` 中的页面清单做成可点击原型，用于评审或用户访谈。
- 快速对比 2-3 种布局方案。

## 前置条件
- 只需本地浏览器（`browser_automation`）；不依赖任何构建工具，纯 HTML/CSS/少量 JS。
- 本技能自带起步模板 `scripts/prototype-template.html`（单文件、多屏切换）。

## 步骤
1. **确认范围**（`ask_user`）：保真度（灰阶线框 / 带品牌色的高保真）、设备（手机 390×844 / 桌面 1440×900）、需要的页面与主流程。
2. **读取输入**（`file_read`）：简报、流程图、已有品牌规范；模板 `scripts/prototype-template.html`。
3. **生成原型**（`file_write`，默认 `design/prototype/index.html`）：
   - 基于模板，每个页面是一个 `<section class="screen" id="...">`，通过 `data-go="目标id"` 实现点击跳转，URL hash 同步当前页（便于直接打开某页）。
   - 线框阶段用灰阶、系统字体、占位框（`.ph`）代替图片，文案写真实内容而不是 “Lorem ipsum”。
   - 覆盖空状态、加载中、错误提示等关键状态；触控目标不小于 44×44px。
   - 高保真阶段需要插图时可用 `generate_image` 生成并放到 `design/prototype/assets/`。
4. **截图自检**（`browser_automation`）：打开 `file:///绝对路径/design/prototype/index.html#<页面id>`，设置视口为目标设备尺寸，逐页截图；再用 `view_image` 检查对齐、层级、文字截断、对比度。
5. **走查主流程**（`browser_automation` 点击 `data-go` 元素）：确认每条流程都能从入口走到终点，没有死链。
6. **多方案（可选）**：同一页面输出 `index-a.html`、`index-b.html`，并排截图给用户对比。
7. **交付**：说明文件路径和演示方式（浏览器直接打开）；需要评审时接 `product-design-review`。

## 注意事项 / 安全
- 原型是示意，不接入真实后端、不收集真实用户数据；表单只做前端假交互。
- 引用外部 CDN 时说明离线可能不可用；优先内联样式。
- 覆盖已有原型文件前 `ask_user` 确认。
