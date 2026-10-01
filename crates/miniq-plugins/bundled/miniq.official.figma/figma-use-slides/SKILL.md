---
name: figma-use-slides
description: 在 Figma Slides 演示文稿中创建、修改、整理幻灯片时使用：用户给出 figma.com/slides/ 链接，或要求做演示文稿/幻灯片、分节、排序、跳过页、写讲者备注。需与 figma-use 一起加载。
version: 1
---

# Figma Slides：用 `use_figma` 制作与编辑演示文稿

本技能只补充 **Slides（`figma.com/slides/...`）场景特有** 的规则。通用的 Plugin API 执行规则（顶层 `await`、用 `return` 返回结果、不调用 `figma.closePlugin()`/`figma.notify()`、字体加载、返回所有被修改节点 ID、预检清单等）以同插件的 **`figma-use`** 技能为准——动手前必须先读 `figma-use`，本技能在其基础上叠加。

## 触发场景

- 用户粘贴 `https://www.figma.com/slides/<fileKey>/<名称>?node-id=...` 链接，要求新增/修改/美化幻灯片。
- 用户要求"做一份演示文稿 / PPT / deck / 幻灯片"，并希望产出在 Figma Slides 中。
- 整理已有 deck：分节（section）、重新排序、复制页、删除页、设置跳过页、写讲者备注。
- 以某个 Figma 文件（Slides 或 Design）为参考风格制作新 deck。

不适用：普通设计文件（`figma.com/design/...`）的画板设计 → 只用 `figma-use`；把设计还原为代码 → `figma-design-to-code`。

## 前置条件

1. **MCP 连接器**（二选一，先 `tools/list` 探测）：
   - `figma`：经 `npx mcp-remote` 连接 `https://mcp.figma.com/mcp`，首次调用需在浏览器完成 OAuth 登录。Figma 只允许其 MCP 目录内的客户端连接，miniQ 可能被拒（403 / 客户端未授权）。
   - `figma-desktop`：本地 `http://127.0.0.1:3845/mcp`，需安装 Figma 桌面应用、打开目标文件并在 Dev Mode 中启用 MCP 服务器。
2. **写入权限**：当前账号对目标 Slides 文件必须有编辑权限，否则 `use_figma` 的写操作会失败。
3. **两者都不可用时**：明确告诉用户"当前无法直接写入 Figma"，改为交付：幻灯片规划（逐页内容与版式）+ 可在 Figma 中通过插件/开发者控制台手动执行的 JS 脚本，并说明执行方式与限制。不要假装已写入。
4. 修改用户文件前，按插件约定先向用户确认（`ask_user`），说明将改动哪些页。

## 调用方式（miniQ `mcp_call`）

先列工具，确认实际参数名：

```json
{"server":"figma","tool":"tools/list","arguments":{}}
```

执行脚本（参数以 `tools/list` 返回为准；若 schema 中有 `skillNames` 字段，填 `"figma-use,figma-use-slides"`，仅用于日志）：

```json
{"server":"figma","tool":"use_figma","arguments":{"fileKey":"<从 /slides/ 后一段取>","code":"const grid = figma.getSlideGrid(); return grid.map(r => r.map(s => s.id));","description":"读取幻灯片网格"}}
```

本场景会用到的工具（以对标能力为准）：

| 工具 | 用途 | 要点 |
|---|---|---|
| `use_figma` | 读写 Slides 的唯一主通道 | 只返回 `return` 的值，`console.log` 不回传 |
| `get_screenshot` | 视觉校验某页 | 传有效 `nodeId`（幻灯片 ID）；也可在脚本内 `await slide.screenshot()` |
| `create_new_file` | 新建 Slides 文件 | 新文件自带默认浅色主题，但网格为空（0 行 0 页） |
| `upload_assets` | 往幻灯片放图片的**唯一**支持方式 | 带 Slides `fileKey`；返回一次性上传 URL，POST 原始图片字节；传 `nodeId`+`count:1` 作为已有节点填充，省略 `nodeId` 则作为新图层放到幻灯片上 |
| `get_design_context` | 读取**Design 文件**参考稿的颜色/字体/结构 | 对 Slides 文件用 `use_figma` 只读脚本代替 |
| `generate_deck`（若存在） | 用内置模板一次生成整套 deck | 不支持自定义模板、参考文件、后续迭代；与 `use_figma` 二选一 |
| `get_metadata` | **不支持 Slides 文件** | 只能用于 Design 文件，别在 Slides 上调用 |

### `generate_deck` 与 `use_figma` 的取舍

- 默认用 `use_figma` + 本技能：能覆盖新建、改稿、品牌匹配、参考文件风格、迭代修改、讲者备注。
- 仅当用户要"快速出一份普通 deck"、无品牌/参考/后续修改需求，且环境确实提供 `generate_deck` 时才考虑它。
- **每个 deck 只选一种方式并坚持到底**，不要先 `generate_deck` 再用 `use_figma` 另建或填充，会产生重复且冲突的产物。

## Slides 关键规则（务必遵守）

1. **新文件的默认浅色主题只是脚手架**：用 `create_new_file` 建的 Slides 文件会初始化默认浅色主题，应按本 deck 的设计方向覆盖其颜色变量和文字样式，不要被默认 token 左右。
2. **每个节点都先 `appendChild` 再设置 `x`/`y`，每一层嵌套都如此**。新建节点会被隐式挂到一个原点在绝对坐标 `(240, 240)` 的幻灯片上下文（网格的 `GRID_PADDING`）；先设坐标再挂载，节点最终会落在"期望值 − 240"。此问题**时有时无**，一次测试通过不代表安全。发现偏移 `(−240, −240)` 时修正调用顺序，**绝不**靠加 240 补偿。详见 `references/slide-gotchas.md`。
3. **`SLIDE_GRID`、`SLIDE_ROW` 是不透明节点**：不要读写它们的 `fills`、`effects`、布局属性；只有 `SLIDE` 节点具备 frame 能力。唯一例外：`SLIDE_ROW.name` 可写，用来给分节命名。
4. **`get_metadata` 不支持 Slides**：结构校验用 `use_figma` 只读脚本，返回节点位置并检查包围盒重叠；视觉校验用截图。
5. **不要调用 `figma.createPage()`**：在 Slides 中会抛 `TypeError`（它只属于 Design 文件）。用幻灯片网格（行=分节，页=幻灯片）组织结构。
6. **改稿不要删页重建**：用户要求"优化/重设计/换风格"时原地修改现有页；只有用户明确说"推倒重来/从头做"才删除。

## 设计强度分档

动手前先判断任务属于哪一档：

- **内容/属性微调**（改字、换色、改数字、对齐、缩放）：不做设计推演，直接改并与现有风格保持一致。
- **结构性增补**（加页、重排某节版式、换配色、加新视觉元素，包括"优化/重设计"现有 deck）：**继承模式**——先跑检查脚本并截图，读出现有配色、字体、空间习惯、母题，然后延续它们。
- **新建 deck**：完整设计流程（见下）。

### 新建 deck 的设计思考

1. **读懂需求**：讲什么、讲给谁（融资路演、团队复盘、产品发布、技术分享的视觉处理各不相同）。
2. **先找已有设计语言**：用户提供的品牌规范（色板、字体、Logo 规则、语气）和参考 Figma 文件都是已做出的决定，要研究而非扫一眼。用户给得越具体，你自己发明得越少——此时你是"诠释者"而非"设计者"。
3. **在剩余空间里表态**：用户给了完整品牌系统，你只在版式、节奏、构图上发挥；只给一张参考页，可以更自由但要呼应其气质；什么都没给，就由你决定配色、字体和空间组织，并贯彻全篇。
4. **给 deck 一个签名元素**：一个脱离上下文也能认出的特征（独特配色、出人意料的版式节奏、重复的形状语言）。有品牌时从品牌里放大已有元素，而不是外加陌生元素。

### 读取参考文件

- **参考是 Slides 文件**：`get_metadata` 不可用。用 `get_screenshot` 截若干页，再用 `use_figma`（传参考文件的 `fileKey`）跑只读脚本提取主题变量、配色、字体、版式习惯。
- **参考是 Design 文件**：`get_design_context` 取结构化设计数据 + `get_screenshot` 取视觉。
- 关注：主色与强调色、深浅背景的用法、字体家族/字重/层级、内容锚点与留白、是否出血、重复母题。
- 贴近程度按用户措辞："做成这样"=复刻设计语言换内容；"参考灵感"=呼应气质；"这是我们的品牌 deck"=提取品牌系统并一致应用。拿不准时更贴近参考。

## 分步流程

### 0. 解析与探测
- 从链接取 `fileKey`（`/slides/` 后一段）；`node-id=1-2` 在参数中写作 `1:2`。
- `tools/list` 确认服务器与参数；失败换 `figma-desktop`；都不行按"前置条件 3"降级。

### 1. 先检查再动手（只读）
- 用只读 `use_figma` 列出所有页（ID、名称、所在行列、是否跳过、讲者备注）及目标页的文本内容。脚本见 `references/slide-structure.md` 与 `references/slide-content.md`。
- 对要改的页截图，了解现状。

### 2. 规划（新建 5 页及以上的 deck 必做，且在写任何代码之前完成）
1. **逐页计划**：每页的目的/内容、用空间语言描述的版式（如"标题锚定左上，参数卡占右侧三分之一，装饰圆从右上角出血"）、背景处理（深/浅/渐变）。规划阶段**不算像素坐标**。
2. **共享常量**：字体家族与字重；以角色命名的色板（primary、accent、bgDark、surface、textPrimary、textMuted…）；签名母题。
3. **版式多样性检查**：按顺序读一遍描述，若出现"双栏、双栏、网格、双栏"这类重复，现在就调整。
4. **代码前导**：写好每个构建脚本都要粘贴的前导——色板对象、`Promise.all` 批量加载字体、"先挂载后定位"的辅助函数（模板见 `references/slide-gotchas.md`）。

### 3. 构建（大批量）
- **每次 `use_figma` 构建 3–5 页**；结构相似的页可放同一批。每页是独立子树，大批量是安全的。
- 每个构建脚本开头**原样粘贴**第 2 步的前导，不要每次重新推导。
- **批次之间不重新规划**：本批通过校验就直接做下一批；只有失败或出现视觉问题才调整方案。
- 每个脚本都 `return` 新建/修改的全部节点 ID（含幻灯片 ID）。
- 单页复杂构建（数据图表、复杂一次性版式）则在该页内分步：先背景与骨架 → 内容 → 装饰，每步之间校验。

### 4. 校验
- **每批之后**跑 `references/slide-gotchas.md` 中的批量校验脚本（检查兄弟节点重叠、文字超出容器、越出 1920×1080 画布）。`clean` 为真则直接继续，不必截图。
- 校验失败：截图问题页，修正后再继续。
- **检查点截图**：第一批之后（确认配色、字体、设计方向）和最后一批之后（整体质量），每次 1–2 张代表页，优先在脚本内 `await slide.screenshot()`。

### 5. 分节、备注与收尾
- 分节：见下文"分节"。讲者备注：仅在用户要求或明确要"可直接上台讲"的 deck 时写，写法见 `references/slide-content.md`。
- 如需让编辑器聚焦到某页，可设置 `figma.currentPage.focusedSlide`。

## 分节（Sections）

幻灯片网格中每一行就是一个分节；名称显示在编辑器行旁和演讲者视图中（讲者可在分节间跳转）。分节是给编辑 deck 的人用的组织工具，断点归用户所有。

- 用户说"整理一下这个 deck"含义模糊（分组？排序？去重？重构？）。**默认先读 deck 再提方案**：封面/结尾、编号案例、成对的"之前/之后"、过渡页、"谢谢"等线索足够时，直接给出一种分节方案，用一条确认消息呈现；方案中可逆的小决定自己拍板。
- **缺乏线索时再问**：页序杂乱、没有主线时，询问哪些页属于一组、叫什么名。不要用"平均分三份"代替阅读。
- 命名：1–3 个词、具体（"演示"优于"展示与分享"）、全篇风格一致；通常 2–5 节，长 deck 才更多。节名不是页标题。
- **改名必须作用在真实的 `SLIDE_ROW` 节点上**：`figma.getSlideGrid()` 返回的内层数组只是普通 JS 数组，给它设 `.name` 静默无效。

```js
const gridNode = figma.currentPage.children.find(n => n.type === "SLIDE_GRID");
const names = ["开场", "问题", "方案", "收尾"];
gridNode.children.forEach((row, i) => { if (names[i]) row.name = names[i]; });
return { renamedRows: gridNode.children.map(r => ({ id: r.id, name: r.name })) };
```

## 质量检查与失败回退

- **脚本原子性**：一次 `use_figma` 调用出错时视为整体未生效，先读完整错误信息再改代码重试，不要盲目重复同一脚本；也不要在失败后假设部分节点已存在——重跑前用只读脚本确认现状。
- 报错 `Cannot write to node with unloaded font "..."`：补 `loadFontAsync`（注意样式名如 `"Semi Bold"` 含空格，不确定就 `listAvailableFontsAsync()` 查）。
- 报错 `no such property 'fills' on SLIDE_GRID/SLIDE_ROW`：改为操作 `SLIDE` 节点。
- 报错 `figma.createPage ...`：改用网格结构。
- 节点整体偏移 `(−240, −240)`：修正"先挂载后定位"顺序，并读回坐标验证。
- 连续两次同类失败：停下来向用户说明问题与已尝试的方法。
- 交付前：批量校验 `clean`、检查点截图过目、所有新建/修改的节点 ID 已记录。

## 输出交付格式

向用户汇报时包含：
1. 文件链接（`https://www.figma.com/slides/<fileKey>`）与所做改动概要（新建/修改/删除/重排了哪些页，分节名称）。
2. 每页一行：序号、页名/标题、幻灯片 ID、主要版式。
3. 设计常量（色板、字体）与签名母题的简述（新建 deck 时）。
4. 校验结果（批量校验是否 clean、看过哪些截图）及未解决的问题/限制（如表格、媒体需在编辑器中手动添加）。
5. 无法写入时：交付逐页规划 + 可手动执行的脚本 + 执行说明。

## 参考文档（按需读取）

- `references/slide-gotchas.md`：**任何写操作前必读**。先挂载后定位（−240 偏移）、辅助函数与代码前导模板、字体加载、批量 `await`、缩小遍历范围、不透明节点、无 `get_metadata` 时的校验与批量校验脚本。
- `references/slide-structure.md`：创建/复制/删除/排序幻灯片与行，`getSlideGrid`/`setSlideGrid`，空网格，分节命名，`isSkippedSlide`、`focusedSlide`/`focusedNode`、`speakerNotes` 支持的 markdown、`slideThemeId`、交互元素、过渡等已知限制。
- `references/slide-content.md`：在页内放文字、原生项目符号列表、形状、图片、自动布局、组件，以及标题/要点/讲者备注的写作方法。
- `references/slide-design.md`：新建或重设计 deck 时读。配色、字体与字号层级、内容密度、版式与构图、边距、母题、反模式清单。
