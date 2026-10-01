---
name: product-design-prototype
description: 构建可点击、核心交互可用的本地产品原型（导航、Tab、表单、加载/空/成功态），支持单文件 HTML 或现有前端项目；用户要做原型、demo、可点击稿、把方向或流程做出来时使用，交付前必须经过设计 QA
version: 1
---

# 可交互原型

把已确定的目标（和视觉方向）做成**能点、能填、能看到状态变化**的本地原型。原型不是静态截图：核心路径要走得通，但不接真实登录与后端。

## 触发场景

- “做个原型/demo/可点击稿”“把这个流程做出来看看”
- `product-design-ideate` 选定方向之后需要多屏可交互版本
- 用户要在现有前端项目里加一个新页面原型

## 前置条件

- 已通过 `product-design-brief` 关卡；高保真时已有视觉参考（选定方向图、用户截图或现有设计系统）。
- 已运行预检：`python3 ../product-design-user-context/scripts/preflight.py check --workspace <工作区>`，拿到可用工具与空闲端口。
- 已读：`../product-design-router/references/critical-rules.md`、`../product-design-router/references/local-preflight.md`；在现有代码库中工作时读 `../product-design-router/references/existing-codebase.md`。
- 构建规范与交互清单见 `references/build-guide.md`。

## 分步流程

1. **选技术路线**（详见构建规范）：
   - 工作区已有前端项目 → 在项目里加页面/路由，复用现有组件与 token。
   - 没有项目、1–6 屏 → 单文件 HTML：复制 `scripts/prototype-template.html` 到 `design/prototype/index.html`。
   - 屏幕多、状态复杂、用户要求 React/Vue → 用 `shell_run` 初始化 Vite 项目（需 node；先告知用户会安装依赖）。
2. **发构建预告**：开工前发一条消息，说明要做哪几屏、哪些交互可用、预计耗时（单文件约几分钟，Vite 项目约 10–20 分钟）。
3. **列屏幕与状态清单**：在 `design/prototype/README.md` 写屏幕列表、每屏的状态（默认/加载/空/错误/成功）、屏幕间跳转、明确不做的部分。
4. **定 token**：把参考图或现有设计系统的颜色、字号、圆角、间距、阴影写进 `:root` 变量（或项目的主题文件）。从参考图取色时用 `view_image`（`detail: original`）仔细看，不凭印象。
5. **准备资产**：列出所有图片槽位及尺寸（按显示尺寸的 2 倍）。插图、照片、产品图用 `generate_image` 按槽位比例生成，保存到 `design/prototype/assets/`；Logo、图标优先用用户提供的或项目里已有的；图标可用开源图标库。禁止 emoji、ASCII、CSS 画图或手写 SVG 冒充资产。每张生成图 `view_image` 核验。
6. **实现**：`file_write` / `file_edit` 编写页面。按构建规范完成交互清单：导航与返回、Tab、表单校验与提交、hover/focus/active、加载/空/错误/成功态；数据用贴近真实的模拟数据；文案用用户语言。
7. **本地预览**：`shell_run` 后台启动 `python3 scripts/serve.py --dir design/prototype --port <空闲端口>`（Vite 项目用 `npm run dev -- --port <端口>`），记录地址。
8. **自测**：用 `browser_automation` 打开预览，在目标视口下逐屏截图并实际点击核心路径（提交表单、切 Tab、触发空态），截图用 `view_image` 检查布局、溢出、文字截断、图片加载、控制台报错。
9. **设计 QA（阻塞）**：交给 `product-design-qa`，与参考图同视口同状态并排比较，修复 P0–P2 直至 `final result: passed`。未通过前不得宣称完成。
10. **交付**：见下方交付格式；附一句分享提示（需要给别人看时可走 `product-design-share`）。

## 工具与参数要点

- `file_write`：新建页面与 README；`file_edit`：小范围修改，避免整文件重写导致回退。
- `generate_image`：`size` 取槽位比例最接近的尺寸；提示词写清内容、风格与“无文字/无水印”（除非图中需要文字）。
- `shell_run`：启动服务器要后台运行；安装依赖前告知用户；不执行与原型无关的全局安装。
- `browser_automation`：`resize` 到目标视口（手机 390×844、平板 834×1194、桌面 1440×1024）再截图；可用 `#屏幕id`、`?state=empty`、`?frame=0` 直达模板中的各屏与状态。
- `view_image`：每张自测截图都要看，小字用 `detail: original`。

## 质量检查

- 核心路径可从首屏一路点到成功态；所有 `data-go` 目标存在；表单空提交有错误提示。
- hover、focus-visible 可见；可键盘操作 Tab 与按钮；触控目标 ≥ 44px。
- 无占位灰块、无 lorem ipsum、无破图；图片来自生成或真实素材。
- 浏览器控制台无报错；目标视口下无横向滚动、无文字溢出。
- `product-design-qa` 输出 `final result: passed`。

## 失败回退

- 没有 python3：用 `npx -y serve design/prototype -l <端口>`；两者都没有时直接给出 `index.html` 路径，让用户双击打开（说明部分功能如相对路径图片可能受限）。
- 没有 node 但用户要 React：说明原因，改用单文件 HTML，保留同样的交互。
- 截图失败：先重试一次（换端口或重启服务器）；仍失败则 QA 记为 `final result: blocked` 并停止，如实告诉用户。
- `generate_image` 失败：改用用户提供的素材或开源图库中的真实图片（注明来源）；都没有时保留明确标注“待替换”的纯色区域，并在交付中列为未完成项，不假装完成。

## 交付格式

- 文件：`design/prototype/`（index.html 或项目页面、assets/、README.md）、`design/qa/design-qa.md`。
- 消息（先讲结果）：
  1. 一句话：做好了什么、在哪里看（本地地址）。
  2. 2–4 条：可用的交互与状态、QA 结果、已知后续项（P3）。
  3. 一句分享提示：“需要发给别人看的话，我可以帮你打包或部署。”
  4. 恰好一个下一步建议。
