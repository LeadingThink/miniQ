# 第二轮评审：功能对齐与用户体验（05-plan-v2.md）

- 评审对象：`05-plan-v2.md`（1718 行）
- 参考：`02-codex-local-plugin-implementation.md`、`03-openai-official-docs.md`、`01-miniq-plugin-inventory.md`、`review-r1-parity.md`
- 官方文档核实（2026-09-26 curl）：
  - `developers.openai.com/codex/config-reference`：请求超时，但已取回约 1 MB 页面内容，可检索到 `approval_mode` 的类型为 `auto | prompt | writes | approve`，以及 `http_headers_helper`、`startup_timeout_ms`、`experimental_environment`、`output_token_limit`。页面不完整，其余字段**部分核实**。
  - `/codex/plugins`：页面由前端渲染，静态 HTML 里只能看到 `defaultPrompt`、`logo`，其余字段**未核实**，以 03 摘录为准。
  - `/codex/skills`、`/codex/mcp`：未抓取，**未核实**。
- 分级：阻断(B) / 重要(I) / 建议(S)

---

## 0. 总体判断

v2 相比 v1 是**实质性的大完善**，不是小修小补：

- §1.2 把 F0a/F0b + F1–F15 列成大功能清单，覆盖了市场、远程 MCP + OAuth、连接器目录、统一提及、推荐安装、starter prompts、宿主门控、hooks、MCP Apps、企业托管、多账户、运行时按需下载、company knowledge。ChatGPT/Codex 客户端插件体系的主要能力面没有明显漏项。
- 用户旅程基本闭环：
  - 发现：§12.1 发现页、§9.5 推荐安装、项目推荐。
  - 安装：§6.4 事务安装 + 确认卡。
  - 授权：§7.6 OAuth，§8.3 连接器。
  - 首次使用：§9.3 starter prompts、§9.4 首次使用。
  - 日常使用：§9.1 提及、§7.4 延迟加载。
  - 更新/禁用/卸载：§6.5 权限差异、拒绝后保留旧版，卸载时清理数据和凭据。
  - 桌面、手机（§12.2）、CLI（§12.3）都有对应描述。
- 手机端能力边界清楚：写操作只做官方来源，高危信任操作显示"复制命令"到主机上完成。

问题主要在**"声称同名、实际不同名"**，也就是 R1 总结里点出的那类风险。最典型的是审批取值：v2 自造了 Codex 不存在的 `deny`，同时漏掉了 `auto`/`writes`。这一项直接破坏"从 Codex 导入配置"和"共用 marketplace/包"两条兼容承诺，因此定为阻断。其余是字段补全、旧格式发现、提及序列化、未决项收口等重要问题。

统计：**B 1 / I 8 / S 7**。结论：**修改后可交付**。

---

## 1. 阻断（B）

### B1. 审批取值与 Codex 不一致：多出 `deny`，缺少 `auto`/`writes`

- **位置**：§7.2"审批取值映射"表（约 795–803 行）；§4.3 第 4 条 `approval_mode = "deny"` → Blocked（366 行）；附录 A.3 的 approval_mode 行；附录 C.2 的 B1"✅"。
- **问题**：
  1. Codex 的 `default_tools_approval_mode` 和 `tools.<t>.approval_mode` 类型是 `auto | prompt | writes | approve`，没有 `deny`。v2 把 `deny` 当成 Codex 取值写进映射表，导出或共用配置时会产生 Codex 不认识的值。
  2. `auto` 和 `writes` 没有映射。`writes` 表示只对写操作询问，需要结合 ToolAnnotations；`auto` 表示按宿主默认策略。用户从 `~/.codex/config.toml` 导入时，这两种值会落到"未设置"，语义悄悄改变：原本只对写操作询问的配置，可能变成全部询问，也可能变成全部放行。
  3. §7.2 标题写着"逐项同名（修对齐 B1）"，但同一节又写"实际取值……开工前对照官方 config reference 复核一次"。C.2 却把 B1 标成 ✅，说明 R1 的 B1 并没有真正关闭。
- **依据**：config-reference 实测的类型串是 `auto | prompt | writes | approve`，三处定义均一致；02 §4.3 也列出 auto/prompt/writes/approve；R1 B1、R1 总结第 184 行。
- **改法**：
  - 映射表改为四值：
    - `auto`：按 §4.3 推导。
    - `prompt`：询问。
    - `writes`：`readOnlyHint=true` 且在受信任只读集合内的工具不询问，其余询问。注解不可信时按 §4.3-2 降级为 prompt。
    - `approve`：用户层"总是允许"。
  - "禁止"改用 miniQ 自有字段表达，不借用 Codex 键名。可复用 `disabled_tools`，或在 `extensions`/miniQ 专属键里增加 `blocked`，并在 A.3 标注为"miniQ 扩展，导出 Codex 时降为 disabled_tools"。
  - §4.3 第 4 条同步修改。
  - 导入向导（§11）遇到未知值时报诊断，不静默丢弃。
  - C.2 的 B1 改为"✅（取值已按 config-reference 2026-09 核实）"，删掉"开工前再复核"。

---

## 2. 重要（I）

### I1. 附录 A.3 MCP 字段仍不完整，"逐项同名"不成立

- **位置**：附录 A.3；§7.2 示例；§7.3 资源上限。
- **问题**：下列 Codex 字段在 A.3 中缺失，或只在正文零散出现：
  - `http_headers_helper`：动态 header 脚本。
  - `startup_timeout_ms`：`startup_timeout_sec` 的毫秒别名。
  - `experimental_environment`。
  - `tools.<t>.output_token_limit`：§7.3 只写了全局默认 25k，没有写逐工具覆盖。
  - `supports_parallel_tool_calls`。
  - `omit_tools_from`：§1 第 98 行提到了，A.3 没有收录。
  - `auth = "chatgpt"|"oauth"`。
  - OAuth 子表 `oauth.client_id / callback_url / callback_port`，以及插件 `.mcp.json` 中的 camelCase 写法 `oauth{clientId,callbackUrl,callbackPort}`。
  - 顶层 `mcp_optional_startup_grace_ms`。
  - requirements 中的 `identity.*`，这是 F9 白名单的数据源。
- **依据**：config-reference 实测检索到 `http_headers_helper`、`startup_timeout_ms`、`experimental_environment`、`output_token_limit`；其余见 02 §4.1、03 §3.2。
- **改法**：A.3 增加一列"miniQ 处理"，取值为"支持 / 读取但忽略并诊断 / 不支持（原因）"，把以上字段逐一列入。其中：
  - `http_headers_helper` 属于执行外部命令，放进 §4.4 的子进程隔离模型，并要求用户层信任。
  - `auth="chatgpt"` 明确标为"需要 ChatGPT 账户，不可用"，接入 §5.3 的 HostCompatibility。
  - camelCase 与 snake_case 的双向映射写入 §5.2 的解析规则。

### I2. Codex 旧格式包的组件发现规则不清：`.mcp.json`、`desktop-mcp.json`

- **位置**：§5.1 合并规则 1–2（约 516–520 行）；§4.3 第 364 行；§5.4 fixtures。
- **问题**：
  - 规则 1 说"组件只来自 `skills/` 和 `mcp.json`"。规则 2 对 overlay-only 包只写了"Codex legacy fields"，没有说明是否默认发现 `.mcp.json`、`.app.json` 和 `hooks/hooks.json`。
  - §5.4 的 fixtures 是本机 `~/.codex/plugins/cache` 下的 18 个插件，大部分正是 `.codex-plugin/plugin.json` + `.mcp.json` 结构。如果规则 2 不做默认发现，这批样本的 MCP 会全部丢失。
  - `desktop-mcp.json`（桌面特供 MCP，02 §1.5，例如 codex-app-tools 的 `codex_app`，依赖 `CODEX_APP_TOOLS_PIPE_PATH`）完全没有提及。
- **依据**：02 §1.5、§2.1；03 §1（legacy 文件名为 `.mcp.json`；portable 包的 `skills`/`mcpServers` 只在无根 manifest 的旧包中生效）。
- **改法**：
  - 规则 2 明确写出：overlay-only 包按 Codex 旧路径默认发现 `skills/`、`.mcp.json`、`.app.json`、`hooks/hooks.json`；manifest 中的 `skills`/`mcpServers`/`apps` 字段覆盖默认值。
  - 增加规则：`desktop-mcp.json` 一律**不加载**，在 HostCompatibility 中标为"平台不支持（Codex 桌面专用）"，并给出诊断码。
  - §5.4 增加断言：18 个样本解析出的 MCP server 数与 `.mcp.json` 中的条目数一致。

### I3. 提及序列化与 Codex 不互通，技能点名语法缺失

- **位置**：§9.1（987–988 行）；附录 A.5；F1。
- **问题**：
  1. v2 的纯文本序列化是 `[@Linear](app://linear)`。Codex 的格式是 `[$app-name](app://{connector_id})`，前缀是 `$`，而且 id 是 ChatGPT connector id（如 `connector_…`）。v2 用的是 miniQ 自有连接器 id `linear`。结果是会话文本、导入的 prompt、技能正文里的 app 提及在两边互相无法解析。A.5 却声称"与 Codex 一致"。
  2. Codex 技能用 `$SkillName` 显式点名，v2 没有兼容。插件的 `defaultPrompt` 和技能正文里常见 `$skill` 写法，导入后会退化成普通文本。
- **依据**：02 §2.3；A.5 第 1591 行的"一致"声明。
- **改法**：
  - 解析端同时接受 `[$name](app://<chatgpt_id>)`，通过 §8.1 的 `aliases.chatgpt_app_ids` 反查到 miniQ 连接器；以及 `[@name](app://<miniq_id>)`。
  - 输出端保持 miniQ 格式，但 A.5 改为"URI scheme 一致，id 命名空间不同，经 aliases 双向映射"。
  - 增加 `$<skill>` / `$<plugin>:<skill>` 的点名解析，行为等同于 `@` 选中技能 chip。
  - F1 的验收用例加入"导入 Codex defaultPrompt 后提及可点"。

### I4. MCP server `instructions` 与 `_meta` 未处理

- **位置**：§7.4 结果处理；§7.8；§9.2 prompt 块。
- **问题**：
  - MCP `initialize` 返回的 server `instructions` 已进入 Codex/官方文档（03 §3.4，2026-05-26 起），v2 全文没有出现，模型因此拿不到 server 自带的用法说明。
  - 工具结果的 `_meta` 同样缺失。它承载 Apps SDK 的 `openai/outputTemplate`，以及 widget 与模型可见数据的分离。F7/M6 会依赖它，但 M2 的数据结构应先保留。
- **依据**：03 §3.4；03 §4（Apps SDK UI）。
- **改法**：
  - §7.4 增加：server `instructions` 截断到 ≤1k token 后，放进 `<untrusted_tool_output source="mcp:<server>">` 包装内的"server 说明"块，只在该 server 工具被 inline 或解锁时注入。
  - 工具结果结构保留 `_meta`，默认不送给模型，M6 用于 `ui://` 渲染。

### I5. Marketplace 来源与 Codex 用法不对齐：sparse、简写、个人市场、快照字段

- **位置**：§6.1 来源表（597 行 `source = "git"|"local"|"https"`）；§6.2；附录 A.4。
- **问题**：
  1. Codex 的 `marketplace add` 支持 `owner/repo[@ref]` 简写、SSH URL 和 `--sparse <path>`，持久化字段为 `source_type / sparse_paths / last_updated / last_revision / commit_hash / repository_url`。A.4 只写了条目字段，没有写"用户添加的市场"的持久化字段，也没有 sparse。§11 从 Codex 导入 `[marketplaces]` 时会丢失 sparse 路径和版本锁。
  2. 个人市场 `~/.agents/plugins/marketplace.json` 在 Codex 中是**隐式发现、可直接安装**的，v2 定为"只读导入"。这个选择本身可以接受（D12），但体验上的差异需要写明：个人市场里的插件在 miniQ 中是否可以一键安装、安装后信任级别是什么，目前都没有说。
  3. 用户添加来源中的 `"https"` 类型在 §6.1 下方又说"`https-archive` 只用于 miniq-official"，两处矛盾。
- **依据**：02 §3.1、§3.2；02 §1.6。
- **改法**：
  - A.4 增加"marketplace 源（config.toml）"小表，字段对齐 Codex 的 `source_type/sparse_paths/last_revision…`，并写明 miniQ 的扩展。
  - CLI `miniq plugin marketplace add` 支持 `owner/repo@ref` 与 `--sparse`。
  - §6.1 删掉用户来源中的 `https`，或改成"https Git"。
  - 个人市场一行补上"可安装，信任级别=第三方，不自动更新"。

### I6. 授权旅程缺少 `ON_USE` 首用触发与"安装后待授权清单"，手机/CLI 未闭环

- **位置**：§6.4 post 步骤（654 行只写了 ON_INSTALL）；§8.1 `required`；§9.4；§12.2；§12.3。
- **问题**：
  - `policy.authentication = ON_USE` 在 v2 中只作为字段存在，没有描述首次调用时的体验：谁拦截、卡片长什么样、授权完成后是否自动重放原调用。
  - 安装流程没有类似 Codex `appsNeedingAuth` 的结构化返回。手机端和 CLI 安装完成后，用户不知道还有哪些连接器要授权。本机内置市场 `openai-primary-runtime` 全部是 ON_USE（02 §1.6），这个场景不是边角。
  - CLI 没有 `miniq plugin add` 之后的授权引导，例如提示"运行 `miniq connector connect linear`"。
- **依据**：02 §1.6、§4.2（安装返回 `appsNeedingAuth` 配合 ON_INSTALL/ON_USE）。
- **改法**：
  - `plugin.install` 返回 `{installed, needs_auth:[{connector_id, required, when: on_install|on_use}]}`。
  - 桌面端：安装完成卡逐项给出"连接"按钮。
  - 手机端：同一张卡走 paste-back。
  - CLI：打印后续命令；`--json` 输出带上该字段。
  - ON_USE：执行器在首次调用未授权连接器的工具时，返回 `needs_auth` 结果，对话中渲染"连接 X 后继续"卡片。授权成功后由用户点"继续"来重放，不自动重放，避免越权。
  - §16 加入对应的端到端用例。

### I7. C.2 中"已关闭"的 R1 项实际有两项未收口

- **位置**：附录 C.2 的 B1、I9 行；附录 A.6。
- **问题**：
  - B1 见本评审 B1。
  - I9 标为"❓（不影响实现）"，这个判断不成立。MCP 工具名格式直接影响三处：
    1. hooks matcher 兼容。§10 的示例 `mcp__linear__.*` 如果与 Codex 实际工具名不同，从 Claude/Codex 导入的 hooks 会静默不匹配。
    2. 导入的审批 pattern。
    3. `tool_search` 的 `select:` 语法。
  - A.6 的 6 个未核实项都没有负责人和截止里程碑。
- **依据**：R1 I9；R1 总结第 184 行；§3.3 自称"Codex MCP 工具名格式未核实"。
- **改法**：
  - I9 改为"⏳ M0 核实"：用本机 Codex 实际跑一次 MCP 工具调用，从会话日志或 rollout 中取工具名。结论写进 §3.3；如有差异，增加 matcher 别名映射。
  - A.6 每项补上"负责人 / 截止里程碑 / 未核实时的降级行为"三列。

### I8. Hooks 运行环境变量未对齐

- **位置**：§10（1078–1133 行）。
- **问题**：官方与 Claude 插件的 hooks 依赖 `PLUGIN_ROOT`、`PLUGIN_DATA`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`，v2 全文没有出现。脚本通常写成 `"${CLAUDE_PLUGIN_ROOT}/hooks/check.sh"`，不注入这些变量就会直接失败。这会让 §5.1 的 Claude/Codex 兼容和 §11 导入在 M4 落空。
- **依据**：03 §1（hooks 部分）。
- **改法**：§10 增加"执行环境"小节：
  - 注入上述四个变量。`*_ROOT` 指向只读 cache 目录，`*_DATA` 指向 `plugins-v2/data/<plugin>`。
  - 变量展开只作用于 `command` 字段。
  - 信任哈希在展开前计算。

---

## 3. 建议（S）

### S1. A.1 未说明 `$schema`、`id`、`publicationPolicy` 的处理

- **位置**：附录 A.1。
- **问题**：
  - 官方 `plugin.json` 带 `$schema`，URL 为 `agent-plugins.org/schemas/1.0.0/plugin.schema.json`。
  - Codex 校验器口径下有 `id`，捆绑插件有 `publicationPolicy: INTERNAL_ONLY`（02 §1.2–1.4）。
- **改法**：
  - `$schema` 读取后用于版本判定。
  - `id` 只作展示或诊断，不参与 key。
  - `publicationPolicy=INTERNAL_ONLY` 视为不可安装并给出诊断。
  - `+codex.cachebuster` 这类 semver build 元数据在版本比较中忽略。

### S2. 内部 Interface 命名与官方字段混用

- **位置**：§5.2 第 543 行（`icon`、`starterPrompts`）；§9.3 第 1009 行；A.1 第 1545 行（`logoDark`）。
- **问题**：内部结构用了 `icon`/`starterPrompts`，外部字段是 `composerIcon`/`logo`/`defaultPrompt`，映射关系只在正文零散提到。`logoDark` 不在 03 摘录的官方字段中。
- **改法**：§5.2 注释写明映射：`icon ← composerIcon ?? logo`，`starterPrompts ← defaultPrompt ∪ openai.yaml default_prompt`，截取前 3 条。`logoDark` 标为"miniQ 扩展，仅在 `dev.miniq.interface` 中有效"。

### S3. 推荐安装与 Codex 行为细节

- **位置**：§9.5（1024–1029 行）。
- **问题**：
  - Codex 的 `request_plugin_install` 不可与其他工具并行调用。
  - Codex 中用户拒绝后可以**持久**关闭该建议；v2 是 7 天冷却。
  - 安装后 Codex 会刷新 apps 缓存（02 §2.4）。
- **改法**：
  - 把"不可并行"写进工具元数据。
  - 拒绝卡增加"不再推荐此插件"选项，持久化到 `config.toml [recommend]`。
  - 安装成功后，在当前回合立即递增 `contributions_version`，让模型下一次请求就能看到新工具。

### S4. Guardian 自动审查与 elicitation 细粒度策略未提及

- **位置**：§4.3；§7.8。
- **问题**：Codex 有 `approvals_reviewer`（Guardian 自动审查）和 `approval_policy.granular.mcp_elicitations`（02 §4.3、03 §3.4），v2 全文无出现。
- **改法**：在 §1 差距矩阵或 §17 决策中明确"不做 / 推迟"，并说明导入时如何处理。建议 `mcp_elicitations` 映射到 §7.8 的开关。

### S5. 来源分类和状态缺少"工作区 / 云端 / 远程主机 / 管理员安装"

- **位置**：§12.1 来源筛选和"已安装"状态列表。
- **问题**：Codex 有 7 类来源（02 §3.3）。v2 把 F8/F9 推迟是合理的，但 UI 状态枚举没有预留"由管理员安装 / 管理员禁用"，M6 时需要改协议。
- **改法**：§13 的状态枚举先预留 `managed_installed`、`managed_disabled`，M0 的策略接口返回这两个值；UI 暂不展示。

### S6. CLI 命令名给 Codex 用户保留别名

- **位置**：§12.3。
- **问题**：Codex 用户习惯 `plugin list --available --json` 和 `marketplace upgrade`；v2 对应的是 `search`/`refresh`。
- **改法**：增加 `--available` 与 `upgrade` 作为别名，并在文档中给出对照表。成本很低，但能明显降低迁移摩擦。

### S7. 更新生效提示

- **位置**：§6.5；§6.6"生效时机"。
- **问题**：v2 的更新从"下一次模型请求"开始生效，比 Codex 的"Refresh to use new skill(s)"和"Restart to apply"更好。但进行中的回合、已挂起的审批卡、定时任务的运行中实例怎么处理，没有写。
- **改法**：补一句：回合内保持旧的有效集合，回合结束后切换；已挂起的审批按执行前二次校验（§3.2）处理，工具消失就失败并提示"插件已更新，请重试"。

---

## 4. 分项结论

| 评审内容 | 结论 |
|---|---|
| 1. 差距矩阵与功能覆盖 | 覆盖充分，属于"大的完善"。没有重大功能遗漏，只有 I4（server instructions）这类细节缺口 |
| 2. 字段对照准确性 | **不合格**，需修 B1、I1、I2、I3，以及 S1、S2 |
| 3. 用户旅程闭环 | 基本闭环，ON_USE/待授权清单（I6）和更新中途切换（S7）需补 |
| 4. R1 对齐意见落实 | B2/B3/I1–I8 基本落实；B1、I9 未真正关闭（B1、I7） |

## 5. 结论

**修改后可交付。**

必须修改：B1。强烈建议在 M0 前完成：I1、I2、I3、I6、I7。I4、I5、I8 可以在对应里程碑（M2a/M1/M4）开工前补齐。S 类按需处理。
