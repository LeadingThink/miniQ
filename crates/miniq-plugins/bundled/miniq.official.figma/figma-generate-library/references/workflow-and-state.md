# 工作流、状态账本与错误恢复

## 1. 状态账本模板

路径：`/tmp/figma-ds-state-<RUN_ID>.json`。RUN_ID 的格式建议为 `ds-<yyyymmdd>-<短随机串>`。

```json
{
  "runId": "ds-20250101-a1b2",
  "fileKey": "<fileKey>",
  "phase": 3,
  "step": "P3.c",
  "currentComponent": "Button",
  "scope": { "tokens": ["color", "spacing", "radius", "typography"], "components": ["Icon", "Button", "Input", "Card"] },
  "entities": {
    "collections": { "Primitives": "VariableCollectionId:1:2", "Color": "VariableCollectionId:1:9" },
    "modes": { "Color/Light": "1:0", "Color/Dark": "1:1" },
    "variables": { "color/bg/primary": "VariableID:1:12" },
    "textStyles": { "Body/Default": "S:abc..." },
    "effectStyles": { "Shadow/md": "S:def..." },
    "pages": { "Cover": "0:1", "Button": "12:0" },
    "components": { "Button": { "set": "12:34", "props": { "Label": "Label#12:3" } } }
  },
  "decisions": [{ "id": "P0.e-1", "topic": "color/bg/primary", "choice": "以代码为准 #FFFFFF" }],
  "pendingValidations": ["Button:screenshot"],
  "completedSteps": ["P0.a", "P0.b", "P1.a"]
}
```

规则：

- 每个 `use_figma` 调用返回后，**立即**把新的 ID 合并进账本，并写回磁盘。
- 下一轮开始时，先读取账本，再做决定。
- 删除操作只能针对账本中记录的 ID。

续跑时，可以把这句话告诉用户，用于在新会话中继续：

> 继续设计系统构建，运行 ID：<RUN_ID>，文件：<fileKey>。请加载 figma-generate-library 并从账本中最后完成的步骤继续。

## 2. 续跑时重建映射（只读脚本）

每页各发一次调用，这些只读调用可以在同一条消息里并行发出。其中 `PAGE_ID` 取自页面列表。

```js
const page = await figma.getNodeByIdAsync('PAGE_ID')
await figma.setCurrentPageAsync(page)
const sets = page.findAllWithCriteria({ types: ['COMPONENT_SET'] })
const singles = page.findAllWithCriteria({ types: ['COMPONENT'] }).filter(c => c.parent.type !== 'COMPONENT_SET')
return {
  pageId: page.id,
  sets: sets.map(s => ({ id: s.id, name: s.name, variants: s.children.length, props: Object.keys(s.componentPropertyDefinitions) })),
  components: singles.map(c => ({ id: c.id, name: c.name }))
}
```

变量和样式的重建：直接复用 figma-use 的 api-cheatsheet 中“发现类脚本”，它们与页面无关。

## 3. 复用决策矩阵

先调用 `get_libraries`（读完所有分页），再调用 `search_design_system`。在阶段 0 和每个组件创建前各检查一次。

| 判断 | 条件 | 做法 |
|---|---|---|
| 复用 | 属性 API 一致；令牌模型兼容；命名一致；可以使用 | 导入组件并创建实例，不要 detach |
| 包装 | 外观匹配，但属性 API 不一致 | 在新组件里嵌套库组件的实例，由新组件暴露干净的 API |
| 重建 | API 不兼容、值是硬编码的，或者没有所有权 | 按本技能从零创建 |

优先级：

1. 文件内已有的资源；
2. 已订阅的库；
3. `libraries_available_to_add` 中可添加的 UI Kit（图标尤其适合走这一步）；
4. 新建。

`get_libraries` 返回空结果，并不代表不需要搜索。只有搜索本身也没有结果时，才能在差距分析中写上“无可复用资源”。

## 4. 分批与粒度

| 操作 | 单次调用的上限建议 |
|---|---|
| 创建变量 | 1 个集合，或约 30 个变量 |
| 创建文本样式 | 约 15 个 |
| 创建组件 | 1 个组件或组件集（包含全部变体） |
| 文档页 | 1 个页面的 1 个区块 |
| 审计与扫描 | 1 个页面 |

脚本超过约 150 行，或者一次返回超过 200 个 ID 时，就要拆分。

## 5. 每一步的验证清单

- 返回值中包含 `createdNodeIds` 或 `mutatedNodeIds`，数量符合预期，`errors` 为空。
- 用 `get_metadata` 检查：
  - 层级正确；
  - 命名符合规范；
  - 变体数量等于各属性取值数的乘积；
  - 没有尺寸为 0 的节点。
- 用 `get_screenshot` 检查：
  - 没有重叠；
  - 文字没有截断；
  - Light/Dark 模式切换后都正常；
  - 变体网格排列整齐。
- 做绑定抽查：调用 `get_variable_defs`，或运行 figma-use 的未绑定审计脚本。

## 6. 错误恢复

1. **读错误信息**，参照 figma-use 的 gotchas 中的错误对照表。常见错误有：字体未加载、页面同步切换、paint 的 color 带了 alpha、FILL 设置早于 append、模式数量超出套餐限制。
2. **检查部分写入**：脚本出错前的修改会保留下来。用只读脚本按名称和账本 ID 检查哪些对象已经创建。
3. **修正后幂等重跑**：用“查找 → 存在则更新 → 不存在则创建”的写法，避免重复创建。
4. **清理残留**：只删除本次调用返回的 ID，或账本中登记在当前步骤下的 ID。示例：

```js
const ids = ['ID_FROM_LEDGER_1', 'ID_FROM_LEDGER_2']
const nodes = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)))
const removed = nodes.filter(n => n && !n.removed).map(n => { const id = n.id; n.remove(); return id })
return { removed }
```

清理变量时，调用 `(await figma.variables.getVariableByIdAsync(id)).remove()`。

5. **升级处理**：同一步失败两次，就把脚本拆小。遇到权限、套餐或库所有权问题时，停止执行，向用户说明所需的条件和可选方案。
6. **绝不**按名称前缀或模糊匹配来决定删除哪些节点。

## 7. 反模式

- 阶段 0 还没获得批准就开始写入，或者绕过已有的约定另起一套。
- 变量保留 `ALL_SCOPES`、没有设置 code syntax、语义变量重复写入具体数值。
- 组件先于变量创建，或者组件里有硬编码的颜色、间距、圆角。
- 每个图标做一个变体，或者变体矩阵失控膨胀。
- `combineAsVariants` 之后不排网格。
- 导入远程组件后立即 detach。
- 并行执行写入类 `use_figma` 调用，或者在上一步未验证的结果上继续构建。
- 凭记忆拼造节点 ID。
