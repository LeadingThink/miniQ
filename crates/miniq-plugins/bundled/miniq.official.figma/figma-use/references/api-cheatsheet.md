# figma-use API 速查（可运行片段）

以下片段都可以直接作为 `use_figma` 的 `code` 运行。`NODE_ID`、`PAGE_ID` 等大写占位符要替换成真实值。

## 1. 定位

```js
// 按 ID 取节点（最快）
const node = await figma.getNodeByIdAsync('NODE_ID')
if (!node) return { error: 'node not found' }

// 切换到目标页（每个脚本最多切一次）
const page = await figma.getNodeByIdAsync('PAGE_ID')
await figma.setCurrentPageAsync(page)

// 按名称找页面
const p = figma.root.children.find(pg => pg.name === 'Components')

// 当前选区
const sel = figma.currentPage.selection.map(n => ({ id: n.id, name: n.name, type: n.type }))
return { sel }
```

## 2. 发现类脚本（只读）

```js
// 页面概览
return figma.root.children.map(p => ({ id: p.id, name: p.name, count: p.children.length }))
```

```js
// 变量集合与变量
const cols = await figma.variables.getLocalVariableCollectionsAsync()
const vars = await figma.variables.getLocalVariablesAsync()
return cols.map(c => ({
  id: c.id, name: c.name,
  modes: c.modes.map(m => m.name),
  vars: vars.filter(v => v.variableCollectionId === c.id)
    .map(v => ({ id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes }))
}))
```

```js
// 样式与当前页的组件
const [texts, effects, paints] = await Promise.all([
  figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalPaintStylesAsync()
])
const comps = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
  .filter(n => n.type === 'COMPONENT_SET' || n.parent.type !== 'COMPONENT_SET')
return {
  textStyles: texts.map(s => ({ id: s.id, name: s.name, font: s.fontName, size: s.fontSize })),
  effectStyles: effects.map(s => ({ id: s.id, name: s.name })),
  paintStyles: paints.map(s => ({ id: s.id, name: s.name })),
  components: comps.map(c => ({ id: c.id, name: c.name, type: c.type, key: c.key }))
}
```

```js
// 可用字体（按字族过滤）
const fonts = await figma.listAvailableFontsAsync()
return fonts.filter(f => f.fontName.family === 'Inter').map(f => f.fontName.style)
```

## 3. 创建与基本属性

```js
const rgb = hex => {
  const n = parseInt(hex.replace('#', ''), 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}
const rect = figma.createRectangle()
rect.name = 'Card / Background'
rect.resize(320, 200)
rect.cornerRadius = 12
rect.fills = [{ type: 'SOLID', color: rgb('#FFFFFF') }]
rect.strokes = [{ type: 'SOLID', color: rgb('#E5E7EB') }]
rect.strokeWeight = 1
rect.effects = [{
  type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 4 },
  radius: 12, spread: 0, visible: true, blendMode: 'NORMAL'
}]
return { createdNodeIds: [rect.id] }
```

注意：effect 的 `color` 需要 `a`，但 paint 的 `color` 不能有 `a`。

其他创建方法：

- `figma.createFrame()`、`createEllipse()`、`createLine()`、`createPolygon()`、`createStar()`、`createVector()`、`createSection()`、`createComponent()`、`createText()`、`createPage()`（仅限 Design 文件）。
- 布尔运算：`figma.union(nodes, parent)`、`subtract`、`intersect`、`exclude`。
- 编组：`figma.group(nodes, parent)`。

## 4. 自动布局卡片（完整示例）

```js
await Promise.all([
  figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
])
const page = figma.currentPage
const right = page.children.reduce((m, n) => Math.max(m, n.x + n.width), 0)

const card = figma.createFrame()
card.name = 'Card'
card.layoutMode = 'VERTICAL'
card.primaryAxisSizingMode = 'AUTO'      // 高度随内容增长
card.counterAxisSizingMode = 'FIXED'
card.resize(360, 100)                    // 固定宽度；高度随后由 AUTO 接管
card.primaryAxisSizingMode = 'AUTO'
card.paddingTop = card.paddingBottom = 24
card.paddingLeft = card.paddingRight = 24
card.itemSpacing = 12
card.cornerRadius = 16
card.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
card.x = right + 120
card.y = 0

const title = figma.createText()
title.fontName = { family: 'Inter', style: 'Semi Bold' }
title.characters = '标题'
title.fontSize = 20
title.lineHeight = { value: 28, unit: 'PIXELS' }

const body = figma.createText()
body.fontName = { family: 'Inter', style: 'Regular' }
body.characters = '正文内容，会在卡片宽度内自动换行。'
body.fontSize = 14

card.appendChild(title)
card.appendChild(body)
for (const t of [title, body]) {         // append 之后再设置 FILL
  t.textAutoResize = 'HEIGHT'
  t.layoutSizingHorizontal = 'FILL'
}
return { createdNodeIds: [card.id, title.id, body.id] }
```

### 自动布局属性速查

| 属性 | 取值 |
|---|---|
| `layoutMode` | `NONE` / `HORIZONTAL` / `VERTICAL` / `GRID`（GRID 视版本而定） |
| `layoutWrap` | `NO_WRAP` / `WRAP`（仅 HORIZONTAL） |
| `primaryAxisAlignItems` | `MIN` / `CENTER` / `MAX` / `SPACE_BETWEEN` |
| `counterAxisAlignItems` | `MIN` / `CENTER` / `MAX` / `BASELINE` |
| `itemSpacing`，`counterAxisSpacing` | 数字（后者用于换行时的行间距） |
| `padding*` | `paddingTop/Right/Bottom/Left` |
| 子节点 `layoutSizingHorizontal/Vertical` | `FIXED` / `HUG` / `FILL` |
| 子节点 `layoutPositioning` | `AUTO` / `ABSOLUTE`（在自动布局中绝对定位） |
| 子节点 `layoutGrow`，`layoutAlign` | 旧式写法，优先使用 layoutSizing |
| `clipsContent` | 布尔值 |

## 5. node.query 与 node.set

在当前 use_figma 运行时中，节点上提供 `query(selector)` 和 `set(props)` 两个便捷方法。这两个方法在标准 Plugin API 中不存在，也没有全局的 `figma.query`。使用前可以先检测：`typeof node.query === 'function'`。不可用时，退回到 `findAllWithCriteria` 或 `findAll`。

选择器语法：

- 按类型：`TEXT`、`FRAME`、`*`。
- 按属性：`[name="Title"]`，另有 `^=` 前缀匹配、`$=` 后缀匹配、`*=` 包含匹配。点路径也可用，例如 `[fills.0.type=SOLID]`。
- 按实例的主组件：`[mainComponent=ID]`。
- 按 ID：`#1:23`。
- 组合符：`A > B`（直接子节点）、`A B`（后代）、`A + B`（紧邻的下一个兄弟）、`A ~ B`（之后的兄弟）。
- 伪类：`:first-child`、`:nth-child(2)`、`:not(...)`、`:is(...)`、`:where(...)`。
- 多个选择器用逗号并列。

结果集的用法：

- 取元素：`.first`、`.last`、`.toArray()`。
- 遍历与变换：`.each(fn)`、`.map(fn)`、`.filter(fn)`。
- 取值：`.values(['id','name'])`。
- 批量设置：`.set({...})`。
- 链式查询：`.query(sel)`。
- 结果集本身可以直接用 for...of 迭代。

```js
const root = await figma.getNodeByIdAsync('NODE_ID')
if (typeof root.query !== 'function') {
  const texts = root.findAllWithCriteria({ types: ['TEXT'] })
  return { fallback: true, ids: texts.map(t => t.id) }
}
const titles = root.query('FRAME > TEXT[name^="Title"]')
return { ids: titles.values(['id', 'name']) }
```

`node.set({...})` 用来批量设置属性：它会先应用 `layoutMode`，而 `width`/`height` 会自动转成 `resize()` 调用。修改文字前，仍然需要先加载字体。

## 6. 文本进阶

```js
const t = await figma.getNodeByIdAsync('TEXT_ID')
await Promise.all(t.getStyledTextSegments(['fontName']).map(s => figma.loadFontAsync(s.fontName)))
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' })
t.characters = '价格：¥199'
t.setRangeFontName(3, 7, { family: 'Inter', style: 'Bold' })      // 局部加粗
t.setRangeFills(3, 7, [{ type: 'SOLID', color: { r: 0.9, g: 0.2, b: 0.2 } }])
t.textAlignHorizontal = 'LEFT'   // LEFT/CENTER/RIGHT/JUSTIFIED
t.textTruncation = 'ENDING'; t.maxLines = 2
return { mutatedNodeIds: [t.id] }
```

应用文本样式：`await t.setTextStyleIdAsync(style.id)`。

## 7. SVG、图片、克隆

```js
const icon = figma.createNodeFromSvg('<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14M13 6l6 6-6 6" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')
icon.name = 'Icon / Arrow Right'

// 图片：需要 bytes（Uint8Array），或者用 createImageAsync(url)（受网络限制）
// const img = await figma.createImageAsync('https://...')
// rect.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }]

const copy = icon.clone(); copy.x = icon.x + 40
return { createdNodeIds: [icon.id, copy.id] }
```

## 8. 截图与导出（用于校验）

- 优先调用 `get_screenshot` 工具。
- 在脚本内可以用 `await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } })` 拿到字节数据。一般只返回字节长度，不要返回整段数据。
- 部分运行时还提供 `node.screenshot()`，使用前要先检测是否可用。

## 9. 删除与移动

```js
const ids = ['ID1', 'ID2']   // 只删除自己创建并记录过的 ID
const nodes = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)))
const removed = []
for (const n of nodes) if (n && !n.removed) { removed.push(n.id); n.remove() }
return { removed }
```

移动节点：`target.appendChild(node)` 或 `target.insertChild(index, node)`。移动后按需要重设 x/y。

## 10. 返回值模板

```js
const createdNodeIds = [], mutatedNodeIds = [], errors = []
try {
  // ... 主体逻辑
} catch (e) {
  errors.push(String(e))
}
return { createdNodeIds, mutatedNodeIds, count: createdNodeIds.length + mutatedNodeIds.length, errors }
```

注意：用 try/catch 吞掉异常后，返回值里必须带上 `errors`。
