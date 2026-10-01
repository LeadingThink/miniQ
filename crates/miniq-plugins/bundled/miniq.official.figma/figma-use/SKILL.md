---
name: figma-use
displayName: 用 Plugin API 写入 Figma
description: 通过 Figma MCP 的 use_figma 工具执行 Plugin API 脚本，向 Figma 文件写入或修改节点、组件、变量与样式。它是所有写入类 Figma 技能的基础，规定了增量写入、返回节点 ID、字体加载、变量绑定、页面切换和错误恢复等规则。
version: 1
---

# figma-use：用 Plugin API 写入 Figma

本技能是 miniQ 所有“写 Figma”类技能的底座。figma-generate-library、figma-generate-design、figma-generate-diagram、figma-use-figjam、figma-use-slides、figma-use-motion 在调用 `use_figma` 之前，都应先遵守本文的规则。

## 1. 触发场景

以下情况使用本技能：

- 用户要在 Figma 里创建、修改或删除内容，例如画框架、改文字、调整自动布局、改颜色、批量重命名、整理图层。
- 需要创建或修改组件、变体、组件属性、变量集合与模式、文本样式、效果样式。
- 需要用脚本读取 `get_metadata` 给不出的信息，例如变量绑定情况、组件属性、字体、样式 ID、覆盖值。
- 其他 Figma 写入技能要求“先加载 figma-use”。

以下情况不使用本技能：

- 只把设计稿实现成代码：用 figma-design-to-code。
- 只导出图片或读取 REST 数据：用 figma-rest-export。
- 新建空白文件：先用 figma-create-new-file，再回到本技能。

## 2. 前置条件

1. **MCP 连接**（在 manifest 中配置，本技能不修改它）：
   - `figma`：通过 `npx -y mcp-remote@latest https://mcp.figma.com/mcp` 连接远程服务，首次使用要走浏览器 OAuth。常见失败有：未授权返回 401，账号或套餐无权限、文件无编辑权返回 403，或组织策略禁用了 MCP。
   - `figma-desktop`：Figma 桌面端开启 Dev Mode MCP 后，本地地址为 `http://127.0.0.1:3845/mcp`。它通常只提供读取工具，是否有 `use_figma` 以 `tools/list` 为准。
2. **编辑权限**：目标文件必须对当前账号可编辑。只读席位或 View 链接会导致写入失败。
3. **文件定位**：从 URL 解析 `fileKey` 和 `nodeId`。
   - URL 形如 `figma.com/design/<fileKey>/<name>?node-id=1-2`，其中 `node-id` 的 `-` 要换成 `:`，得到 `1:2`。
   - 分支 URL `/design/<fileKey>/branch/<branchKey>/` 应使用 `branchKey`。
   - 路径段决定编辑器类型：`/design/` 是 Design，`/board/` 是 FigJam（见 figma-use-figjam），`/slides/` 是 Slides（见 figma-use-slides）。
4. **确认工具签名**：先调用 `tools/list`，确认 `use_figma` 的参数名（通常是 `fileKey`、`code`，可能还有 `description` 等），以返回结果为准，不要照抄本文。

## 3. MCP 工具与关键参数

miniQ 通过 `mcp_call` 调用工具：

```json
{"server":"figma","tool":"use_figma","arguments":{"fileKey":"<fileKey>","code":"<Plugin API 脚本字符串>","description":"一句话说明本次脚本做什么"}}
```

| 工具 | 用途 | 关键参数（以 tools/list 为准） |
|---|---|---|
| `use_figma` | 在文件中执行 Plugin API JS，可读可写 | `fileKey`、`code`，可选 `description` |
| `get_metadata` | 取节点子树的 XML 结构（id、类型、名称、位置、尺寸）；不传 nodeId 时返回页面列表 | `fileKey`、`nodeId` |
| `get_screenshot` | 截图做视觉核对 | `fileKey`、`nodeId` |
| `get_design_context` | 取结构化设计上下文，偏读取和转代码 | `fileKey`、`nodeId` |
| `get_variable_defs` | 读取节点用到的变量 | `fileKey`、`nodeId` |
| `search_design_system` / `get_libraries` | 查找可复用的库组件、变量、样式（先调 `get_libraries`） | `fileKey`、`query`、`includeLibraryKeys` 等 |

### use_figma 执行模型（必须牢记）

- 脚本体会被包进一个 async 上下文，可以直接写顶层 `await` 和 `return`。不要自己包 IIFE，也不要调用 `figma.closePlugin()`。
- **`return` 是唯一的输出通道。** `console.log` 的内容看不到；未捕获的异常会作为错误返回。返回值会被 JSON 序列化，所以只返回 ID、名称、数字这类可序列化的数据，不要直接返回节点对象。
- 每次调用开始时，`figma.currentPage` 都会重置为第一页。操作其他页时要先 `await figma.setCurrentPageAsync(page)`，**且每个脚本最多调用一次**。
- 禁止使用 `figma.notify()`，它会抛错。
- 一次失败的脚本可能已经做了部分修改。脚本不是事务，失败后要先检查现状再决定如何处理（见第 6 节）。

## 4. 分步流程

1. **识别环境**：解析 URL，判断编辑器类型，调用 `tools/list`。
2. **只读侦察，不做写入**：
   - 用 `get_metadata`（不传 nodeId）列出页面，再对目标节点取子树。
   - 用只读的 `use_figma` 查询现有变量集合、样式、组件、字体和命名约定，参见 `references/api-cheatsheet.md` 中的“发现类脚本”。
   - 有设计系统需求时，先 `get_libraries`，再 `search_design_system`，优先复用。
3. **制定增量计划**：把工作拆成若干个小脚本，每个脚本只做一件事，例如“建变量集合”“建一个组件”“排版一个区块”。单个脚本最好控制在约 100 行以内。
4. **逐步写入**。每个脚本都要：
   - 在开头定位目标页和父节点，优先用 `getNodeByIdAsync` 按 ID 定位。
   - 先加载所有需要的字体，再修改文字。
   - 创建的顶层节点要放到空白区域，不能留在 (0,0)。
   - 结尾返回 `{ createdNodeIds, mutatedNodeIds, ... }`。
5. **每步验证**：写入后用 `get_metadata` 检查结构，关键步骤用 `get_screenshot` 检查视觉，确认无误再进入下一步。
6. **多页工作**：
   - 先用一个脚本返回所有页面的 id 和 name。
   - **只读**任务可以每页一个 `use_figma` 调用，在同一条消息中并行发出。
   - **写入**任务如有依赖或需要保证状态一致，按页顺序执行。
7. **交付**：按第 7 节的格式汇报。

## 5. 核心规则速记

完整说明见 `references/gotchas.md`。

1. 返回所有新建和修改过的节点 ID，后续步骤只用这些真实 ID，不要凭记忆拼造 ID。
2. 颜色取值范围是 0–1。`fills`/`strokes` 是只读数组，要克隆后改副本再整体赋值。paint 的 `color` 不带 `a`，透明度写在 paint 的 `opacity` 上。
3. 修改文字前要 `await figma.loadFontAsync(fontName)`。修改已有文本时，要加载节点当前使用的字体。字体样式名因文件而异，以 `listAvailableFontsAsync` 的结果为准。
4. `lineHeight` 和 `letterSpacing` 必须写成 `{ value, unit }` 对象。
5. `width`/`height` 是只读属性，改尺寸用 `resize()`。`layoutSizingHorizontal/Vertical`（FIXED/HUG/FILL）必须在节点 append 进自动布局父节点之后再设置。
6. 变量绑定：
   - paint 用 `figma.variables.setBoundVariableForPaint`，它会返回新的 paint，要赋回去。
   - 数值属性用 `node.setBoundVariable(field, variable)`。
   - 创建变量时要显式设置 `scopes`。
7. `combineAsVariants` 只接受 ComponentNode。合并后变体会叠在一起，需要手动排成网格并调整尺寸。
8. `addComponentProperty` 返回真实的属性 key（带 `#` 后缀），要保存下来用于 `componentPropertyReferences`。
9. 相互独立的 await（加载字体、按 ID 取节点、导入库资源）用 `Promise.all` 批量执行。
10. 遍历要限定在最小的已知祖先节点内，优先用 `node.query()` 或 `findAllWithCriteria`，避免对整个文档做 `findAll`。
11. 图标用 `figma.createNodeFromSvg(svg)` 导入，不要用矩形或线段拼。
12. 不要在 Figma 对象上存工作流状态。用确定性的命名配合调用方记录的 ID 表来追踪。

## 6. 质量检查与失败回退

每次写入后检查以下项目：

- [ ] 返回值里有 `createdNodeIds`/`mutatedNodeIds`，且数量符合预期。
- [ ] 用 `get_metadata` 看层级、命名、尺寸，确认没有 0 宽、0 高或塌缩的节点。
- [ ] 用 `get_screenshot` 看是否有重叠、文字截断、错位、颜色未生效。
- [ ] 可绑定变量的属性确实已绑定（参见 `references/components-variables-styles.md` 中的审计脚本）。
- [ ] 节点名称有语义，没有残留的 “Frame 12”“Rectangle 3” 这类默认名。

脚本报错时按以下步骤处理：

1. **不要原样重试。** 先读错误信息，常见错误的含义见 `references/gotchas.md` 的错误对照表。
2. 用只读脚本或 `get_metadata` 检查部分写入的结果：哪些节点已经创建、哪些属性已经修改。
3. 修正脚本，让它具备幂等性：先按名称或 ID 查找，已存在就更新，不存在才创建。只清理本次返回的 ID 对应的节点。
4. 同一问题失败两次，就缩小脚本粒度，逐段定位问题。
5. 遇到权限（403）或席位问题时，停止写入并告诉用户需要什么权限。不要切换到其他写入手段绕过限制。

## 7. 输出交付格式

完成后向用户汇报：

```
已写入文件：<fileKey>（页面：<页面名>）
- 新建：<节点名> (<id>) × N
- 修改：<节点名> (<id>) × M
- 变量/样式：<集合名>：K 个变量、J 个模式；文本样式 X 个
验证：get_metadata ✔ / get_screenshot ✔（附截图或说明）
遗留问题：<未完成项、需要用户确认的决策>
```

## 8. 何时读取哪份 reference

| 文件 | 何时读 |
|---|---|
| `references/gotchas.md` | 首次写入前必读；脚本报错时查阅错误对照表 |
| `references/api-cheatsheet.md` | 编写脚本时查可运行片段：定位、创建、自动布局、文本、query/set、SVG、截图、发现类脚本 |
| `references/components-variables-styles.md` | 创建组件、变体、组件属性、实例，变量集合、模式、别名、绑定，文本和效果样式时查阅 |

相关技能：figma-generate-library（完整设计系统）、figma-generate-design（页面级设计）、figma-generate-diagram（图表）、figma-use-figjam、figma-use-slides、figma-use-motion。
