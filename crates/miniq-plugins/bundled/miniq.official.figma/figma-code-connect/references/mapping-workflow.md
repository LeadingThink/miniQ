# 映射流程详解（MCP 优先，REST + CLI 回退）

本文件展开 SKILL.md 的分步流程，给出每一步的调用示例、判断规则与批量模式的做法。所有 MCP 调用都通过 `mcp_call`，服务器名为 `figma`（远程）或 `figma-desktop`（本地）。

## 1. 解析 Figma 链接

| 链接形态 | fileKey | nodeId |
|---|---|---|
| `https://www.figma.com/design/<key>/<名称>?node-id=12-34` | `<key>` | `12:34` |
| `https://www.figma.com/file/<key>/<名称>?node-id=12-34` | `<key>` | `12:34` |
| `https://www.figma.com/design/<key>/branch/<branchKey>/<名称>?node-id=5-6` | `<branchKey>` | `5:6` |

规则：URL 里的连字符在工具参数中换成冒号；写进模板注释 `// url=` 时保留原始 URL 形式（连字符）即可。

示例：`https://www.figma.com/design/Ab12Cd34/Acme-UI?node-id=210-77` → `fileKey = "Ab12Cd34"`，`nodeId = "210:77"`。

## 2. 选择服务器

```json
{"server":"figma","tool":"tools/list","arguments":{}}
```

- 成功：记录返回的工具清单与参数 schema，后续严格按 schema 传参。
- 首次调用会弹出浏览器 OAuth 登录；让用户完成登录后重试一次。
- 返回 403 / “client not allowed” / 连接失败：改用 `{"server":"figma-desktop","tool":"tools/list","arguments":{}}`。桌面端要求：Figma 桌面应用已打开目标文件、Dev Mode 中启用了 MCP 服务器（本地端口 3845）。
- 两者都失败：告知用户原因，进入第 9 节回退路径。

## 3. 识别组件

1. 选区较大（整页、画板）时先看结构：
   ```json
   {"server":"figma","tool":"get_metadata","arguments":{"fileKey":"Ab12Cd34","nodeId":"210:77"}}
   ```
   从返回的图层树中找 `COMPONENT` / `COMPONENT_SET` / `INSTANCE` 节点。
2. 查询未映射的已发布组件：
   ```json
   {"server":"figma","tool":"get_code_connect_suggestions","arguments":{"fileKey":"Ab12Cd34","nodeId":"210:77","excludeMappingPrompt":true}}
   ```
   - 用户给的可能是实例、某个变体或整个画板，工具会把它们归并到主组件；**后续一律使用返回的 `mainComponentNodeId`**。
   - 返回多个组件时，对每个组件分别执行第 4–8 步。
   - “No published components found…”类提示：选区里没有已发布组件 → 让用户先在 Figma 发布到团队库，停止。
   - “All component instances … already connected…”类提示：全部已映射 → 汇报并停止（除非用户要更新现有模板）。

## 4. 检查已有映射与模板

- Figma 侧：
  ```json
  {"server":"figma","tool":"get_code_connect_map","arguments":{"fileKey":"Ab12Cd34","nodeId":"210:77"}}
  ```
  返回节点到源码位置/组件名的映射。已有映射的组件归入 **skipped**，除非用户明确要求覆盖更新。
- 仓库侧（`shell_run`）：
  ```bash
  python3 <技能目录>/scripts/code_connect_tool.py scan . --json
  ```
  列出所有 `*.figma.js` / `*.figma.ts` / `*.figma.tsx` 及其 `url`、`source`、`component`、`id`、格式（parserless / parser）。同一 node-id 已有模板时，更新而不是再建一份。
- 已存在 parser 格式的 `.figma.tsx`（`figma.connect()`）时不要改它；如需 parserless 版本，另建同名 `.figma.js/.figma.ts`，并提醒用户同一节点同一 label 只应保留一种发布来源，避免冲突。

## 5. 读取组件属性

```json
{"server":"figma","tool":"get_context_for_code_connect","arguments":{
  "fileKey":"Ab12Cd34","nodeId":"210:80",
  "clientFrameworks":["react"],"clientLanguages":["typescript"]}}
```

- `clientFrameworks`：优先取 `figma.config.json` 里的 `parser`（如 `react` → `["react"]`），否则根据依赖（`package.json` 中有 `react` / `vue` / `@angular/core` 等）判断。
- `clientLanguages`：按项目主要扩展名推断（`.ts/.tsx` → `typescript`，`.js/.jsx` → `javascript`）。
- 每个组件单独调用一次。
- 把属性整理成清单，建议保存为 JSON（供 `lint --props` 做覆盖检查），格式：
  ```json
  [{"name":"Tone","type":"VARIANT","values":["Neutral","Info","Danger"]},
   {"name":"Title","type":"TEXT"},
   {"name":"Dismissible","type":"BOOLEAN"},
   {"name":"Leading icon","type":"INSTANCE_SWAP"},
   {"name":"Body","type":"SLOT"}]
  ```

属性类型含义：

| 类型 | 含义 | 模板取值方法 |
|---|---|---|
| TEXT | 文字内容（标题、占位符） | `getString` |
| BOOLEAN | 开关（显示图标、禁用） | `getBoolean` |
| VARIANT | 枚举（尺寸、风格、状态） | `getEnum`（全部取值都要映射） |
| INSTANCE_SWAP | 可替换的嵌套实例（图标、头像） | `getInstanceSwap` + `executeTemplate` |
| SLOT | 自由内容区域 | `getSlot`（直接插值，不能 `executeTemplate`） |

## 6. 寻找候选代码组件

1. 读 `figma.config.json`：`include` 决定模板放哪里；`paths`/`importPaths` 给出导入别名与目录映射，用于写 `imports`。
2. 搜索（`file_glob` / `file_grep`）：
   - 文件名：`**/Alert.{tsx,jsx,ts,js,vue,svelte}`、`**/alert/index.*`。
   - 导出：`export (function|const|class) Alert\b`、`export \{[^}]*\bAlert\b`。
   - 常见目录：`src/components/`、`components/`、`lib/ui/`、`app/components/`、`packages/*/src/`。
3. 读候选文件的 Props（`interface AlertProps` / `type Props` / `defineProps` / `@Input()`）。
4. 打分依据（由高到低）：
   - 名称一致或语义一致（Figma “Alert Banner” ↔ 代码 `Alert`）。
   - VARIANT 取值能对应到 Props 的联合类型（`'neutral' | 'info' | 'danger'`）。
   - BOOLEAN 能对应到布尔 prop 或可选 prop 的有无。
   - INSTANCE_SWAP / SLOT 能对应到 `icon`、`children`、`ReactNode` 类 prop。
   - 位于设计系统包而非业务页面内部。
5. 结论：
   - 唯一且吻合度高 → 直接采用，在汇总中写明理由。
   - 多个接近 / 没有候选 / 关键属性对不上 → `ask_user`，给出最接近的 1–2 个候选（路径 + 理由）并允许用户输入其他路径。

## 7. 属性对齐原则

- Props 接口是**唯一权威**的属性名来源；Figma 属性找不到合适的 prop 时省略，并在汇总里说明，**不要编造 prop**。
- 名称不同但语义相同时做转换（Figma `Tone=Danger` → `severity="error"`）。
- 纯视觉属性（如设计稿里的“Show focus ring”预览开关）通常没有代码对应，省略即可。
- 多个 VARIANT 共同决定输出结构时，按组合写分支（见 `advanced-patterns.md`）。

## 8. 写模板与写入 Figma

- 模板写法见 `template-api.md`；复杂嵌套见 `advanced-patterns.md`。
- 写完先本地校验（`publish-and-validate.md`）。
- 写入 Figma 的两条路：
  - MCP：`add_code_connect_map`（单个）或 `send_code_connect_mappings`（批量）。嵌套使用的子组件需在 `templateDataJson` 中带 `"nestable": true`。
  - CLI：`figma connect publish`。
- 任何写入前**先 `ask_user`**，列出组件、文件、label、服务器/命令，得到同意再执行。

## 9. 回退路径（两个 MCP 都不可用）

1. `skill_read` 读取 `figma-rest-export`，确认 `FIGMA_TOKEN` 已配置（只检测是否存在，不打印值）。
2. 拉取组件节点：
   ```bash
   curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
     "https://api.figma.com/v1/files/$KEY/nodes?ids=210:80" -o /tmp/cc-node.json
   ```
   组件集（COMPONENT_SET）或独立组件节点的 `componentPropertyDefinitions` 字段就是属性定义。
3. 提取为属性清单：
   ```bash
   python3 <技能目录>/scripts/code_connect_tool.py props /tmp/cc-node.json --out /tmp/cc-props.json
   ```
   注意 REST 返回的属性名可能带 `#123:4` 之类的后缀（TEXT/BOOLEAN/INSTANCE_SWAP），脚本会输出去掉后缀的 `name` 并保留原始 `rawName`；模板中使用去后缀的显示名。
4. 已有映射只能靠仓库扫描判断（REST 不提供 Code Connect 映射查询）。
5. 写模板、校验后用 CLI 发布，令牌来自环境变量 `FIGMA_ACCESS_TOKEN`（需要 Code Connect 写权限与文件读权限的个人访问令牌）。

## 10. 批量模式

组件较多（如整套设计系统）时：
1. 先完整枚举：`get_code_connect_suggestions` + `get_code_connect_map` + 仓库 `scan`，形成总表（每个组件一行，键为 `mainComponentNodeId`）。
2. 对总表逐个执行第 5–7 步；可以把“候选查找”批量完成后，**一次性**用 `ask_user` 让用户确认所有有歧义的组件，减少来回。
3. 生成模板；每写完一批运行一次 `lint` 目录检查。
4. 发布前再次 `ask_user` 确认整体清单。
5. 按 SKILL.md 的五段格式汇报，并核对：总表中每个组件都恰好落在 created / skipped / unresolved 之一，没有遗漏或重复。

汇总示例（精简）：

```
1. 发现的组件：Alert(210:80)、Tag(210:95)、Avatar(211:3)
2. 已有映射：Avatar → src/components/Avatar.tsx（Figma 已映射）
3. 候选代码组件：Alert → src/components/feedback/Alert.tsx（Tone 三值与 severity 一一对应）；Tag → 未找到（最接近：Badge.tsx、Chip.tsx）
4. 推荐模板：src/components/feedback/Alert.figma.js
5. 动作：created Alert.figma.js；skipped Avatar（已映射）；unresolved Tag（等待用户选择 Badge 或 Chip）
```
