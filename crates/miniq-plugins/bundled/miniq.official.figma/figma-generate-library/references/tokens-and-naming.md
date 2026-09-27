# 令牌架构与命名规范

## 1. 令牌架构选择

| 规模 | 推荐结构 |
|---|---|
| 少于 50 个 | 单个集合，2 个模式（Light/Dark） |
| 50–200 个（**标准**） | Primitives（1 个模式，隐藏）+ Color 语义（Light/Dark）+ Spacing（1 个模式）+ Radius（1 个模式）+ Typography（1 个模式） |
| 200 个以上（进阶） | 多个语义集合，模式按“明暗 × 对比度 × 品牌”组合（4–8 个）；组件级令牌只在团队达成共识后添加 |

标准结构示意：

```
Primitives  [Value]        blue/50…blue/900, gray/0…gray/900, red/500 …  scopes=[]
Color       [Light, Dark]  color/bg/primary      → Light: gray/0     Dark: gray/900
                           color/text/primary    → Light: gray/900   Dark: gray/0
                           color/border/default  → Light: gray/200   Dark: gray/700
                           color/action/primary  → Light: blue/500   Dark: blue/400
Spacing     [Value]        spacing/xs=4 sm=8 md=16 lg=24 xl=32 2xl=48
Radius      [Value]        radius/none=0 sm=4 md=8 lg=12 full=9999
Typography  [Value]        typography/body/font-size=16, typography/body/line-height=24 …
```

## 2. 命名规范

如果文件已有约定，就沿用文件的约定。新建时使用以下默认值：

- **变量**：用斜杠分层，全部小写，单词之间用连字符。例如 `color/bg/primary`、`color/text/secondary`、`spacing/md`、`radius/full`、`typography/heading/line-height`。
- **原始值**：`色相/色阶`，例如 `blue/500`、`gray/900`。
- **样式**：`类别/名称`，例如 `Heading/H1`、`Body/Default`、`Shadow/md`。
- **组件**：使用单数的 PascalCase，例如 `Button`、`Input`、`Card`、`Avatar`、`Badge`、`Checkbox`、`Toggle`。
- **变体**：`属性=值, 属性=值`，属性名和值都用首字母大写，例如 `Size=Medium, Style=Primary, State=Default`。
- **组件属性**：
  - TEXT 类型用名词，例如 `Label`；
  - BOOLEAN 类型用 `Show X` 或 `Has X` 的形式；
  - INSTANCE_SWAP 类型用 `Icon`、`Leading Icon` 这样的名字。
- **页面分隔**：用 `---` 或 `——— COMPONENTS ———`。
- **图层**：图层要有语义名，例如 `Label`、`Icon`、`Container`，不能留着 `Frame 12` 这样的默认名。
- CSS 变量名由 Figma 变量名把 `/` 换成 `-` 并加上 `--` 前缀得到，例如 `color/bg/primary` 对应 `--color-bg-primary`。名称里不能有空格。

## 3. scopes 对照

| 语义 | scopes |
|---|---|
| 原始值（只供别名引用） | `[]` |
| 背景、表面 | `['FRAME_FILL','SHAPE_FILL']` |
| 文字颜色 | `['TEXT_FILL']` |
| 边框颜色 | `['STROKE_COLOR']` |
| 图标颜色 | `['SHAPE_FILL','STROKE_COLOR']` |
| 阴影颜色 | `['EFFECT_COLOR']` |
| 间距 | `['GAP']`（如需也可用于宽高：加上 `'WIDTH_HEIGHT'`） |
| 尺寸 | `['WIDTH_HEIGHT']` |
| 圆角 | `['CORNER_RADIUS']` |
| 边框粗细 | `['STROKE_FLOAT']` |
| 不透明度 | `['OPACITY']` |
| 字号、行高、字距、字重 | `['FONT_SIZE']` / `['LINE_HEIGHT']` / `['LETTER_SPACING']` / `['FONT_WEIGHT']` |
| 字族（STRING） | `['FONT_FAMILY']` |

## 4. code syntax 对照

| 平台 | 示例 |
|---|---|
| WEB | `var(--color-bg-primary)`，必须用 `var()` 包裹 |
| ANDROID | `colorBgPrimary` 或 `R.color.bg_primary`，按代码库实际写法 |
| iOS | `Color.bgPrimary`，按代码库实际写法 |

名称以代码库中真实存在的变量名为准。不要自己编造名称。

## 5. 批量创建令牌的脚本（按集合各调用一次）

`DATA` 应由阶段 0 从代码中提取，结果写入账本后再填进脚本。脚本是幂等的：同名变量已存在时只更新它的值。

```js
const DATA = {
  collection: 'Color',
  modes: ['Light', 'Dark'],
  // value 可以是 '#RRGGBB'、数字，或 { alias: '变量名' }（在全部本地变量中查找）
  vars: [
    { name: 'color/bg/primary', type: 'COLOR', scopes: ['FRAME_FILL', 'SHAPE_FILL'], web: 'var(--color-bg-primary)',
      values: { Light: { alias: 'gray/0' }, Dark: { alias: 'gray/900' } } },
    { name: 'color/text/primary', type: 'COLOR', scopes: ['TEXT_FILL'], web: 'var(--color-text-primary)',
      values: { Light: { alias: 'gray/900' }, Dark: { alias: 'gray/0' } } }
  ]
}
const hex = h => { const n = parseInt(h.slice(1), 16); return { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 } }
const [cols, allVars] = await Promise.all([
  figma.variables.getLocalVariableCollectionsAsync(),
  figma.variables.getLocalVariablesAsync()
])
const errors = [], created = [], updated = []
let col = cols.find(c => c.name === DATA.collection)
if (!col) {
  col = figma.variables.createVariableCollection(DATA.collection)
  col.renameMode(col.modes[0].modeId, DATA.modes[0])
}
const modeIds = {}
for (const m of DATA.modes) {
  const found = col.modes.find(x => x.name === m)
  try { modeIds[m] = found ? found.modeId : col.addMode(m) } catch (e) { errors.push(`mode ${m}: ${e}`) }
}
const byName = n => allVars.find(v => v.name === n)
for (const spec of DATA.vars) {
  let v = allVars.find(x => x.name === spec.name && x.variableCollectionId === col.id)
  if (v) updated.push(v.id); else { v = figma.variables.createVariable(spec.name, col, spec.type); created.push(v.id); allVars.push(v) }
  v.scopes = spec.scopes
  if (spec.web) v.setVariableCodeSyntax('WEB', spec.web)
  for (const [m, val] of Object.entries(spec.values)) {
    if (!modeIds[m]) continue
    if (val && typeof val === 'object' && val.alias) {
      const target = byName(val.alias)
      if (!target) { errors.push(`${spec.name}: alias ${val.alias} missing`); continue }
      v.setValueForMode(modeIds[m], { type: 'VARIABLE_ALIAS', id: target.id })
    } else if (typeof val === 'string' && val.startsWith('#')) v.setValueForMode(modeIds[m], hex(val))
    else v.setValueForMode(modeIds[m], val)
  }
}
return { collectionId: col.id, modeIds, created, updated, errors }
```

注意：

- 先创建 Primitives，再创建语义集合，否则别名找不到目标变量。
- `addMode` 报错通常是套餐限制造成的，要在返回值中报告，不能静默忽略。
- 原始值集合里的变量要把 `scopes` 设为 `[]`。

## 6. 变量汇总脚本（P1.g）

```js
const cols = await figma.variables.getLocalVariableCollectionsAsync()
const vars = await figma.variables.getLocalVariablesAsync()
return cols.map(c => {
  const vs = vars.filter(v => v.variableCollectionId === c.id)
  return {
    collection: c.name, modes: c.modes.map(m => m.name), count: vs.length,
    allScopes: vs.filter(v => v.scopes.includes('ALL_SCOPES')).map(v => v.name),
    noWebSyntax: vs.filter(v => !v.codeSyntax || !v.codeSyntax.WEB).map(v => v.name)
  }
})
```

退出阶段 1 的条件：所有集合的 `allScopes` 和 `noWebSyntax` 都为空。
