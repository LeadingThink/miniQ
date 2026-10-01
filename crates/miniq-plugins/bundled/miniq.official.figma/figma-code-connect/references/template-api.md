# Code Connect 模板 API 参考（parserless 模板）

本文件说明无解析器模板的完整写法。示例均为本技能自编，用来说明用法；属性名请以 `get_context_for_code_connect` 实际返回为准。

## 1. 项目配置 `figma.config.json`

放在项目根目录（或 monorepo 子包根目录），CLI 与 MCP 都会参考它。

```json
{
  "codeConnect": {
    "include": ["src/**/*.figma.js", "src/**/*.figma.ts"],
    "exclude": ["**/node_modules/**", "dist/**"],
    "label": "React",
    "language": "tsx",
    "documentUrlSubstitutions": {
      "<ACME_UI>": "https://www.figma.com/design/Ab12Cd34/Acme-UI"
    }
  }
}
```

| 字段 | 类型 | 作用 |
|---|---|---|
| `include` | `string[]` | 模板文件的 glob（相对配置文件），模板必须被它匹配到才会被发布 |
| `exclude` | `string[]` | 排除的 glob，如测试、构建目录 |
| `label` | `string` | Dev Mode 中代码片段标签（如 React、Web Components）；同一节点可按不同 label 各有一份 |
| `language` | `string` | 语法高亮语言 |
| `documentUrlSubstitutions` | `object` | 占位符 → 真实文件 URL，便于多文件/多环境切换 |
| `parser` | `string` | 若存在（如 `react`），可据此推断 `clientFrameworks` |
| `paths` / `importPaths` | `object` | 导入别名与目录映射，用于写模板里的 `imports` |

`language` 可选值：`jsx`、`tsx`、`typescript`、`javascript`、`swift`、`kotlin`、`html`、`css`、`json`、`python`、`go`、`rust`、`bash`、`xml`、`dart`、`ruby`、`cpp`、`sql`、`graphql`、`plaintext`。

使用占位符时，模板注释写成 `// url=<ACME_UI>?node-id=210-80`。

TypeScript 项目使用 `.figma.ts` 时，在 `tsconfig.json` 加：

```json
{ "compilerOptions": { "types": ["@figma/code-connect/figma-types"] } }
```

## 2. 文件命名与格式选择

- parserless 模板：`Alert.figma.js`（默认）或 `Alert.figma.ts`（TS 项目）。
- `.figma.tsx` + `figma.connect()` 是**基于解析器**的另一套格式，本技能不新建、不修改这类文件。
- 一个文件只描述一个 Figma 组件（组件集）。

## 3. 文件骨架

```js
// url=https://www.figma.com/design/Ab12Cd34/Acme-UI?node-id=210-80
// source=src/components/feedback/Alert.tsx
// component=Alert
const figma = require('figma')          // .figma.ts 中写作：import figma from 'figma'
const instance = figma.selectedInstance

const title = instance.getString('Title')
const tone = instance.getEnum('Tone', {
  Neutral: 'neutral',
  Info: 'info',
  Danger: 'error',
})
const dismissible = instance.getBoolean('Dismissible')

export default {
  example: figma.tsx`<Alert severity="${tone}" title="${title}"${dismissible ? ' onClose={() => {}}' : ''} />`,
  imports: ['import { Alert } from "@acme/ui"'],
  id: 'alert',
  metadata: { nestable: false },
}
```

三行头注释必不可少：
- `// url=`：组件在 Figma 中的链接（右键组件 → Copy link to selection），必须带 `node-id`。
- `// source=`：代码组件源文件相对路径（Dev Mode 中可跳转）。
- `// component=`：代码组件名。

默认导出字段：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `example` | 是 | `ResultSection[]` | 由标签模板生成的代码片段 |
| `id` | 是 | `string` | 模板唯一标识，父模板用它查找（`findConnectedInstance`），应具描述性，如 `alert`、`nav-tab` |
| `imports` | 否 | `string[]` | 导入语句 |
| `metadata.nestable` | 否 | `boolean` | `true` 在父片段中内联展开；`false` 显示为可点击的“胶囊”链接 |
| `metadata.props` | 否 | `Record<string, any>` | 暴露给父模板的额外数据 |

## 4. `figma` 对象

| 成员 | 说明 |
|---|---|
| `figma.selectedInstance` | 当前被检查的实例（`InstanceHandle`），所有取值的入口 |
| `figma.code` | 通用标签模板 |
| `figma.tsx` / `figma.jsx` | React（TS/JS）片段 |
| `figma.html` | HTML / Web Components 片段 |
| `figma.swift` / `figma.kotlin` | 原生平台片段 |
| `figma.helpers.react.renderProp(name, value)` | 按值类型渲染一个 JSX 属性 |
| `figma.helpers.react.renderChildren(children)` | 渲染子节点 |
| `figma.helpers.react.jsxElement(str)` | 把字符串标记为 JSX 元素 |
| `figma.properties.children([...组件名])` | 取指定组件名的子实例列表 |

有对应语言的专用标签时优先使用（如 React 用 `figma.tsx`），`figma.code` 作为兜底。标签模板之间可以嵌套：`` figma.tsx`<Row>${figma.tsx`<Cell />`}</Row>` ``。

## 5. 读取组件属性（`InstanceHandle` 方法）

| 方法 | 签名 | 返回 | 用于 |
|---|---|---|---|
| `getString` | `(prop)` | `string` | TEXT；也可把 VARIANT/BOOLEAN 以字符串取回 |
| `getBoolean` | `(prop, map?)` | `boolean` 或映射值 | BOOLEAN |
| `getEnum` | `(prop, map)` | 映射值 | VARIANT |
| `getInstanceSwap` | `(prop)` | `InstanceHandle \| null` | INSTANCE_SWAP |
| `getSlot` | `(prop)` | `ResultSection[] \| undefined` | SLOT |
| `getPropertyValue` | `(prop)` | `string \| boolean` | 原始值，不做映射 |

示例：

```js
// TEXT
const placeholder = instance.getString('Placeholder')

// BOOLEAN：直接取布尔，或映射为代码值
const loading = instance.getBoolean('Loading')
const density = instance.getBoolean('Compact', { true: 'compact', false: 'comfortable' })

// VARIANT：列出全部取值
const size = instance.getEnum('Size', { XS: 'xs', S: 'sm', M: 'md', L: 'lg' })

// 也可以把变体值转成字符串再处理（取值规律统一时更简洁）
const sizeLower = instance.getString('Size').toLowerCase()

// 原始值
const raw = instance.getPropertyValue('State')
```

`getEnum` 与 `getString().toLowerCase()` 都可行：取值与代码值一一对应且有规律时用后者，需要改名或映射到非字符串（布尔、片段）时用前者。

## 6. 查找子图层

| 方法 | 签名 | 返回 | 适用 |
|---|---|---|---|
| `findInstance` | `(layerName, opts?)` | `InstanceHandle \| ErrorHandle` | 按图层名找单个实例（没有对应组件属性时） |
| `findText` | `(layerName, opts?)` | `TextHandle \| ErrorHandle` | 按图层名找文字层，读 `.textContent` |
| `findConnectedInstance` | `(codeConnectId, opts?)` | `InstanceHandle \| ErrorHandle` | 按子模板的 `id` 找，不受图层命名影响 |
| `findConnectedInstances` | `(filter, opts?)` | `InstanceHandle[]` | 找多个已连接的子实例 |
| `findLayers` | `(filter, opts?)` | `(InstanceHandle \| TextHandle)[]` | 找任意实例或文字层（不要求已连接） |

注意：`find*` 失败时返回的是 `ErrorHandle`（真值），不是 `null`，使用前必须检查 `node.type === 'INSTANCE'`（或文字层 `node.type === 'TEXT'`）。

`SelectorOptions`：

```ts
interface SelectorOptions {
  path?: string[]            // 目标所在路径上必须出现的父图层名，用于同名图层消歧
  traverseInstances?: boolean // 允许穿过嵌套实例边界向下搜索
}
```

```js
// 图层：Toolbar > Actions(实例) > "Overflow"
const overflow = instance.findInstance('Overflow', { traverseInstances: true })

// 两个同名 "Label"：分别位于 Header 与 Footer 下，取 Footer 那个
const footerLabel = instance.findText('Label', { path: ['Footer'] })
```

## 7. InstanceHandle / TextHandle

| 成员 | 返回 | 说明 |
|---|---|---|
| `executeTemplate()` | `{ example: ResultSection[], metadata }` | 执行该实例自己的模板，得到其片段与元数据 |
| `hasCodeConnect()` | `boolean` | 是否已有模板（一般不需要用它做守卫，见 pitfalls） |
| `codeConnectId()` | `string \| null` | 该实例模板的 `id` |
| `type` | `'INSTANCE'` 等 | 判断是否为真实实例 |
| `name` | `string` | 图层名 |
| `TextHandle.textContent` | `string` | 文字内容 |
| `TextHandle.name` | `string` | 图层名 |

## 8. 插值规则

| 值来源 | 写法 |
|---|---|
| 字符串（`getString`、`getEnum` 得到的字符串、`textContent`） | 放在引号里：`label="${label}"` |
| 片段（`executeTemplate().example`） | 放在花括号里：`icon={${iconCode}}`，或作为子节点直接插入 |
| SLOT（`getSlot()`） | 直接插入标签模板：`` figma.tsx`<Panel>${body}</Panel>` `` |
| 布尔“裸属性” | 条件表达式：`${disabled ? 'disabled' : ''}` |
| 可选的片段属性 | 嵌套标签模板：`${iconCode ? figma.tsx` icon={${iconCode}}` : ''}` |

片段是对象数组，**只能在标签模板里插值**，不能用 `+`、普通模板字符串或 `.join()` 拼接。

## 9. 类型参考

```ts
interface Metadata {
  nestable?: boolean                 // true 内联；false 胶囊
  props?: Record<string, any>        // 给父模板读取的数据
}

type CodeSection = { type: 'CODE'; code: string }
type InstanceSection = { type: 'INSTANCE'; guid: string; symbolId: string }
type ErrorSection = { type: 'ERROR'; message: string; errorObject?: ResultError }
type ResultSection = CodeSection | InstanceSection | ErrorSection

// 模板执行结果
type SectionsResult = {
  result: 'SUCCESS'
  data: {
    type: 'SECTIONS'
    sections: ResultSection[]
    language: string
    metadata?: { __props: Record<string, any>; [k: string]: any }
  }
}

// 运行时错误
type ResultError =
  | { type: 'PROPERTY_NOT_FOUND'; propertyName: string }
  | { type: 'PROPERTY_TYPE_MISMATCH'; propertyName: string; expectedType: string }
  | { type: 'CHILD_LAYER_NOT_FOUND'; layerName: string }
  | { type: 'TEMPLATE_EXECUTION_ERROR' }
```

`nestable` 需要在**两处**保持一致：模板导出的 `metadata.nestable`（控制显示方式），以及通过 `add_code_connect_map` 注册时的 `templateDataJson`（如 `{"isParserless":true,"nestable":true}`，控制子模板能否被父模板加载）。只写其一时，父模板可能找不到子模板。

## 10. 编写建议

1. `id` 具描述性且全局唯一（`alert`、`nav-tab`，避免 `a1`、`comp`）。
2. 一个模板只输出一个组件的用法，不要把多个无关组件堆在一个片段里。
3. 小而常嵌套的组件（图标、徽标、标签）用 `nestable: true`；弹窗、复杂卡片这类大组件用 `false`。
4. 优先使用与语言匹配的标签模板。
5. 对可能缺失的子图层做类型检查，不要假设一定存在。
6. 输出的每个属性名都必须存在于代码组件的 Props 中。
