# 组件构建与文档页

以下片段都可以作为 `use_figma` 的 `code` 运行。凡是 `ID_` 开头的占位符，都用状态账本中记录的真实 ID 替换。

## 1. 页面骨架（P2.a）

只在 Design 文件中使用。脚本幂等：同名页面已存在时跳过。

```js
const PAGES = ['Cover', 'Getting Started', 'Foundations', '---', 'Button', 'Input', 'Card', '---', 'Utilities']
const created = [], existing = {}
let sepCount = 0
for (const name of PAGES) {
  const key = name === '---' ? `---#${sepCount++}` : name
  const same = figma.root.children.filter(p => p.name === name)
  const hit = name === '---' ? same[sepCount - 1] : same[0]
  if (hit) { existing[key] = hit.id; continue }
  const p = figma.createPage(); p.name = name; created.push(p.id); existing[key] = p.id
}
return { pages: existing, createdNodeIds: created }
```

页面顺序可以用 `figma.root.insertChild(index, page)` 调整。

## 2. 色板文档区块（P2.b，每页一次调用）

色块要绑定变量，这样切换模式时色板也会随之变化。

```js
const page = await figma.getNodeByIdAsync('ID_FOUNDATIONS_PAGE')
await figma.setCurrentPageAsync(page)
await Promise.all([
  figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
])
const vars = (await figma.variables.getLocalVariablesAsync('COLOR')).filter(v => v.name.startsWith('color/'))
const right = page.children.reduce((m, n) => Math.max(m, n.x + n.width), 0)

const section = figma.createFrame()
section.name = 'Foundations / Color'
section.layoutMode = 'VERTICAL'; section.itemSpacing = 24
section.paddingTop = section.paddingBottom = section.paddingLeft = section.paddingRight = 48
section.primaryAxisSizingMode = 'AUTO'; section.counterAxisSizingMode = 'AUTO'
section.x = right + 200; section.y = 0

const h = figma.createText(); h.fontName = { family: 'Inter', style: 'Semi Bold' }
h.characters = 'Color'; h.fontSize = 32; section.appendChild(h)

const grid = figma.createFrame(); grid.name = 'Swatches'; grid.fills = []
grid.layoutMode = 'HORIZONTAL'; grid.layoutWrap = 'WRAP'
grid.itemSpacing = 16; grid.counterAxisSpacing = 16
grid.resize(960, 100); grid.primaryAxisSizingMode = 'FIXED'; grid.counterAxisSizingMode = 'AUTO'
section.appendChild(grid)

const ids = [section.id, h.id, grid.id]
for (const v of vars) {
  const cell = figma.createFrame(); cell.name = v.name; cell.fills = []
  cell.layoutMode = 'VERTICAL'; cell.itemSpacing = 8
  cell.primaryAxisSizingMode = 'AUTO'; cell.counterAxisSizingMode = 'AUTO'
  const chip = figma.createRectangle(); chip.name = 'Chip'; chip.resize(144, 72); chip.cornerRadius = 8
  chip.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v)]
  chip.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 } }]
  const label = figma.createText(); label.fontName = { family: 'Inter', style: 'Regular' }
  label.characters = v.name; label.fontSize = 12
  cell.appendChild(chip); cell.appendChild(label); grid.appendChild(cell)
  ids.push(cell.id, chip.id, label.id)
}
return { createdNodeIds: ids, swatches: vars.length }
```

字体样张和间距条的写法相同：

- 字体样张：遍历 `getLocalTextStylesAsync()`，为每个样式创建一行示例文字，调用 `setTextStyleIdAsync` 应用该样式，并在旁边标注样式名、字号和行高。
- 间距条：遍历间距变量，每个变量画一个矩形，调用 `setBoundVariable('width', v)` 把宽度绑定到该变量。

## 3. 组件构建步骤（P3.b–P3.e）

一个组件对应一次调用；如果变体很多，就拆成“基础组件”和“变体与属性”两次调用。

```js
const page = await figma.getNodeByIdAsync('ID_BUTTON_PAGE')
await figma.setCurrentPageAsync(page)
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' })

const V = {}   // 按名称一次性取出需要的变量
const need = ['color/action/primary', 'color/bg/secondary', 'color/text/on-action', 'color/text/primary', 'spacing/sm', 'spacing/md', 'radius/md']
const all = await figma.variables.getLocalVariablesAsync()
for (const n of need) { V[n] = all.find(v => v.name === n); if (!V[n]) return { error: `missing variable ${n}` } }
const paint = v => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v)

const STYLES = { Primary: ['color/action/primary', 'color/text/on-action'], Secondary: ['color/bg/secondary', 'color/text/primary'] }
const SIZES = { Medium: 'spacing/sm', Large: 'spacing/md' }
const STATES = ['Default', 'Disabled']

const comps = []
for (const [style, [bgName, fgName]] of Object.entries(STYLES))
  for (const [size, padName] of Object.entries(SIZES))
    for (const state of STATES) {
      const c = figma.createComponent()
      c.name = `Style=${style}, Size=${size}, State=${state}`
      c.layoutMode = 'HORIZONTAL'
      c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO'
      c.primaryAxisAlignItems = 'CENTER'; c.counterAxisAlignItems = 'CENTER'
      for (const f of ['paddingTop', 'paddingBottom', 'itemSpacing']) c.setBoundVariable(f, V['spacing/sm'])
      for (const f of ['paddingLeft', 'paddingRight']) c.setBoundVariable(f, V[padName])
      for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) c.setBoundVariable(f, V['radius/md'])
      c.fills = [paint(V[bgName])]
      if (state === 'Disabled') c.opacity = 0.4
      const t = figma.createText(); t.name = 'Label'
      t.fontName = { family: 'Inter', style: 'Medium' }; t.characters = 'Button'
      t.fontSize = size === 'Large' ? 16 : 14
      t.fills = [paint(V[fgName])]
      c.appendChild(t)
      comps.push(c)
    }

const set = figma.combineAsVariants(comps, page)
set.name = 'Button'
set.description = '主要操作按钮。Style：强调程度；Size：尺寸；State：交互状态。'

// 变体网格：每行放一个 State 的所有组合
const COLS = STATES.length, GAP = 24
let x = GAP, y = GAP, rowH = 0
set.children.forEach((v, i) => {
  v.x = x; v.y = y; rowH = Math.max(rowH, v.height); x += v.width + GAP
  if ((i + 1) % COLS === 0) { x = GAP; y += rowH + GAP; rowH = 0 }
})
set.resizeWithoutConstraints(
  Math.max(...set.children.map(v => v.x + v.width)) + GAP,
  Math.max(...set.children.map(v => v.y + v.height)) + GAP)
const right = page.children.filter(n => n !== set).reduce((m, n) => Math.max(m, n.x + n.width), 0)
set.x = right + 120; set.y = 120

const labelKey = set.addComponentProperty('Label', 'TEXT', 'Button')
for (const v of set.children) v.findOne(n => n.name === 'Label').componentPropertyReferences = { characters: labelKey }

return { componentSetId: set.id, variantIds: set.children.map(v => v.id), variantCount: set.children.length, props: { Label: labelKey } }
```

要点：

- 返回的 `props` 要写进账本，后续设置属性时直接取用。
- 图标：
  1. 先把图标做成组件，统一放在 Utilities 页的 `Icon` 集合中；
  2. 在按钮中放一个图标实例；
  3. 用 `addComponentProperty('Icon', 'INSTANCE_SWAP', iconComp.id)` 暴露替换属性，同时设置 `componentPropertyReferences = { mainComponent: key }`；
  4. 再加一个 BOOLEAN 属性 `Show Icon`，关联到图标实例的 `visible`。
- 变体数量应等于各属性取值数的乘积。本例为 2×2×2=8。

## 4. 组件页文档（P3.f）

每个组件页上方放一个自动布局的文档框：

- 标题：组件名，32 号字。
- 描述：一两句话说明用途。
- 用法：说明何时使用、何时不用，每条一行。
- 属性表：由 `set.componentPropertyDefinitions` 自动生成，每个属性一行，格式为“名称 · 类型 · 默认值 · 可选值”。

```js
const set = await figma.getNodeByIdAsync('ID_BUTTON_SET')
const defs = set.componentPropertyDefinitions
return Object.entries(defs).map(([k, d]) => ({ key: k, type: d.type, default: d.defaultValue, options: d.variantOptions || null }))
```

先用上面的脚本拿到属性数据，再在下一次调用中生成文档文本节点。文档框的 y 坐标放在组件集上方，或者放在组件集左侧的空白区域。

## 5. 组件校验脚本（P3.g）

```js
const set = await figma.getNodeByIdAsync('ID_BUTTON_SET')
const issues = []
const expected = Object.values(set.componentPropertyDefinitions)
  .filter(d => d.type === 'VARIANT').reduce((n, d) => n * d.variantOptions.length, 1)
if (set.children.length !== expected) issues.push(`variant count ${set.children.length} != ${expected}`)
const boxes = set.children.map(v => [v.x, v.y, v.x + v.width, v.y + v.height])
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const [a, b] = [boxes[i], boxes[j]]
  if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) issues.push(`overlap ${set.children[i].name} / ${set.children[j].name}`)
}
for (const n of set.findAll(() => true)) {
  if (/^(Frame|Rectangle|Group|Text) \d+$/.test(n.name)) issues.push(`default name ${n.id}`)
  for (const key of ['fills', 'strokes']) {
    const arr = n[key]
    if (Array.isArray(arr)) arr.forEach(p => { if (p.type === 'SOLID' && !(p.boundVariables && p.boundVariables.color)) issues.push(`unbound ${key} ${n.name} ${n.id}`) })
  }
}
return { ok: issues.length === 0, variantCount: set.children.length, expected, issues: issues.slice(0, 100) }
```

之后调用 `get_screenshot` 检查组件集节点，确认网格整齐、文字完整、Disabled 状态的效果可以分辨。

## 6. 无障碍抽查（P4.b）

- 对比度：计算前景色和背景色解析后的实际颜色，公式为 (L1+0.05)/(L2+0.05)。正文要求至少 4.5，大号文字要求至少 3。解析别名可以用 `v.resolveForConsumer(node)`。
- 触控目标：交互组件的变体高度至少为 44，或者说明在实际使用时会补足命中区域。
- 焦点态：如果有 `State=Focus` 变体，要确认它有清晰可见的描边或外发光。
