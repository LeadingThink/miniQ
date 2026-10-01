# 组件、变量与样式

以下片段都可以直接作为 `use_figma` 的 `code` 运行。写入前，先用 api-cheatsheet 里的发现类脚本查清现有的集合、样式和组件，复用已有资源，不要重复创建。

## 1. 变量集合、模式、原始值与别名

```js
const hex = h => { const n = parseInt(h.slice(1), 16); return { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 } }

// 原始值集合：1 个模式，变量隐藏（scopes = []）
const prim = figma.variables.createVariableCollection('Primitives')
prim.renameMode(prim.modes[0].modeId, 'Value')
const pMode = prim.modes[0].modeId
const P = {}
for (const [name, h] of [['gray/0', '#FFFFFF'], ['gray/900', '#111827'], ['blue/500', '#3B82F6']]) {
  const v = figma.variables.createVariable(name, prim, 'COLOR')
  v.setValueForMode(pMode, hex(h))
  v.scopes = []
  P[name] = v
}

// 语义集合：Light/Dark 两个模式，值用别名指向原始值
const sem = figma.variables.createVariableCollection('Color')
const light = sem.modes[0].modeId
sem.renameMode(light, 'Light')
const dark = sem.addMode('Dark')
const alias = v => ({ type: 'VARIABLE_ALIAS', id: v.id })
const bg = figma.variables.createVariable('color/bg/primary', sem, 'COLOR')
bg.setValueForMode(light, alias(P['gray/0']))
bg.setValueForMode(dark, alias(P['gray/900']))
bg.scopes = ['FRAME_FILL', 'SHAPE_FILL']
bg.setVariableCodeSyntax('WEB', 'var(--color-bg-primary)')

// 数值变量（间距）
const space = figma.variables.createVariableCollection('Spacing')
space.renameMode(space.modes[0].modeId, 'Value')
const md = figma.variables.createVariable('spacing/md', space, 'FLOAT')
md.setValueForMode(space.modes[0].modeId, 16)
md.scopes = ['GAP', 'WIDTH_HEIGHT']
md.setVariableCodeSyntax('WEB', 'var(--spacing-md)')

return {
  collections: { prim: prim.id, sem: sem.id, space: space.id },
  variables: Object.fromEntries([...Object.values(P), bg, md].map(v => [v.name, v.id]))
}
```

- 变量类型：`COLOR`、`FLOAT`、`STRING`、`BOOLEAN`。
- 常用 scopes：
  - 填充与描边：`FRAME_FILL`、`SHAPE_FILL`、`TEXT_FILL`、`STROKE_COLOR`、`EFFECT_COLOR`。
  - 尺寸与间距：`CORNER_RADIUS`、`GAP`、`WIDTH_HEIGHT`、`STROKE_FLOAT`、`OPACITY`。
  - 字体：`FONT_SIZE`、`LINE_HEIGHT`、`LETTER_SPACING`、`FONT_WEIGHT`、`FONT_FAMILY`。
- code syntax 的平台：`WEB`、`ANDROID`、`iOS`。只有 WEB 需要用 `var()` 包裹。

## 2. 绑定变量到节点

```js
const [node, bgVar, gapVar, radiusVar] = await Promise.all([
  figma.getNodeByIdAsync('NODE_ID'),
  figma.variables.getVariableByIdAsync('BG_VAR_ID'),
  figma.variables.getVariableByIdAsync('GAP_VAR_ID'),
  figma.variables.getVariableByIdAsync('RADIUS_VAR_ID')
])
const base = node.fills.length && node.fills[0].type === 'SOLID' ? node.fills[0] : { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }
node.fills = [figma.variables.setBoundVariableForPaint(base, 'color', bgVar)]
node.setBoundVariable('itemSpacing', gapVar)
for (const f of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) node.setBoundVariable(f, gapVar)
for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) node.setBoundVariable(f, radiusVar)
return { mutatedNodeIds: [node.id] }
```

- 描边颜色的绑定方式和填充一样：先 `setBoundVariableForPaint`，再把结果赋给 `strokes`。
- 文本节点上的数值字段（如 `fontSize`、`lineHeight`）也可以绑定变量，前提是字体已经加载。
- 解除绑定：`node.setBoundVariable(field, null)`。
- 在某个容器上切换模式：`frame.setExplicitVariableModeForCollection(sem, dark)`。

### 审计：找出未绑定变量的硬编码颜色

```js
const root = await figma.getNodeByIdAsync('NODE_ID')
const bad = []
for (const n of [root, ...root.findAll(() => true)]) {
  for (const key of ['fills', 'strokes']) {
    const arr = n[key]
    if (!Array.isArray(arr)) continue
    arr.forEach((p, i) => {
      if (p.type === 'SOLID' && p.visible !== false && !(p.boundVariables && p.boundVariables.color))
        bad.push({ id: n.id, name: n.name, key, i })
    })
  }
}
return { unbound: bad.slice(0, 200), total: bad.length }
```

## 3. 组件、变体与属性

```js
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' })
const page = figma.currentPage
const right = page.children.reduce((m, n) => Math.max(m, n.x + n.width), 0)

function makeButton(style, size) {
  const c = figma.createComponent()
  c.name = `Style=${style}, Size=${size}`
  c.layoutMode = 'HORIZONTAL'
  c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO'
  c.primaryAxisAlignItems = 'CENTER'; c.counterAxisAlignItems = 'CENTER'
  const pad = size === 'Large' ? 16 : 12
  c.paddingLeft = c.paddingRight = pad * 1.5; c.paddingTop = c.paddingBottom = pad / 2
  c.itemSpacing = 8; c.cornerRadius = 8
  c.fills = [{ type: 'SOLID', color: style === 'Primary' ? { r: 0.23, g: 0.51, b: 0.96 } : { r: 0.95, g: 0.96, b: 0.97 } }]
  const label = figma.createText()
  label.name = 'Label'
  label.fontName = { family: 'Inter', style: 'Medium' }
  label.characters = 'Button'
  label.fontSize = size === 'Large' ? 16 : 14
  label.fills = [{ type: 'SOLID', color: style === 'Primary' ? { r: 1, g: 1, b: 1 } : { r: 0.07, g: 0.09, b: 0.15 } }]
  c.appendChild(label)
  return c
}

const variants = []
for (const s of ['Primary', 'Secondary']) for (const z of ['Medium', 'Large']) variants.push(makeButton(s, z))
const set = figma.combineAsVariants(variants, page)
set.name = 'Button'
set.description = '通用按钮。Style 控制强调程度，Size 控制尺寸。'

// 手动排成网格：变体合并后都叠在 (0,0)
const gap = 24; let x = gap, y = gap, rowH = 0, col = 0
for (const v of set.children) {
  v.x = x; v.y = y
  rowH = Math.max(rowH, v.height)
  x += v.width + gap
  if (++col === 2) { col = 0; x = gap; y += rowH + gap; rowH = 0 }
}
const w = Math.max(...set.children.map(v => v.x + v.width)) + gap
const h = Math.max(...set.children.map(v => v.y + v.height)) + gap
set.resizeWithoutConstraints(w, h)
set.x = right + 120; set.y = 0

// 组件属性：TEXT 属性，必须使用返回的 key
const labelKey = set.addComponentProperty('Label', 'TEXT', 'Button')
for (const v of set.children) v.findOne(n => n.name === 'Label').componentPropertyReferences = { characters: labelKey }

return { componentSetId: set.id, variantIds: set.children.map(v => v.id), props: { labelKey } }
```

### 其他属性类型

- **BOOLEAN**（控制显隐）：`const k = set.addComponentProperty('Show Icon', 'BOOLEAN', true)`，然后设置 `iconNode.componentPropertyReferences = { visible: k }`。
- **INSTANCE_SWAP**（可替换图标）：`const k = set.addComponentProperty('Icon', 'INSTANCE_SWAP', iconComponent.id)`，然后设置 `iconInstance.componentPropertyReferences = { mainComponent: k }`。可以附带 `{ preferredValues: [{ type: 'COMPONENT', key: iconComponent.key }] }`。
- **VARIANT**：由变体名称中的 `Prop=Value` 自动生成，不需要调用 addComponentProperty。
- 修改或删除属性：`set.editComponentProperty(key, { name })`、`set.deleteComponentProperty(key)`。
- 读取属性：`set.componentPropertyDefinitions`。

### 实例

```js
const set = await figma.getNodeByIdAsync('SET_ID')
const variant = set.children.find(v => v.name === 'Style=Primary, Size=Large')
const inst = variant.createInstance()
const props = inst.componentProperties                       // 读取实际的 key
const labelKey = Object.keys(props).find(k => k.startsWith('Label#'))
inst.setProperties({ [labelKey]: '提交', Style: 'Secondary' })  // VARIANT 属性用属性名
return { createdNodeIds: [inst.id] }
```

- 导入库组件：`await figma.importComponentByKeyAsync(key)` 或 `importComponentSetByKeyAsync(key)`，key 可以从 `search_design_system` 获得。多个导入要用 `Promise.all` 一起执行。
- 找出某组件的全部实例：`await comp.getInstancesAsync()`。
- 把现有 frame 转成组件：`figma.createComponentFromNode(frame)`。

## 4. 文本样式

```js
const scale = [
  ['Heading/H1', 'Bold', 32, 40], ['Heading/H2', 'Semi Bold', 24, 32],
  ['Body/Default', 'Regular', 16, 24], ['Body/Small', 'Regular', 14, 20]
]
await Promise.all([...new Set(scale.map(s => s[1]))].map(st => figma.loadFontAsync({ family: 'Inter', style: st })))
const existing = await figma.getLocalTextStylesAsync()
const ids = {}
for (const [name, style, size, lh] of scale) {
  const s = existing.find(e => e.name === name) || figma.createTextStyle()
  s.name = name
  s.fontName = { family: 'Inter', style }
  s.fontSize = size
  s.lineHeight = { value: lh, unit: 'PIXELS' }
  s.letterSpacing = { value: 0, unit: 'PIXELS' }
  ids[name] = s.id
}
return { textStyles: ids }
```

- 可以把样式的字段绑定到变量：`s.setBoundVariable('fontSize', sizeVar)`。
- 应用到文本节点：`await textNode.setTextStyleIdAsync(ids['Body/Default'])`。

## 5. 效果样式（投影）

```js
const e = figma.createEffectStyle()
e.name = 'Shadow/md'
e.effects = [
  { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL' },
  { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.10 }, offset: { x: 0, y: 8 }, radius: 16, spread: -4, visible: true, blendMode: 'NORMAL' }
]
return { effectStyleId: e.id }
```

- 应用效果样式：`await node.setEffectStyleIdAsync(e.id)`。
- 颜色样式：用 `figma.createPaintStyle()` 创建，再设置 `paints`。在以变量为主的体系中，优先使用变量。
- 导入库样式：`await figma.importStyleByKeyAsync(key)`。

## 6. 使用现有设计系统（复用优先）

1. 调用 `get_libraries({ fileKey })` 列出已启用和可添加的库。结果会分页，要跟随 `next_offset` 读完所有页。
2. 调用 `search_design_system({ query, fileKey, includeComponents, includeVariables, includeStyles, includeLibraryKeys })` 查找资源。
3. 按资源类型导入：组件用 `importComponentByKeyAsync`，变量用 `figma.variables.importVariableByKeyAsync`，样式用 `importStyleByKeyAsync`。
4. 拿到实例后，用 `setProperties` 修改它的属性。**不要 detach 实例**，也不要重新画一个外观相似的副本。
5. 如果库里的组件外观合适但接口不合适，就在本地新建一个组件把它包起来，由这个外层组件对外提供合适的属性。
