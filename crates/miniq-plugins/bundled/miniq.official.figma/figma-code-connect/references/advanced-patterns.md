# 高级模式：变体组合、嵌套实例、SLOT 与父子模板传值

示例均为自编（组件名、属性名为虚构），用于说明模式本身。

## 1. 变体必须完整映射

`getEnum` 的映射表要覆盖 `get_context_for_code_connect` 返回的**每一个**取值；漏掉的取值在运行时得到 `undefined`，片段里会出现 `variant="undefined"`。

```js
// 错误：Figma 里 Emphasis 有 Low / Medium / High 三个值，漏了 High
const emphasis = instance.getEnum('Emphasis', { Low: 'ghost', Medium: 'soft' })

// 正确
const emphasis = instance.getEnum('Emphasis', { Low: 'ghost', Medium: 'soft', High: 'solid' })
```

## 2. 多个变体共同决定输出

当两个（或更多）VARIANT 的**组合**会改变片段结构或取值时，按全部组合写分支（2 × 2 = 4 支）；每一支都写出来，不留空洞。

```js
const shape = instance.getEnum('Shape', { Pill: 'pill', Square: 'square' })
const state = instance.getEnum('State', { Idle: 'idle', Busy: 'busy' })

let snippet
if (shape === 'pill' && state === 'idle') {
  snippet = figma.tsx`<Chip rounded />`
} else if (shape === 'pill' && state === 'busy') {
  snippet = figma.tsx`<Chip rounded><Spinner size="xs" /></Chip>`
} else if (shape === 'square' && state === 'idle') {
  snippet = figma.tsx`<Chip />`
} else {
  snippet = figma.tsx`<Chip><Spinner size="xs" /></Chip>`
}

export default { example: snippet, id: 'chip' }
```

如果某个变体只是原样透传为 prop（例如 `Size` 只影响 `size="..."`），不改变结构，就不需要做笛卡尔积，单独 `getEnum` 即可。

## 3. INSTANCE_SWAP（可替换实例）

```js
const avatarSlot = instance.getInstanceSwap('Avatar')
let avatarCode
if (avatarSlot && avatarSlot.type === 'INSTANCE') {
  avatarCode = avatarSlot.executeTemplate().example
}

export default {
  example: figma.tsx`<ListItem${avatarCode ? figma.tsx` leading={${avatarCode}}` : ''} />`,
  id: 'list-item',
}
```

有对应的组件属性时，优先 `getInstanceSwap('属性名')`，不要用 `findInstance('某个具体图标图层名')`：设计师换了图标后图层名随之改变，按名字就找不到了。

配合布尔开关：

```js
const showTrailing = instance.getBoolean('Show trailing')
const trailing = showTrailing ? instance.getInstanceSwap('Trailing') : null
```

## 4. SLOT（自由内容区）

仅当属性类型是 **SLOT** 时使用 `getSlot`。它返回片段数组（或 `undefined`），直接插值即可，**不能**对它调用 `executeTemplate()`。

```js
const body = instance.getSlot('Body')

export default {
  example: figma.tsx`<Drawer title="${instance.getString('Heading')}">${body}</Drawer>`,
  id: 'drawer',
}
```

INSTANCE_SWAP 与 SLOT 的区别：前者是“绑定到某类组件的单个实例”，得到 `InstanceHandle`；后者是“可放任意内容的区域”，得到片段。

## 5. 未暴露为属性但可配置的嵌套实例

组件内部可能有子实例没有做成组件属性，但它本身有变体/属性（例如卡片里的“状态徽标”）。处理顺序：

1. 先确认子组件是否已有模板：`get_code_connect_suggestions` / `get_code_connect_map`，或仓库 `scan`。
2. 没有就**先给子组件建模板**（让它单独使用和嵌套使用时都正确）。
3. 父模板中动态解析并执行子模板，不要把子组件内容写死：

```js
const status = instance.findInstance('Status')
let statusCode
if (status && status.type === 'INSTANCE') {
  statusCode = status.executeTemplate().example
}

export default {
  example: figma.tsx`<ProjectCard name="${instance.getString('Name')}">${statusCode}</ProjectCard>`,
  id: 'project-card',
}
```

按 `id` 查找更稳（不依赖图层名）：`instance.findConnectedInstance('status-badge')`。

### 什么时候从父模板深入到孙级实例

只有当**父组件的代码**需要把孙级内容作为 prop 传入时（例如 `<Toolbar overflow={<Menu />} />`，Menu 实际位于 Toolbar 内部的 Actions 实例里），才用 `findInstance('Menu', { traverseInstances: true })` 之类跨实例查找。若父组件只是组合子组件、由子组件内部自己渲染孙级，就只执行子组件模板，让子模板负责孙级，避免重复渲染。

同名图层消歧：`instance.findInstance('Icon', { traverseInstances: true, path: ['Actions'] })`。

## 6. 多个子实例

片段是对象数组，**不要** `.map(...).join('\n')` 或放进数组再拼接——结果会变成 `[object Object]`。子项数量固定或有限时，分别存变量再逐个插值：

```js
const tabs = instance.findConnectedInstances(n => n.codeConnectId() === 'nav-tab')
const t0 = tabs[0] ? tabs[0].executeTemplate().example : undefined
const t1 = tabs[1] ? tabs[1].executeTemplate().example : undefined
const t2 = tabs[2] ? tabs[2].executeTemplate().example : undefined

export default {
  example: figma.tsx`<Tabs>${t0}${t1}${t2}</Tabs>`,
  id: 'tabs',
}
```

只需要**字符串**信息时（如文字内容、子模板 `metadata.props` 里的字符串），可以先收集字符串数组再 `join`，因为那是普通字符串而不是片段：

```js
const crumbs = instance
  .findLayers(n => n.type === 'TEXT' && n.name === 'Crumb')
  .map(n => n.textContent)

export default {
  example: figma.tsx`<Breadcrumbs items={${JSON.stringify(crumbs)}} />`,
  id: 'breadcrumbs',
}
```

`findConnectedInstances` 已自动限定为“已连接的实例”，过滤函数里可用 `node.name`、`node.codeConnectId()`、`node.getPropertyValue(...)`；`findLayers` 返回任意实例与文字层（不要求已连接），可用 `node.type`、`node.name`、`hasCodeConnect()`、`codeConnectId()` 过滤。

## 7. 用 `metadata.props` 向上传值

子模板除了片段，还可以通过 `metadata.props` 暴露单个值，供父模板引用（比拿整段片段更灵活）。

子模板（`StatusBadge.figma.js`）：

```js
const figma = require('figma')
const instance = figma.selectedInstance
const level = instance.getEnum('Level', { Ok: 'ok', Warn: 'warn', Down: 'down' })

export default {
  example: figma.tsx`<StatusBadge level="${level}" />`,
  id: 'status-badge',
  metadata: { nestable: true, props: { level } },
}
```

父模板读取：

```js
const badge = instance.findConnectedInstance('status-badge')
let level = 'ok'
if (badge && badge.type === 'INSTANCE') {
  level = badge.executeTemplate().metadata?.props?.level ?? 'ok'
}

export default {
  example: figma.tsx`<ServiceRow health="${level}" />`,
  id: 'service-row',
}
```

前提：子模板在导出的 `metadata` **和**注册时的 `templateDataJson` 中都设置了 `nestable: true`，否则父模板加载不到子模板。

### 三层传递示例（Page → Section → Field）

```js
// Field.figma.js —— 最底层，暴露字段名
// url=https://www.figma.com/design/Ab12Cd34/Acme-UI?node-id=300-3
// source=src/forms/Field.tsx
// component=Field
const figma = require('figma')
const instance = figma.selectedInstance
const fieldName = instance.getString('Name')
export default {
  example: figma.tsx`<Field name="${fieldName}" />`,
  id: 'form-field',
  metadata: { nestable: true, props: { fieldName } },
}
```

```js
// Section.figma.js —— 中间层，嵌入 Field 片段，并把字段名继续上传
// url=https://www.figma.com/design/Ab12Cd34/Acme-UI?node-id=300-2
// source=src/forms/Section.tsx
// component=Section
const figma = require('figma')
const instance = figma.selectedInstance
let fieldCode
let fieldName
const field = instance.findConnectedInstance('form-field')
if (field && field.type === 'INSTANCE') {
  const res = field.executeTemplate()
  fieldCode = res.example
  fieldName = res.metadata?.props?.fieldName
}
export default {
  example: figma.tsx`<Section>${fieldCode}</Section>`,
  id: 'form-section',
  metadata: { nestable: true, props: { fieldName } },
}
```

```js
// Page.figma.js —— 顶层，只汇总各 Section 暴露的字符串
// url=https://www.figma.com/design/Ab12Cd34/Acme-UI?node-id=300-1
// source=src/forms/FormPage.tsx
// component=FormPage
const figma = require('figma')
const instance = figma.selectedInstance
const names = instance
  .findConnectedInstances(n => n.codeConnectId() === 'form-section')
  .map(n => n.executeTemplate().metadata?.props?.fieldName)
  .filter(Boolean)
export default {
  example: figma.tsx`<FormPage fields={${JSON.stringify(names)}} />`,
  id: 'form-page',
  metadata: { nestable: false },
}
```

这里顶层 `join`/`JSON.stringify` 的是字符串，不是片段，所以是安全的。

## 8. 直接读取子片段的源码字符串（少用）

极少数情况下需要改写子模板生成的代码文本，而 `metadata.props` 又不适用，可以读取第一个片段：

```js
const first = child.executeTemplate()?.example?.[0]
let text
if (first && first.type === 'CODE') {
  text = first.code.replace('size="md"', 'size="sm"')
} else {
  text = `/* 子模板出错：${first?.message ?? '未知'} */`
}
```

必须先判断 `type === 'CODE'`，因为模板失败时这里是 `ERROR` 段。能用 `metadata.props` 就不要这样做。

## 9. 取值方式的取舍

| 需求 | 推荐 |
|---|---|
| 变体值要改名或映射成非字符串 | `getEnum` |
| 变体值有统一规律（仅大小写不同） | `getString(...).toLowerCase()` |
| 布尔要映射成类名/片段 | `getBoolean(prop, { true: ..., false: undefined })` |
| 布尔只做条件判断 | `getBoolean(prop)` 或 `getString(prop) === 'true'` |
| 文字属性 | 永远 `getString` |
| 没有属性绑定的文字层 | `findText(...).textContent`（先判断 `type === 'TEXT'`） |
