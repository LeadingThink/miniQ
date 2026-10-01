---
name: figma-generate-library
displayName: 分阶段构建 Figma 设计系统
description: 根据代码库或需求，在 Figma 中分阶段搭建或补全设计系统组件库。依次完成现状侦察、变量令牌、页面结构、组件与变体、集成与 QA 五个阶段，每一步增量写入并验证，同时维护状态账本，支持中断后续跑。基于 figma-use 的规则执行。
version: 1
---

# figma-generate-library：分阶段构建 Figma 设计系统

## 1. 触发场景

- 用户要求“在 Figma 里建一套设计系统/组件库/UI Kit”，或“把代码里的 tokens 和组件同步到 Figma”。
- 需要批量创建变量集合（颜色、间距、圆角、字体）、Light/Dark 模式、文本样式、效果样式，以及带变体和属性的组件。
- 需要在已有库的基础上补齐缺失的令牌和组件，或做一次命名与绑定审计。

以下情况不使用本技能：

- 只画单个页面：用 figma-generate-design。
- 只生成设计系统规则文档：用 figma-design-system-rules。
- 只建立代码映射：用 figma-code-connect。

**这不是一次调用就能完成的任务。** 一套库通常需要几十次 `use_figma` 调用，每次调用只做一个小单元。

## 2. 前置条件

- 已加载并遵守 **figma-use** 的所有规则：`return` 返回 ID、字体加载、颜色取值 0–1、变量 scopes、每个脚本只切一次页面等。
- MCP 连接：
  - `figma`：通过 mcp-remote 连接 `https://mcp.figma.com/mcp`，需要 OAuth 授权，可能返回 401 或 403；
  - `figma-desktop`：`http://127.0.0.1:3845/mcp`，通常只能读取。
- 目标文件必须可编辑。没有目标文件时，先用 figma-create-new-file 创建。
- 设计变量的模式数量受套餐限制，免费版可能只能有 1 个模式。计划使用多个模式前要先告知用户。
- 如果有代码库，需要能读取其中的 token 源文件（CSS 变量、Tailwind 配置、theme 文件等）和组件源码。

## 3. MCP 工具与关键参数

以 `tools/list` 返回的签名为准。

| 工具 | 本技能中的用途 |
|---|---|
| `use_figma` `{fileKey, code, description?}` | 所有写入，以及复杂的只读侦察 |
| `get_metadata` `{fileKey, nodeId?}` | 列出页面、在每一步后校验结构 |
| `get_screenshot` `{fileKey, nodeId}` | 每个组件和每个文档页的视觉校验 |
| `get_libraries` `{fileKey, offset?}` | 发现已启用和可添加的库（分页） |
| `search_design_system` `{query, fileKey, includeComponents, includeVariables, includeStyles, includeLibraryKeys?}` | 创建前查找可复用资源 |
| `get_variable_defs` `{fileKey, nodeId}` | 抽查某个节点的变量引用 |

调用示例：

```json
{"server":"figma","tool":"use_figma","arguments":{"fileKey":"<fileKey>","code":"...","description":"P1.b 创建 Primitives 颜色变量"}}
```

**所有写入类调用必须严格串行执行**，不能并行发出两个会修改 Figma 的 `use_figma` 调用。

## 4. 沟通约定与任务编号

- 所有任务统一编号为 `P{阶段}.{字母}`，例如 `P0.a`、`P3.d`。
- 每个阶段开始前，先发出 **“阶段 N 清单”**，列出本阶段的任务编号和退出条件。
- 每个小节开始时，报告“正在进行 P{N}.{x}：<小节名>”。
- 每个阶段结束时，发出 **“阶段 N 小结”**，包括：
  - 已完成的任务；
  - 创建或修改的 Figma 对象；
  - 做过的验证；
  - 已解决的冲突；
  - 剩余风险。
- 只有阶段 0 结束后需要用户明确批准。之后遇到真正的分歧点（见第 7 节）才停下来询问，其余情况自动继续。

## 5. 分步流程（五个阶段）

### 阶段 0：侦察（不做任何写入）

- P0.a：分析代码库，提取 tokens、组件清单、属性 API 和命名习惯。
- P0.b：用只读的 `use_figma` 检查文件，包括页面、变量集合、样式、组件和命名约定。多页检查可以每页一个只读调用，在同一条消息中并行发出。
- P0.c：先调用 `get_libraries`（读完所有分页），再调用 `search_design_system`，找出可复用的资源。
- P0.d：锁定 v1 范围，确定令牌集合和组件清单。
- P0.e：建立“代码 ↔ Figma”的映射，列出所有冲突以及对应的处理决定。
- P0.f：在对话中输出差距分析，包括：
  - 代码中有、Figma 中没有的内容；
  - Figma 中有、代码中没有的内容；
  - 冲突项。

完成后**等待用户批准**。

### 阶段 1：基础令牌（必须在组件之前完成）

- P1.a：创建变量集合，并设置模式名称。
- P1.b：创建原始值变量。它们只有 1 个模式，`scopes = []`，对使用者隐藏。
- P1.c：创建语义变量。语义变量用别名指向原始值，不要重复写入具体数值。
- P1.d：为所有变量设置 scopes，**不允许**保留 `ALL_SCOPES`。
- P1.e：为所有变量设置 code syntax。WEB 平台要写成 `var(--x)`，名称与代码库保持一致。
- P1.f：创建文本样式和效果样式。
- P1.g 和 P1.h：输出变量汇总（按集合列出变量数和模式数）和样式清单。

分批规则：每次调用只处理一个集合，或最多约 30 个变量。

### 阶段 2：文件结构

- P2.a：建立页面骨架，默认顺序是：
  - Cover
  - Getting Started
  - Foundations
  - `---`
  - 每个组件各占一页
  - `---`
  - Utilities
- P2.b：创建 Foundations 文档页，包括色板、字体样张、间距条和圆角示例。文档里的色块要绑定到对应变量，而不是写死颜色。
- P2.c：为每个 Foundations 页面调用 `get_screenshot`，并输出页面清单。

### 阶段 3：组件（逐个完成，不要批量）

按依赖顺序处理，先做原子组件，再做分子组件。每个组件依次完成以下步骤：

- P3.a：再次调用 `search_design_system`，确认没有可复用的组件，然后创建或定位该组件的专属页面。
- P3.b：制作基础组件。使用自动布局，所有 fill、stroke、padding、gap、radius 都绑定到变量。
- P3.c：创建全部变体组合，用 `combineAsVariants` 合并，然后**手动排成网格**并调整 set 的尺寸。
- P3.d：添加组件属性（TEXT、BOOLEAN、INSTANCE_SWAP），并**保存返回的 key**。
- P3.e：把属性关联到子节点的 `componentPropertyReferences`。
- P3.f：在页面上写文档，包括标题、描述、用法和注意事项，并填写组件的 `description`。
- P3.g：先调用 `get_metadata` 核对变体数量和层级，再调用 `get_screenshot` 做视觉核对。

一个组件的所有步骤都完成后，才开始下一个组件。

### 阶段 4：集成与 QA

- P4.a：用 figma-code-connect 补全代码映射（可选）。
- P4.b：做无障碍检查，包括文字对比度（正文至少 4.5:1）、触控目标（至少 44×44）和焦点态是否可见。
- P4.c：做命名审计，确保没有重名、没有默认名、大小写一致。
- P4.d：做绑定审计，确保没有残留的硬编码 fill 或 stroke。可以使用 figma-use 中提供的审计脚本。
- P4.e：对每一页截图，做最终复查。

## 6. 状态账本（长流程必需）

- 在磁盘上维护 `/tmp/figma-ds-state-<RUN_ID>.json`，每一轮开始前都重新读取这个文件。对话上下文可能被截断，**以文件内容为准**。
- 账本记录的内容：`runId`、`phase`、`step`、`entities`（collections、variables、styles、pages、components 的名称到 ID 的映射）、`pendingValidations`、`completedSteps`。
- 每次写入后，立即把返回的 ID 写进账本。不要凭记忆拼造 ID。
- **幂等**：创建前先按名称和账本 ID 查询。已存在就跳过或更新，不要重复创建。
- **续跑**：上下文丢失后，先用只读脚本按名称扫描页面、变量、样式和组件，重建映射，再与账本对照。
- 不要把工作流状态存在 Figma 节点上。需要给人看的说明写进组件的 `description`。

账本的模板和字段说明见 `references/workflow-and-state.md`。

## 7. 分歧点：必须询问用户

- 代码和 Figma 的取值不一致时，列出双方的取值和来源，询问以哪边为准。
- 库里有接近但不完全一致的组件时，列出差距，询问是复用并包装，还是重建。
- v1 范围有模糊项时，列出明确纳入、明确排除和待定的内容。

只有一个明显正确答案时直接执行，不要为每个小决定都打扰用户。已经被用户否决的方案，要先修正，再继续推进。

## 8. 质量检查与失败回退

- 每次写入后，确认返回的 ID 和数量符合预期，并用 `get_metadata` 核对结构。每个组件和每个文档页都要截图检查。
- 变体矩阵超过约 30 种组合时，应拆分成子组件。图标不做成变体，改用 INSTANCE_SWAP。
- 脚本报错时：
  1. 读错误信息，参照 figma-use 的 gotchas 对照表；
  2. 用只读脚本检查已经写入了哪些内容；
  3. 修正脚本并让它幂等后再重跑；
  4. 同一步失败两次就拆小。
- 清理只按账本中的 ID 删除，**禁止**按名称前缀批量删除。
- 某个阶段过不去时，停下来报告阻塞原因。不要私自降级、跳过，或拿近似结果代替。

详细处理方式见 `references/workflow-and-state.md` 的“错误恢复”一节。

## 9. 输出交付格式

每个阶段结束时输出“阶段 N 小结”。全部完成后汇总：

```
设计系统构建完成：<文件名>（<fileKey>）运行 ID：<RUN_ID>
- 变量：<集合名>（模式：Light/Dark）N 个 …
- 样式：文本 X 个，效果 Y 个
- 页面：Cover / Getting Started / Foundations / … 共 P 页
- 组件：Button（8 个变体，属性：Label、Show Icon、Icon）…
- QA：对比度 ✔ 命名 ✔ 绑定审计 未绑定 0 处
- 遗留与后续：…
状态账本：/tmp/figma-ds-state-<RUN_ID>.json
```

## 10. 何时读取哪份 reference

| 文件 | 何时读 |
|---|---|
| `references/workflow-and-state.md` | 开始构建前；需要账本模板、复用决策、错误恢复、续跑流程时 |
| `references/tokens-and-naming.md` | 阶段 0 和阶段 1：令牌架构、命名规范、scopes 与 code syntax 对照表，以及批量创建令牌的脚本 |
| `references/components-and-docs.md` | 阶段 2 和阶段 3：组件搭建、变体网格、属性、文档页脚本和校验脚本 |
| figma-use/references/* | 所有 Plugin API 细节和常见错误 |
