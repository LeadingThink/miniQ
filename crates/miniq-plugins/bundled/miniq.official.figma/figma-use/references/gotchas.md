# figma-use 常见陷阱与错误对照

每条陷阱都按“现象 → 原因 → 正确写法”组织。代码片段都可以直接放进 `use_figma` 的 `code` 中运行（顶层 `await`/`return` 可用）。

## 1. 新节点默认落在 (0,0)

- **现象**：新建的顶层框架压在已有内容上。
- **原因**：追加到页面的节点默认坐标是 (0,0)。
- **正确写法**：放到现有内容的右侧。放进 frame 或自动布局容器内的子节点，由父节点负责定位，不需要这样处理。

```js
const page = figma.currentPage
let right = 0
for (const n of page.children) right = Math.max(right, n.x + n.width)
const frame = figma.createFrame()
frame.name = 'Screen / Login'
frame.x = right + 120
frame.y = 0
return { createdNodeIds: [frame.id] }
```

## 2. 返回值是唯一的输出通道

- `console.log` 的内容看不到，`figma.notify()` 会直接报错。
- 每个脚本都必须 `return`，返回内容包括：
  - `createdNodeIds`：新建节点的 ID；
  - `mutatedNodeIds`：修改过的节点 ID；
  - 必要的计数；
  - `errors` 数组：记录跳过的项及原因。
- 不要直接返回节点对象，它无法序列化。改为返回 `{ id, name, type }`。

## 3. 颜色与 Paint

- 颜色通道取值为 0–1。十六进制颜色先换算，例如 `#3B82F6` 换算为 `{ r: 0x3B/255, g: 0x82/255, b: 0xF6/255 }`。
- SOLID paint 的 `color` 只有 `r`、`g`、`b` 三个分量，写 `a` 会报错。透明度要写成 `{ type: 'SOLID', color, opacity: 0.5 }`。
- `fills`/`strokes`/`effects` 是冻结的数组，不能用 `node.fills[0].color = ...` 原地修改。要先复制一份，改好后整体赋值回去：

```js
const copy = JSON.parse(JSON.stringify(node.fills))
copy[0].color = { r: 1, g: 0, b: 0 }
node.fills = copy
```

## 4. 变量绑定到 paint

- `figma.variables.setBoundVariableForPaint(paint, 'color', v)` **返回一个新的 paint**，原 paint 不会被修改。需要把返回值赋回 `fills`。
- 只有 SOLID paint 能绑定颜色变量，渐变和图片 paint 不行。
- 如果节点当前 `fills` 为空，要先放一个占位 SOLID paint，再绑定变量。

```js
const base = { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }
node.fills = [figma.variables.setBoundVariableForPaint(base, 'color', colorVar)]
```

## 5. 变量集合与模式

- 新建的集合自带 1 个模式，名字是 “Mode 1”。应该重命名这个模式，不要保留默认名。

```js
const col = figma.variables.createVariableCollection('Color')
col.renameMode(col.modes[0].modeId, 'Light')
const darkId = col.addMode('Dark')
```

- 一个集合能有多少个模式取决于团队套餐，免费版可能只允许 1 个。`addMode` 报错时，告诉用户这是套餐限制。
- 变量默认的 `scopes` 是 `['ALL_SCOPES']`，会让它出现在所有属性的选择器里。必须显式设置 scopes，例如：
  - 背景色：`['FRAME_FILL','SHAPE_FILL']`；
  - 文字色：`['TEXT_FILL']`；
  - 描边色：`['STROKE_COLOR']`；
  - 间距：`['GAP']`；
  - 圆角：`['CORNER_RADIUS']`；
  - 只供别名引用的原始色：`[]`。
- 设置 code syntax：`v.setVariableCodeSyntax('WEB', 'var(--color-bg-primary)')`。WEB 平台的值要用 `var()` 包裹，并且不能含空格。
- 显式模式要按节点设置：`frame.setExplicitVariableModeForCollection(col, darkId)`。它不会自动作用到其他组件上。

## 6. 页面切换

- `figma.currentPage = page` 在 use_figma 中会直接报错（“not supported”）。要改用 `await figma.setCurrentPageAsync(page)`。读取 `figma.currentPage` 不受影响。
- **一个脚本最多切换一次页面。** 需要处理多个页面时：
  1. 先用一个脚本返回所有页面：`figma.root.children.map(p => ({ id: p.id, name: p.name }))`；
  2. 再为每个页面单独发一次调用。只读调用可以在同一条消息里并行发出；有依赖关系的写入要按顺序执行。
- 用 `get_metadata` 时，不传 nodeId 会返回页面列表，传入 nodeId 则只返回该子树。图标、组件和变量可能分布在其他页面，下“文件里没有某资源”的结论之前要逐页确认。
- `figma.createPage()` 只能在 Design 文件中使用。在 FigJam 和 Slides 中调用会抛 TypeError。

## 7. 字体与文本

编辑文字的标准流程是：加载字体 → await → 修改 → 返回 ID。

```js
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
const t = figma.createText()
t.characters = '你好'
return { createdNodeIds: [t.id] }
```

- 修改已有文本时，要加载节点**当前实际使用的**字体，不能只加载一个默认字体。文本中可能混用多种字体，要逐段取出后一起加载：

```js
const segs = t.getStyledTextSegments(['fontName'])
await Promise.all(segs.map(s => figma.loadFontAsync(s.fontName)))
```

- 字体样式名在不同文件里可能不一样，比如 “Semi Bold” 和 “SemiBold”。加载失败时，用 `(await figma.listAvailableFontsAsync()).filter(f => f.fontName.family === 'Inter')` 查出实际可用的样式名。
- `lineHeight` 和 `letterSpacing` 必须写成对象，例如 `{ unit: 'AUTO' }`、`{ value: 24, unit: 'PIXELS' }`、`{ value: 150, unit: 'PERCENT' }`。直接写数字会报错，或者被静默忽略。
- 文本节点默认的 `textAutoResize` 是 `WIDTH_AND_HEIGHT`。如果要让它在自动布局中撑满宽度（FILL），先设 `t.textAutoResize = 'HEIGHT'`，再设 `t.layoutSizingHorizontal = 'FILL'`。否则文本可能缩成一条细线，或者不换行。
- 对含有未加载字体的节点做 `appendChild`、`setBoundVariable`、`setExplicitVariableModeForCollection` 等操作时，也可能报错。遍历已有文本之前，先预加载这些文本用到的字体。

## 8. 尺寸与自动布局

- `width`/`height` 是只读属性，改尺寸要用 `node.resize(w, h)`。注意 `resize` 会把对应轴的尺寸模式重置为 FIXED。
- 有两套控制尺寸的枚举，不要混用：
  - 容器自身：`primaryAxisSizingMode`/`counterAxisSizingMode`，取值为 `FIXED`/`AUTO`；
  - 子节点在父级中的表现：`layoutSizingHorizontal`/`layoutSizingVertical`，取值为 `FIXED`/`HUG`/`FILL`。
- `layoutSizing*` 设为 `FILL` 的前提是父节点已经是自动布局，而且该子节点已经被 append 进父节点。在 append 之前设置会报错。
- 父节点设为 HUG、子节点设为 FILL 时，两者互相依赖，结果会塌缩。至少要有一层是 FIXED 宽度。
- `counterAxisAlignItems` 不支持 `STRETCH`。想让子节点在交叉轴方向撑满，要对子节点设置 `layoutSizing* = 'FILL'`。
- 把节点移到新的父节点下，它原来的 x/y 会保留，不会重置。需要时手动设置 `x = 0; y = 0`。
- Section 不会自动适应内容的大小，需要自己计算包围盒，再调用 `section.resizeWithoutConstraints(w, h)`。
- 如果不用自动布局，而是手动排网格，行内元素宽度不一致时，要按每个元素的实际宽度累加计算 x。用固定步长会导致元素重叠。

## 9. 组件与实例

- `figma.combineAsVariants(nodes, parent)` 只接受 ComponentNode，传入 FrameNode 会报错。每个变体的名字要写成 `Prop=Value, Prop2=Value` 的格式。
- 合并后生成的 ComponentSet 不会自动排版，所有变体都叠在 (0,0)。需要手动把它们排成网格，再调整 set 的尺寸。也可以把 set 设为自动布局并开启换行。
- `addComponentProperty(name, type, default)` 返回真实的 key，例如 `"Label#12:3"`。要用这个返回值去设置 `componentPropertyReferences`，不要自己猜 key。
- `instance.detachInstance()` 会让该实例所在祖先链上已记录的 ID 失效。除非用户明确要求，否则不要 detach。导入库组件后立刻 detach 也属于反模式。

## 10. 性能

- 相互独立的 await 用 `Promise.all` 并发执行，包括 `getNodeByIdAsync`、`getVariableByIdAsync`、`loadFontAsync` 和各种 `import*ByKeyAsync`。必须串行执行的只有 `setCurrentPageAsync`，以及后一步依赖前一步结果的情况。
- 同一个字体在循环前加载一次即可，不要每次迭代都加载。
- 已知 ID 时，直接用 `figma.getNodeByIdAsync(id)` 获取节点。
- 需要遍历时，从最小的已知祖先节点开始，用 `node.query(...)` 或 `findAllWithCriteria({ types: [...] })`。避免对 `figma.root` 做 `findAll`。

## 11. 图标与矢量

- 图标用 `figma.createNodeFromSvg('<svg ...>')` 导入，得到一个 FrameNode，可以重命名并调整尺寸。不要用旋转矩形或线段拼出图标。
- 需要让图标可替换时，把它做成组件，然后通过 INSTANCE_SWAP 属性暴露出来。

## 12. 错误信息对照表

| 错误信息（节选） | 含义 | 处理 |
|---|---|---|
| `Cannot write to node with unloaded font` | 字体未加载 | 先 `loadFontAsync` 节点所用的字体 |
| `Setting figma.currentPage is not supported` | 用了同步方式切换页面 | 改用 `await figma.setCurrentPageAsync` |
| `object is not extensible` | 给该节点类型上不存在的属性赋值 | 核对节点类型，例如在 TEXT 上设置 `layoutMode` |
| `no such property` | 读取了该类型上不存在的成员 | 先判断 `node.type` 再读取 |
| `Expected ... to be ComponentNode` / `combineAsVariants` 报错 | 传入的不是组件 | 用 `figma.createComponent()`，或对 frame 调用 `figma.createComponentFromNode(frame)` |
| `Invalid color` / 含 `a` 的报错 | paint 的 color 里带了 alpha | 移除 `a`，改用 paint 的 `opacity` |
| `layoutSizing... FILL` 报错 | 父节点不是自动布局，或子节点尚未 append | 先 append 进自动布局父节点，再设置 |
| `not a function` / 类型错误（createPage 等） | 当前编辑器不支持该 API | 核对是 Design、FigJam 还是 Slides |
| `Limit exceeded` / 模式数量报错 | 套餐限制了模式数量 | 告诉用户，或减少模式数量 |
| 401 / 403 | 未授权，或无编辑权限 | 让用户重新走 OAuth，或申请编辑权限；不要绕过 |

## 13. 失败恢复要点

1. 脚本不是事务，报错之前执行的修改会保留下来。
2. 恢复时，先用只读脚本按名称或 ID 检查现状，再决定是继续还是回滚。
3. 回滚只删除本次返回的 ID 对应的节点，不要按名称前缀批量删除，以免误删用户自己的内容。
4. 修正后的脚本要做到幂等：已存在就更新，不存在才创建。
