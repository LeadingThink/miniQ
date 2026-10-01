# FigJam 节点速查（可运行片段）

以下片段都可以作为 `use_figma` 的 `code` 在 FigJam 文件中运行。

## 1. 调色板

使用 `0xRR/255` 的写法，才能精确匹配 FigJam 调色板，使颜色被识别为调色板色。

```js
const h = (r, g, b) => ({ r: r / 255, g: g / 255, b: b / 255 })
// 便利贴底色
const STICKY = {
  white: h(0xff, 0xff, 0xff), gray: h(0xe6, 0xe6, 0xe6), green: h(0xb3, 0xef, 0xbd),
  teal: h(0xb3, 0xf4, 0xef), blue: h(0xa8, 0xda, 0xff), violet: h(0xd3, 0xbd, 0xff),
  pink: h(0xff, 0xa8, 0xdb), red: h(0xff, 0xb8, 0xa8), orange: h(0xff, 0xd3, 0xa8), yellow: h(0xff, 0xe2, 0x99)
}
// 形状用的“深色填充 + 描边 + 文字色”组合
const SHAPE = {
  black: { fill: h(0x1e, 0x1e, 0x1e), stroke: h(0xb3, 0xb3, 0xb3), text: h(0xff, 0xff, 0xff) },
  blue: { fill: h(0x3d, 0xad, 0xff), stroke: h(0x00, 0x7a, 0xd2), text: h(0xff, 0xff, 0xff) },
  green: { fill: h(0x66, 0xd5, 0x75), stroke: h(0x3e, 0x9b, 0x4b), text: h(0xff, 0xff, 0xff) },
  red: { fill: h(0xff, 0x75, 0x56), stroke: h(0xdc, 0x30, 0x09), text: h(0xff, 0xff, 0xff) },
  orange: { fill: h(0xff, 0x9e, 0x42), stroke: h(0xeb, 0x75, 0x00), text: h(0xff, 0xff, 0xff) },
  violet: { fill: h(0x87, 0x4f, 0xff), stroke: h(0x54, 0x27, 0xb4), text: h(0xff, 0xff, 0xff) }
}
```

常用语义约定（可以按团队习惯调整）：

- 黄色：想法、观点
- 绿色：做得好、结论
- 红色或粉色：问题、风险
- 蓝色：行动项
- 紫色：待讨论
- 灰色：备注

## 2. 便利贴

```js
const h = (r, g, b) => ({ r: r / 255, g: g / 255, b: b / 255 })
const items = ['需求评审提前', '接口文档滞后', '测试环境不稳定', '上线流程顺畅']
// 放在现有内容的右侧
const right = figma.currentPage.children.reduce((m, n) => {
  const b = n.absoluteBoundingBox; return b ? Math.max(m, b.x + b.width) : m
}, 0)
const probe = figma.createSticky()
await figma.loadFontAsync(probe.text.fontName)
probe.remove()
const ids = []
items.forEach((txt, i) => {
  const s = figma.createSticky()
  s.text.characters = txt
  s.fills = [{ type: 'SOLID', color: h(0xff, 0xe2, 0x99) }]
  s.isWideWidth = txt.length > 20       // 长文本改用宽版
  s.authorVisible = false
  const col = i % 3, row = Math.floor(i / 3)
  s.x = right + 200 + col * (416 + 24)
  s.y = row * (240 + 24)
  ids.push(s.id)
})
return { createdNodeIds: ids }
```

## 3. 形状文字（ShapeWithText）

```js
const probe = figma.createShapeWithText()
await figma.loadFontAsync(probe.text.fontName)
probe.remove()
const s = figma.createShapeWithText()
s.shapeType = 'DIAMOND'            // SQUARE / ROUNDED_RECTANGLE / ELLIPSE / TRIANGLE_UP / HEXAGON …
s.resize(200, 120)
s.text.characters = '是否通过？'
s.fills = [{ type: 'SOLID', color: { r: 0x3d / 255, g: 0xad / 255, b: 1 } }]
s.strokes = [{ type: 'SOLID', color: { r: 0, g: 0x7a / 255, b: 0xd2 / 255 } }]
s.text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
s.x = 0; s.y = 0
return { createdNodeIds: [s.id] }
```

编号圆点：用 `shapeType = 'ELLIPSE'`，尺寸 `resize(40, 40)`，文字写 `'1'`，放在目标节点左上角外侧，例如 `(target.x - 20, target.y - 20)`。

## 4. 连接线

```js
const [a, b] = await Promise.all([figma.getNodeByIdAsync('NODE_A'), figma.getNodeByIdAsync('NODE_B')])
const c = figma.createConnector()
c.connectorStart = { endpointNodeId: a.id, magnet: 'AUTO' }
c.connectorEnd = { endpointNodeId: b.id, magnet: 'AUTO' }
c.connectorLineType = 'ELBOWED'           // STRAIGHT / CURVED
c.connectorEndStrokeCap = 'ARROW_LINES'   // NONE / ARROW_EQUILATERAL / TRIANGLE_FILLED / CIRCLE_FILLED …
c.strokeWeight = 2
await figma.loadFontAsync(c.text.fontName)
c.text.characters = '通过'
return { createdNodeIds: [c.id] }
```

- 指定连接边：把 `magnet` 设为 `'RIGHT'` 或 `'LEFT'`。
- 指定节点上的相对位置：`{ endpointNodeId, position: { x: 1, y: 0.5 } }`，这里的 x、y 是 0–1 的比例。
- 不连节点的自由端点：`{ position: { x, y } }`。

## 5. 分区（Section）

```js
const sec = figma.createSection()
sec.name = 'Start'
sec.x = 0; sec.y = 0
sec.fills = [{ type: 'SOLID', color: { r: 0xb3 / 255, g: 0xef / 255, b: 0xbd / 255 } }]
const kids = await Promise.all(['ID1', 'ID2'].map(id => figma.getNodeByIdAsync(id)))
const PAD = 48, GAP = 24
let x = PAD, y = PAD + 40, rowH = 0
kids.forEach((k, i) => {
  sec.appendChild(k)              // appendChild 之后，坐标变成相对分区的坐标
  k.x = x; k.y = y
  x += k.width + GAP; rowH = Math.max(rowH, k.height)
  if ((i + 1) % 3 === 0) { x = PAD; y += rowH + GAP; rowH = 0 }
})
const w = Math.max(...kids.map(k => k.x + k.width)) + PAD
const hgt = Math.max(...kids.map(k => k.y + k.height)) + PAD
sec.resize(Math.max(w, 400), Math.max(hgt, 300))   // 分区不会自动调整尺寸
return { createdNodeIds: [sec.id], mutatedNodeIds: kids.map(k => k.id) }
```

`sec.sectionContentsHidden = true` 可以折叠分区内容。

## 6. 表格

```js
const rows = [['负责人', '事项', '截止'], ['张三', '补接口文档', '周五'], ['李四', '修复测试环境', '周三']]
const t = figma.createTable(rows.length, rows[0].length)
await figma.loadFontAsync(t.cellAt(0, 0).text.fontName)
rows.forEach((r, i) => r.forEach((v, j) => { t.cellAt(i, j).text.characters = v }))
for (let j = 0; j < rows[0].length; j++)   // 表头底色
  t.cellAt(0, j).fills = [{ type: 'SOLID', color: { r: 0xe6 / 255, g: 0xe6 / 255, b: 0xe6 / 255 } }]
t.resizeColumn(1, 280)
t.x = 0; t.y = 800
return { createdNodeIds: [t.id] }
```

增加行列用 `t.insertRow(index)`、`t.insertColumn(index)`，调整尺寸用 `t.resizeRow(i, h)`。

## 7. 代码块与纯文字

```js
const cb = figma.createCodeBlock()          // 创建后会自动追加到页面
cb.code = 'fetch("/api/users").then(r => r.json())'
cb.codeLanguage = 'JAVASCRIPT'
cb.x = 0; cb.y = 1200

const t = figma.createText()
await figma.loadFontAsync(t.fontName)
t.characters = '冲刺 23 回顾'
t.fontSize = 48
t.x = 0; t.y = -120
return { createdNodeIds: [cb.id, t.id] }
```

如果标题需要其他字体（例如手写风格的字族），先用 `listAvailableFontsAsync` 确认该字体存在，再加载使用。

## 8. 编辑已有文字与批量修改

```js
const root = await figma.getNodeByIdAsync('SECTION_OR_PAGE_ID')
const targets = root.findAll(n => n.type === 'STICKY' || n.type === 'SHAPE_WITH_TEXT')
// 预先加载所有文本中用到的字体（去重）
const fonts = new Map()
for (const n of targets) for (const s of n.text.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(s.fontName), s.fontName)
await Promise.all([...fonts.values()].map(f => figma.loadFontAsync(f)))
const yellow = { r: 0xff / 255, g: 0xe2 / 255, b: 0x99 / 255 }
const mutated = []
for (const n of targets) {
  if (n.text.characters.includes('风险')) {
    n.fills = [{ type: 'SOLID', color: { r: 0xff / 255, g: 0xb8 / 255, b: 0xa8 / 255 } }]
    n.text.characters = n.text.characters.replace('风险', '⚠ 风险')
    mutated.push(n.id)
  } else if (n.type === 'STICKY') { n.fills = [{ type: 'SOLID', color: yellow }]; mutated.push(n.id) }
}
return { mutatedNodeIds: mutated, scanned: targets.length }
```

局部样式：`n.text.setRangeFontName(start, end, font)`、`setRangeFills`，以及 `setRangeTextDecoration(start, end, 'UNDERLINE')`。

## 9. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot write to node with unloaded font` | 没有加载 `.text.fontName` | 先加载 `node.text.fontName` |
| 便利贴调用 `resize` 报错 | 便利贴尺寸固定 | 改用 `isWideWidth` |
| `createPage` 抛 TypeError | FigJam 不支持多页创建 | 用 Section 分组代替 |
| 颜色显示为“自定义色” | 用了四舍五入的小数 | 改为 `0xRR/255` 的写法 |
| 连接线悬空 | 端点节点被删除，或 ID 写错 | 重新设置 `connectorStart`/`connectorEnd` |
| appendChild 之后节点跑位 | 坐标变成了相对于分区的坐标 | append 之后重新设置 x/y |
