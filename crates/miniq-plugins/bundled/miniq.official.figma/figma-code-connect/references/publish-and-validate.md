# 校验与发布

## 1. 本地校验清单（每个模板写完都要过一遍）

先 `file_read` 回读文件，再逐项核对：

1. **格式先行**：文件名为 `Xxx.figma.js` 或 `Xxx.figma.ts`（不是 `.figma.tsx`）；默认导出是对象，`example` 由标签模板（`figma.code` / `figma.tsx` 等）生成；文件中没有 `figma.connect(`。
2. **头注释**：`// url=` 含 `node-id`（或使用 `documentUrlSubstitutions` 占位符）、`// source=` 指向真实存在的文件、`// component=` 与代码导出名一致。
3. **必填字段**：`example`、`id` 均存在；`id` 在仓库内唯一。
4. **属性覆盖**：`get_context_for_code_connect` 返回的每个属性都已使用，或在汇总中说明为何省略（无对应 prop / 纯视觉属性）。
5. **VARIANT 完整**：每个 `getEnum` 的映射表覆盖该属性全部取值。
6. **属性名准确**：大小写、空格与 Figma 返回完全一致；输出的 prop 名全部存在于代码组件 Props 中，没有编造。
7. **类型正确**：输出的代码在目标框架中合法并符合 Props 类型（枚举值在联合类型里、布尔属性不写成字符串等）。
8. **嵌套动态化**：INSTANCE_SWAP 用 `getInstanceSwap`，SLOT 用 `getSlot`，其他子实例用 `findInstance` / `findConnectedInstance` + `executeTemplate()`；没有写死的子组件 JSX。
9. **插值包裹**：字符串在引号内，片段在花括号内或作为子节点，布尔裸属性用条件表达式，SLOT 直接插值。
10. **常见错误**：无片段字符串拼接/`.join`、`executeTemplate()` 前有 `type === 'INSTANCE'` 检查、无多余的 `hasCodeConnect()` 守卫（详见 `pitfalls-and-errors.md`）。
11. **位置**：文件路径能被 `figma.config.json` 的 `include` 匹配，且不被 `exclude` 排除。
12. **nestable 一致**：会被父模板引用的子模板，`metadata.nestable` 与注册时 `templateDataJson.nestable` 都为 `true`。

### 用脚本做静态检查

```bash
# 扫描仓库已有模板（含 url / source / component / id / 格式）
python3 <技能目录>/scripts/code_connect_tool.py scan <仓库根> [--json]

# 静态检查单个文件或整个目录
python3 <技能目录>/scripts/code_connect_tool.py lint src/components/feedback/Alert.figma.js

# 同时对照属性清单检查覆盖度与 VARIANT 完整性
python3 <技能目录>/scripts/code_connect_tool.py lint src/components/feedback/Alert.figma.js --props /tmp/alert-props.json

# 检查 figma.config.json 的 include 是否覆盖了模板
python3 <技能目录>/scripts/code_connect_tool.py lint src --config figma.config.json
```

退出码：0 = 无 error（可能有 warning），1 = 存在 error，2 = 参数/文件错误。脚本是启发式检查，不能替代阅读模板与在 Dev Mode 中实测。

TypeScript 项目可额外运行 `npx tsc --noEmit`（需已配置 `@figma/code-connect/figma-types`）检查 `.figma.ts` 的类型。

## 2. 通过 MCP 写入映射

写入前**必须 `ask_user`**，内容包括：服务器、组件（名称 + nodeId）、模板文件、label、是否 nestable。得到同意后：

- 单个：`add_code_connect_map`。常见参数包括节点 ID、`fileKey`、源码路径、组件名、label，以及 parserless 模板相关的模板内容与 `templateDataJson`（例：`{"isParserless":true,"nestable":true}`）。具体字段名与必填项以 `tools/list` 返回的 schema 为准。
- 批量：`send_code_connect_mappings`，传入映射数组；同样以 schema 为准。
- 写入后用 `get_code_connect_map` 回查，确认节点已关联到预期的源码与组件；必要时 `get_code_connect_suggestions` 确认该组件不再出现在“未映射”列表。

## 3. 通过 CLI 发布

CLI 包为 `@figma/code-connect`，可执行命令名为 `figma`。

```bash
# 全局安装（可选）
npm install --global @figma/code-connect@latest

# 不安装，直接用 npx（两种写法等价）
npx @figma/code-connect@latest connect --help
npx -p @figma/code-connect@latest figma connect --help
```

令牌：在 Figma「设置 → 安全 → 个人访问令牌」生成，需包含 Code Connect 写入权限与文件内容读取权限。由用户配置到环境变量，**不要**让用户把令牌贴进对话：

```bash
test -n "$FIGMA_ACCESS_TOKEN" && echo ok || echo missing   # 只检测，不打印
```

常用命令（执行前先 `ask_user`；参数以 `--help` 输出为准）：

| 目的 | 命令 |
|---|---|
| 发布全部模板 | `npx figma connect publish`（令牌取自 `FIGMA_ACCESS_TOKEN`；也支持 `--token`，但不要在命令行明文出现令牌） |
| 指定配置文件 | `npx figma connect publish --config path/to/figma.config.json` |
| 撤销配置内全部发布 | `npx figma connect unpublish` |
| 撤销单个组件某 label 的发布 | `npx figma connect unpublish --node "<组件URL含node-id>" --label React` |
| 旧格式迁移为模板 | `npx figma connect migrate --outDir ./figma-templates` |
| 查看帮助 | `npx figma connect --help`、`npx figma connect publish --help`、`npx figma connect unpublish --help` |

若 `publish --help` 中提供试运行/仅校验类选项，先试运行再正式发布。

### 用临时 label 做安全试发布

改动大或做迁移时，避免影响团队正在使用的片段：

1. 把 `figma.config.json` 的 `label` 临时改成如 `React (preview)`。
2. `npx figma connect publish` 发布。
3. 让用户在 Figma Dev Mode 中选中组件实例，查看 Code Connect 面板里的片段是否正确。
4. 验证完毕：`npx figma connect unpublish`（或按节点 + 临时 label 撤销），把 label 改回并正式发布。

## 4. 发布后验证

- Dev Mode 中选中组件实例：片段与属性切换联动（改变体、开关布尔后片段随之变化）、导入语句正确、`source` 链接可跳转。
- 嵌套组件：父组件片段里的子组件按 `nestable` 内联或显示为胶囊；不应出现 `[object Object]`、`undefined` 或错误段。
- MCP 可用时用 `get_code_connect_map` 回查映射。

## 5. 失败处理

| 现象 | 处理 |
|---|---|
| 401 / 403 | 令牌缺失、过期或权限不足；或套餐不是 Organization/Enterprise；或无文件编辑权限 → 让用户检查，不要重试写入 |
| 找不到节点 / node 无效 | `url` 中 node-id 错误、组件已删除或未发布；分支文件需使用分支 key |
| 发布数量为 0 | `include` 未匹配到模板，或文件被 `exclude` |
| 同一节点多份片段冲突 | 同一 label 下同时存在 parser 与 parserless 来源，删除/撤销其一 |
| 429 | 速率限制，稍后重试，批量时分批发布 |

更多运行时错误见 `pitfalls-and-errors.md`。
