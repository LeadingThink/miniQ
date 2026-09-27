---
name: figma-use-figjam
description: 在 FigJam 白板（figma.com/board/ 链接）中用 use_figma 写入便利贴、形状文字、连接线、分区、表格、代码块和文字，适用于头脑风暴、流程梳理、回顾会、看板和标注等场景。重点处理 FigJam 专有节点、调色板配色、布局防重叠和文字编辑规则。
version: 1
---

# figma-use-figjam：向 FigJam 白板写入内容

## 1. 触发场景

- 用户给出 `figma.com/board/...` 链接，要求在白板上添加或整理内容，例如便利贴墙、亲和图、回顾会（Start/Stop/Continue）、用户旅程、看板、会议纪要、步骤编号或批注。
- 需要把一段文字或会议记录转写成结构化白板：用分区归类，用便利贴放要点，用连接线表示关系。
- 需要批量修改白板：统一颜色、改文字、重新排版、移动到分区。

以下情况改用其他技能：

- 画严谨的流程图、时序图、ER 图、架构图：优先用 figma-generate-diagram。
- Design 文件（`/design/`）的写入：用 figma-use。
- Slides 的写入：用 figma-use-slides。

## 2. 前置条件

- 先遵守 **figma-use** 的通用规则：`return` 是唯一的输出通道；必须返回节点 ID；修改文字前要先加载字体；颜色取值为 0–1；fills 必须克隆后再赋值；不能用 `figma.notify()`。
- MCP 连接：
  - `figma`：通过 mcp-remote 连接 `https://mcp.figma.com/mcp`，需要 OAuth 授权，可能返回 401 或 403。
  - `figma-desktop`：`http://127.0.0.1:3845/mcp`，通常只能读取，以 `tools/list` 为准。
- 当前账号必须对该白板有编辑权限。
- 从 URL `figma.com/board/<fileKey>/...?node-id=1-2` 中解析 `fileKey`。`node-id` 里的 `-` 要改成 `:`。
- **FigJam 中可用的节点**：
  - FigJam 专有：Sticky、ShapeWithText、Connector、Section、Table、CodeBlock。
  - 通用：Text、Rectangle、Ellipse、Line、Vector、Frame 等。
- **FigJam 中不可用的 API**：`figma.createPage()` 会抛 TypeError。另外也不能创建 Slide 和 Component 类型的节点，不要依赖它们。

## 3. MCP 工具与关键参数

以 `tools/list` 返回的签名为准。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `use_figma` | 创建、修改白板节点，以及只读检查 | `fileKey`、`code`，可选 `description` |
| `get_figjam` | 读取 FigJam 内容（节点与文字），如果服务端提供该工具 | `fileKey`、`nodeId` |
| `get_metadata` | 读取子树结构，校验位置和尺寸 | `fileKey`、`nodeId` |
| `get_screenshot` | 视觉校验 | `fileKey`、`nodeId` |

调用示例：

```json
{"server":"figma","tool":"use_figma","arguments":{"fileKey":"<fileKey>","code":"...","description":"在 Retro 分区中创建 12 张便利贴"}}
```

如果某些工具是延迟加载的，要一次性获取所有需要的 schema，不要一个一个地拉取。

## 4. 分步流程

1. **检查白板**：先用 `get_figjam` 或 `get_metadata` 查看顶层内容。如果需要更细的信息，用只读脚本返回顶层节点的 `{id, type, name, x, y, width, height}`，以及内容的整体包围盒。
2. **规划内容**：参照 `references/board-planning-and-layout.md`，先在对话中列出分区、每个分区里的条目、颜色语义和连线关系，然后再写入。内容较多（超过 30 个节点）时，按分区拆成多次调用。
3. **定位**：新内容放在现有内容包围盒的右侧或下方，留出 200px 以上的间距。计算坐标时要用 `absoluteBoundingBox`，不能直接用相对坐标。
4. **按顺序写入**：
   1. 先创建 Section，确定整体框架；
   2. 再创建便利贴、形状和文字，并放入分区；
   3. 最后创建连接线，连接线需要两端节点的 ID。
   每次调用都返回 `createdNodeIds`，以及按用途归类的 ID 映射，例如 `{ "Start": [...], "Stop": [...] }`。
5. **调整分区尺寸**：Section 不会根据内容自动调整大小。放完子节点后，按子节点的包围盒加上内边距，调用 `resize` 调整分区尺寸。
6. **校验**：先用 `get_metadata` 检查是否有重叠、是否越界，再用 `get_screenshot` 检查整体视觉效果。

## 5. 关键规则速记

完整代码见 `references/figjam-nodes.md`。

- **文字**：
  - Sticky、ShapeWithText、表格单元格的文字都在 `.text` 子层上。
  - 修改文字前先 `await figma.loadFontAsync(node.text.fontName)`。FigJam 的默认字体通常是 Inter Medium，但要读取节点上的实际字体，不要写死。
  - 批量创建时，先创建一个 probe 节点并加载它的字体，然后删掉 probe，只加载一次即可。
- **便利贴尺寸**：
  - `width` 和 `height` 是只读的，便利贴也不支持 `resize()`。
  - 只能通过 `isWideWidth` 在两种尺寸间切换：方形 240×240，宽版 416×240。
  - `authorVisible` 控制是否显示作者。
- **颜色**：要使用 FigJam 调色板中的颜色，写成 `0xRR/255` 的形式。如果写成四舍五入的小数，FigJam 会把它识别为“自定义色”，而不是调色板色。
- **连接线**：
  - 用 `connectorStart` 和 `connectorEnd` 设置两端，格式为 `{ endpointNodeId, magnet: 'AUTO'|'TOP'|'BOTTOM'|'LEFT'|'RIGHT'|'CENTER' }`，也可以写成 `{ position: {x, y} }`。
  - `connectorLineType` 可取 `ELBOWED`、`STRAIGHT`、`CURVED`。
  - 端点样式通过 `connectorStartStrokeCap` 和 `connectorEndStrokeCap` 设置。
  - 连接线的文字在 `connector.text` 上。
- **形状文字**：`shapeType` 常用的值有 `SQUARE`、`ROUNDED_RECTANGLE`、`ELLIPSE`、`DIAMOND`、`TRIANGLE_UP`、`TRIANGLE_DOWN`、`PENTAGON`、`HEXAGON`、`OCTAGON`、`STAR` 等。形状尺寸可以用 `resize()` 修改。
- **分区**：
  - 用 `figma.createSection()` 创建，调用 `appendChild` 放入子节点。
  - 放入子节点后，要按分区内的坐标重新摆放。
  - 用 `resize(w, h)` 手动调整分区尺寸。
- **表格**：
  - 用 `figma.createTable(rows, cols)` 创建。
  - 用 `table.cellAt(r, c).text.characters` 写入单元格内容，行列下标从 0 开始。
  - 用 `insertRow`/`insertColumn`、`resizeRow`/`resizeColumn` 调整结构。
- **代码块**：用 `figma.createCodeBlock()` 创建，通过 `code` 设置内容，通过 `codeLanguage` 设置语言（如 `'JAVASCRIPT'`、`'PYTHON'`、`'TYPESCRIPT'` 等）。代码块创建后会自动追加到页面。
- **标签或编号**：可以用 `ELLIPSE` 类型的 ShapeWithText 作为编号圆点，放在目标节点左上角的外侧。

## 6. 质量检查与失败回退

- [ ] 所有新节点都位于现有内容之外，彼此不重叠。便利贴之间的间距不小于 24。
- [ ] 分区完全包住自己的内容，分区标题不被遮挡。
- [ ] 颜色语义一致，同一类信息用同一种颜色。整块板用色不超过 4–5 种。
- [ ] 连接线两端都挂在节点上（`endpointNodeId` 存在），没有悬空的线。
- [ ] 文字没有溢出。长文本应改用宽版便利贴，或拆成多张。

脚本报错时的处理：

- 字体未加载：改为加载 `node.text.fontName`。
- 调用了 FigJam 不支持的 API：换用对应的 FigJam 节点。
- 连接线报错：先确认两端的节点已经存在，并且与连接线在同一页。
- 脚本中途失败：先用只读脚本按返回的 ID 或节点名查看现有状态，只清理本次创建的节点，然后用幂等方式重跑。

权限问题（403 或只读）：停止操作，并向用户说明需要什么权限。

## 7. 输出交付格式

```
已写入 FigJam：<fileKey>
- 分区：Start (id) / Stop (id) / Continue (id)
- 便利贴 N 张、形状 M 个、连接线 K 条、表格 T 个
- 位置：现有内容右侧 x≈…，y≈…
验证：get_metadata ✔ 无重叠；get_screenshot ✔
待确认：<需要用户决定的归类/措辞>
```

## 8. 何时读取哪份 reference

| 文件 | 何时读 |
|---|---|
| `references/figjam-nodes.md` | 编写任何 FigJam 创建或修改脚本时：便利贴、形状、连接线、分区、表格、代码块、文本编辑、批量修改、调色板 |
| `references/board-planning-and-layout.md` | 规划白板内容与版式时：模板结构、网格排布、防重叠定位、分区尺寸调整 |
| figma-use/references/gotchas.md | 遇到通用 Plugin API 错误时 |
