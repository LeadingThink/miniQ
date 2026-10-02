# 评审 R1：对齐完整度与事实准确性

> 评审对象：`04-plan-draft-v1.md`（581 行）
> 对照资料：`02-codex-local-plugin-implementation.md`（本机 ChatGPT.app 26.901.51231 调研）、`03-openai-official-docs.md`（官方文档调研）
> 评审视角：与 ChatGPT/Codex 的功能与体验对齐是否完整、格式/协议描述是否准确、兼容策略是否合理
> 范围说明（如实交代）：
> - 本轮细读了方案 §0–§5.4（约第 1–410 行）。§5.4 之后的里程碑、UI、安全等章节（第 410–581 行）**只做了粗读，未逐条核对**，相关判断都标了"未核实"。
> - 外部事实（rmcp、各厂商 MCP 端点、Node 权限模型、MCP Apps 标准现状）本轮**没有做网络核实**，第 3 节只列出待核实项和建议的核实方法，没有下结论。
> - 本机文件方面，只采用了 02 已记录的证据，本轮没有重新读取 `~/.codex` 与 ChatGPT.app。
> - **引用可信度说明**：本轮完整读到的是 03 第 1–480 行、02 第 520–631 行（§7–§10）和方案第 90–410 行。02 §2–§6 的正文在评审上下文中被压缩，没有逐字读到。因此，凡证据只指向 02 §2–§6 的具体细节，都需要对照 02 原文复核后再采纳，包括：`AppToolApproval` 枚举 `auto|prompt|writes|approve`、审批记忆三档 `persist/always/session`、hook handler 类型、`<ver>+codex.<cachebuster>`、UI 状态码、`request_plugin_install` 参数、`plugin/share/*`、runtime.json、`omit_tools_from` 取值。

---

## 1. 问题清单

### 阻断（B）

**B1. §4.2 MCP 配置模型声称"与 Codex `[mcp_servers.<id>]` 字段保持同名"，实际多处不同名**
- 问题：
  - 方案写的是 `headers`、`bearer_token_env`、`[servers.x]`。Codex 实际使用 `http_headers`、`env_http_headers`、`http_headers_helper`、`bearer_token_env_var`，表名是 `[mcp_servers.x]`。
  - 方案遗漏了 `auth`（`oauth`|`chatgpt`）、`scopes`、`oauth_resource`、`required`、`omit_tools_from`、`tools.<t>.output_token_limit`、`supports_parallel_tool_calls`、`startup_timeout_ms`。
  - 审批枚举对不上：方案是 `auto|ask|never_ask|deny`；本机 `AppToolApproval` 是 `auto|prompt|writes|approve`，官方文档出现过 `prompt`/`approve`。
- 后果：宣称的"导入零映射"不成立。按字面实现后，导入 Codex 配置会静默丢失字段，审批语义也会被错配：Codex 的 `approve` 表示自动批准，很容易被误读成"需要批准"。
- 证据：02 §4.1、§4.3；03 §3.2；https://developers.openai.com/codex/config-file/config-reference
- 建议：
  1. 二选一：要么字段完全沿用 Codex 名称（推荐，`[mcp_servers.x]` + 同名键）；要么删掉"同名"表述，在 §4.8 附一张显式映射表。
  2. 审批枚举给出与 Codex 的双向映射表，并标明 `approve` = 不询问、`writes` = 仅写操作询问。`writes` 这个中间档对 miniQ 很有价值，建议纳入。
  3. 补上 `required`（启动失败即报错）、`output_token_limit`、`omit_tools_from`。

**B2. §3.1 读取规则把 `.codex-plugin/plugin.json` 写成"否则"分支，与官方的 overlay 语义不符**
- 问题：
  - 官方规则是：根 `plugin.json` 与 `.codex-plugin/plugin.json` 可以**同时存在**。当 `extensions.com.openai` 是对象时，它**整体替换** overlay，两者不合并；缺失时才由 overlay 提供 OpenAI 设置。
  - 有根清单时，技能一律从 `skills/` 发现、MCP 一律从 `mcp.json` 发现。extension 或 overlay 中的 `skills`/`mcpServers` **不能**增删这些组件，只对没有根清单的旧包生效。
  - 方案的第 5 条 interface 优先级（dev.miniq → com.openai → 顶层推导）没有覆盖"根清单 + overlay 并存"的情形。
- 后果：同一个插件包在 Codex 与 miniQ 中展开出的组件集合可能不一致，这属于兼容性硬伤。
- 证据：03 §1.1–1.2；https://developers.openai.com/plugins/build/plugins#add-openai-specific-metadata
- 建议：
  1. 把读取规则改成"根清单为主 + overlay 合并规则"。
  2. 写明两种来源的 MCP 文件名：根清单用 `mcp.json`，旧版用 `.mcp.json`。
  3. 为每条规则补一个 golden 测试夹具，至少覆盖本机 13 个 bundled 插件和 5 个 runtime 插件的目录形态。

**B3. §3.1/§2.2 `.app.json` 被写成"miniQ 解释为 connector id"，但 miniQ 没有可解析这些 ID 的后端**
- 问题：
  - `.app.json` 中的 `id` 是 ChatGPT 平台侧的注册 ID：官方示例是 `asdk_app_…`，本机看到的是 `connector_<hex>` 和 `connector_openai_…`。这些 ID 的工具由 OpenAI 服务端托管，并通过 ChatGPT 账号完成授权。
  - miniQ 无法把这些 ID 解析成任何可调用的端点。方案 §2.2 又把 Connector 定义为"带 OAuth 模板的远程 MCP server"，与 `.app.json` 的语义是两回事。
- 证据：02 §7、§6.2 sites/spreadsheets；03 §1.1 `.app.json` 示例
- 建议：
  1. 明确 `.app.json` 在 miniQ 中的语义：只有当 ID 命中 miniQ 自有"connector 目录"（ID → remote MCP URL + OAuth 模板 + 图标）时才生效；否则把插件标为"部分可用：需要 ChatGPT App X"，并尊重 `required: true`（必需 App 不可用时整个插件不可用，对应状态码 `required_app_unavailable`）。
  2. 自有 connector 用独立命名空间（如 `miniq_conn_…`），避免与 OpenAI ID 冲突。

### 重要（I）

**I1. §3.2 个人 marketplace 与 Codex 共用 `~/.agents/plugins/marketplace.json`，但缺少宿主能力门控**
- 问题：共用路径以后，Codex 专用插件会原样出现在 miniQ 中，例如依赖 `desktop-mcp.json` 管道、`node_repl`、`SkyComputerUseClient`、ChatGPT connector 的插件。方案没有定义"本宿主不可用"的判定和展示方式。
- 证据：02 §1.5、§6.2、§5.4（Codex 自己也有 "Plugins are not available for this host"、"Unavailable in this context"）；03 §1.7 Desktop only
- 建议：
  1. 增加 `HostCompatibility` 判定：不支持的贡献（desktop-mcp、未知 connector、`policy.products` 不含 miniQ）逐项降级。
  2. UI 显示原因，整条插件不报错。
  3. 同时遵循官方规则："source 无法解析时只跳过该条目"。

**I2. §3.2 marketplace 条目字段与规则不完整**
- 问题：
  - 官方要求每个条目**必须**有 `policy.installation`、`policy.authentication`、`category`。方案只写了"与官方同义"，没有写成校验规则。
  - 方案遗漏了 `policy.products`（产品门控）、字符串形式的 local `source`、本地插件缓存版本为 `local`、源中删除的条目标记为 "No longer in source"、无效更新保留上一版本、管理员 marketplace（系统 config / 云端托管）。
  - 方案自造的 `https-archive` source 类型会被 Codex 校验器拒绝，也没有命名空间。
- 证据：03 §1.4、§1.6；02 §1.6、§3.2
- 建议：
  1. 补全以上字段和规则。
  2. `https-archive` 只用于 miniQ 官方索引（`index.json`），不要写进公开的 `marketplace.json` 格式；如果一定要写，改名为带前缀的 `x-miniq-archive`，并在导出/校验时给出警告。

**I3. §3.1 未写明 hooks 声明的"替换"语义与 Codex 的 hooks 完整结构**
- 问题：
  - `extensions.com.openai.hooks` 可以是路径、路径数组、内联对象或对象数组。显式声明会**替换**默认的 `hooks/hooks.json` 发现，不是叠加。
  - 方案 §5.4 只有"命令型 handler"。Codex 的 hooks 结构是"事件 → matcher 组 → handlers"；handler 字段有 `statusMessage`、`async`、`additionalContextLimit`、`commandWindows`；UI 可见的 handler 类型有 `command`/`mcp_tool`/`prompt`/`agent`。
  - 执行和管理规则也有遗漏：同一事件匹配到的多个命令并发执行；等待 elicitation 的时间不计入 hook 超时；托管 hooks（`allow_managed_hooks_only`、`hooks.managed_dir`）；单次绕过开关 `--dangerously-bypass-hook-trust`；模板变量 `${hook_event_name}`/`${session_id}`/`${turn_id}`；配置层全部叠加。
- 证据：03 §1.2、§5.1；02 §4.6；https://developers.openai.com/codex/hooks
- 建议：
  1. §5.4 按上述结构重写配置 schema，P1 做 `command` 与 `async`，`mcp_tool`/`prompt`/`agent` 列入 P2。
  2. stdout 输出 JSON 的精确字段（`decision` 还是 `hookSpecificOutput.permissionDecision` 等）本轮**未核实**。需要逐字对照 Codex hooks 文档和 Claude Code hooks 文档后再定稿，否则"与 Codex/Claude 字段同名"的表述有风险。

**I4. §4.6 OAuth 细节与 Codex 行为有出入**
- 问题：
  - 方案的回调写死为"随机端口 + 固定路径 `/oauth/callback`"。Codex 支持 `callback_port`/`callback_url`（全局 `mcp_oauth_callback_port/url`；插件 `.mcp.json` 中是 camelCase 的 `oauth{clientId, callbackUrl, callbackPort}`），因为部分服务器只接受预注册的固定回调。
  - 方案遗漏了几条行为规则：
    - 403 insufficient scope 时**不自动**重新登录；
    - scopes 优先级是"配置优先，其次服务器公布"；
    - 整个流程要回传 `resource`（RFC 8707，对应 `oauth_resource`）；
    - 某些回调形态只能走 DCR 或预配 client；
    - `mcp_oauth_credentials_store`（凭据存储后端可选）。
  - CIMD 方案需要 miniQ 托管一个公网 HTTPS 的 client metadata 文档，并在其中声明 loopback redirect。这项运维依赖没有列入交付项。
- 证据：03 §3.2–3.3；02 §4.2；https://developers.openai.com/codex/extend/mcp#oauth-client-registration
- 建议：补齐上述字段和行为；把"托管 CIMD 文档 + 域名"列为 P1 的外部依赖。`mcp login --oauth-client-registration auto|cimd|dcr` 与 Codex 保持一致。

**I5. §4.5 审批映射缺少 App 级风险开关和用户侧"询问频率"**
- 问题：
  - Codex 有 App/connector 级开关 `destructive_enabled`、`open_world_enabled`、`default_tools_enabled`，可以整体屏蔽某类工具。
  - ChatGPT 自 2026-06-12 起，用户可以按全局或按应用选择"总是询问 / 变更前询问 / 仅重要变更前询问"。
  - Codex 的审批记忆有 `persist/always/session` 三档，方案只有两档。
  - 方案没有覆盖 `approval_policy.granular.{mcp_elicitations, skill_approval}`。
- 证据：02 §4.3；03 §3.4、§4.3；https://developers.openai.com/plugins/changelog
- 建议：审批卡的记忆范围对齐三档；增加 server 级 `destructive_enabled`/`open_world_enabled`；elicitation 是否弹出纳入审批策略。

**I6. §4.8 导入策略缺少"不可移植插件"的分类，也遗漏了若干来源**
- 问题：
  - `~/.codex/plugins/cache` 中的 bundled 和 runtime 插件大量依赖宿主私有设施：`computer-use-client-launcher` → `SkyComputerUseClient`、`CODEX_APP_TOOLS_PIPE_PATH`、`cua_node`、runtime 包中的 LibreOffice/poppler。直接导入只会产生坏插件。
  - 导入源遗漏了：
    - Codex 仓库级 `.codex/config.toml` 的 `[plugins]` 与 `[plugins."x".mcp_servers.y]` 策略；
    - `~/.codex/hooks.json`、`<repo>/.codex/hooks.json`；
    - 技能目录 `~/.agents/skills`、`<repo>/.agents/skills`、`~/.codex/skills`；
    - `[[skills.config]] enabled=false`；
    - `[marketplaces.*]` 注册表（可以直接复用 Git 源）。
- 证据：02 §2.5、§6.2、§3.6、§8；03 §1.6、§2.3、§2.6、§5.1
- 建议：
  1. 导入时逐项标注"可移植 / 需替代（映射到 miniQ 系统插件）/ 不可用"。
  2. 对 `openai-bundled`、`openai-primary-runtime` 默认不导入插件本体，只导入 marketplace 注册和用户自装插件。
  3. hooks 导入后一律处于"未信任"状态。

**I7. §2.3 项目级配置路径与 Codex 不同，未说明共存规则**
- 问题：方案用 `<ws>/.miniq/plugins.toml` 和 `<ws>/.miniq/hooks.json`；Codex 用 `<repo>/.codex/config.toml` 与 `<repo>/.codex/hooks.json`。两者都只在受信项目生效。方案没说明是否读取 `.codex/`，也没说明冲突时的优先级。
- 证据：03 §1.6、§5.1
- 建议：只读兼容 `.codex/config.toml` 的 `[plugins]` 段与 `.codex/hooks.json`，默认关闭，在导入向导中开启。优先级写成：`.miniq` > `.codex` > 用户层。

**I8. §5.3 `agents/openai.yaml` 字段覆盖不全**
- 问题：
  - 方案遗漏了 `interface.icon_small`/`icon_large`/`brand_color`/`default_prompt`（技能级 starter prompt），以及 `dependencies.tools[]` 的 `type/value/description/transport/url` 结构。
  - 结构写全后可以做到"技能依赖的 MCP 一键添加"（对应 Codex 的 `features.skill_mcp_dependency_install`，具体行为**未核实**）。
- 证据：03 §2.5
- 建议：按官方 YAML 结构完整解析；技能详情页的"需要连接 X"升级为"添加并连接"。

**I9. §4.4 工具命名与 Codex 的差异未核实**
- 问题：`mcp__<server>__<tool>` 是 Claude Code 的约定。Codex 对模型暴露的 MCP 工具名格式本轮**未核实**。另外 Codex 有 `omit_tools_from:["code_mode","deferred"]`，可以让某些工具豁免延迟加载，方案的"≤20 直接内联"阈值规则没有这类按 server 的例外。
- 证据：02 §4.1（unified-computer-use `.mcp.json`）
- 建议：增加按 server 或工具的 `defer = never|auto|always`；命名在核实 Codex 源码后再定稿。

### 建议（S）

- **S1（§4.7）**：补充"读取 server `initialize.instructions` 并注入上下文"（ChatGPT 自 2026-05-26 起支持），同时限制长度并标注为不可信。证据：03 §3.4。
- **S2（§4.4）**：官方明确 `_meta` 只给组件、对模型隐藏。方案应规定 `_meta` 不进入模型上下文，只在 UI 渲染时使用。证据：03 §3.4、§4.1。
- **S3（§5.2）**：`request_plugin_install` 对齐 Codex 的参数：`tool_type`（`connector`|`plugin`）、`action_type`、`plugin_id`、`suggest_reason`。同时补上"禁止与其他工具并行调用""前置条件：`tool_search` 已穷尽且插件位于 recommended 列表""可持久化禁用建议""配置键 `plugins.recommendations` 可关闭"。证据：02 §2.4。
- **S4（§3.3）**：本地开发的缓存击穿，对齐 `<ver>+codex.<cachebuster>` 的替换式约定，或者直接用 `local` 版本 + 内容哈希。证据：02 §3.5；03 §1.5。
- **S5（§1/§2.1）**：UI 状态码建议复用 Codex 的细分：`disabled_by_admin`、`plan_not_eligible`、`required_app_unavailable`，以及 "Refresh to use new skill(s)"。证据：02 §5.4。
- **S6（§5.3）**：显式提及语法。ChatGPT 用 `@skill`，Codex 用 `$skill`（桌面端 `@` 菜单也列出技能）。建议 miniQ 两者都支持，统一走结构化 mention。证据：03 §2.4。
- **S7（§6+ 里程碑）**：本轮**未核实**方案后半部分是否已覆盖下表中的大功能。建议作者对照下表逐项标注"已含 / 新增 / 不做 + 理由"。

---

## 2. 建议新增的大功能

| # | 功能 | ChatGPT/Codex 证据 | 对 miniQ 的价值 | 里程碑 | 粗略工作量 |
|---|---|---|---|---|---|
| F1 | 统一提及：`plugin://name@mkt`、`app://id`、带参数的浏览器标签页提及，以及结构化 `mention` 输入项 | 02 §5.2 | 让用户可以显式点名插件、connector 或标签页，这是体验差距最大的一项 | P1 | 中（Composer + 协议 5–8 人日） |
| F2 | 插件详情页的 starter prompts、"Try in chat"，以及贡献物清单（工具数、hooks 待审数） | 02 §5.1、§5.3 | 降低首次使用门槛 | P1 | 小（3–5 人日） |
| F3 | 宿主能力门控与不可用原因展示（Desktop only、需要 App、需要运行时） | 02 §5.4；03 §1.7 | 与 Codex 共用 marketplace 的前提（对应 I1） | P1 | 小–中 |
| F4 | 从对话生成插件或技能（plugin-creator / skill-creator、"Describe your plugin"），外加 validator | 03 §1.5、§2.6；02 §5.1 | 生态冷启动；miniQ 已有 `develop-miniq-plugin` 技能，可以升级 | P1 | 中（技能 + validate RPC） |
| F5 | 定时任务 / 自动化与插件结合（插件详情页挂定时任务；自动化可指定插件和技能） | 02 §8（`automation.toml`、`use-plugin-scheduled-tasks`） | miniQ 已有定时任务，结合后可以做"每日 Linear 汇总"这类场景 | P2 | 中 |
| F6 | 子代理与插件：`SubagentStart/Stop` hooks，Claude `agents/*.md` → 子代理预设，子代理继承或限定插件集 | 03 §5.1；方案 §3.1 已列 P2 | 与 Claude 插件格式兼容 | P2 | 中 |
| F7 | MCP Apps UI 渲染：`ui://` 资源，MIME `text/html;profile=mcp-app`，`_meta.ui.resourceUri`，`ui/*` 消息，CSP 三类域名，沙箱 iframe，移动端 WebView | 03 §4.1 | 官方目录中带 UI 的插件可以直接复用；需要评估移动端 | P2（P1 先做只读结构化结果卡） | 大（15–25 人日，安全审查另计） |
| F8 | 工作区共享 / 发布（`plugin/share/*`：链接可见范围、查看/编辑权限、"Shared version is out of date"） | 02 §3.4；03 §1.7 | 团队场景；可以先用"导出为 Git marketplace + 邀请链接"替代 | P3 | 大（需要服务端） |
| F9 | 管理员托管：admin marketplace、强制安装或禁用、MCP identity 白名单（`identity.url.match`）、托管 hooks | 03 §3.2、§5.1；02 §3.3 | 企业与服务器部署场景 | P3 | 中–大 |
| F10 | 重型运行时按需下载（runtime.json：node/python/LibreOffice/poppler，`skillsToRemove` 迁移） | 02 §3.6 | 文档类、电脑操作类系统插件的安装包瘦身 | P2 | 中–大（签名、CDN、断点续传） |
| F11 | Record & Replay：演示操作 → 生成技能 | 02 §6.1（event-stream MCP）；03 §2.6 | 差异化能力，依赖电脑操作与事件采集 | P3 | 大 |
| F12 | Connector 多账户与昵称、重连、"Authentication update required" | 02 §4.2、§7 | 同一服务接入个人与工作两个账号 | P2 | 中 |
| F13 | 浏览器插件的按站点权限矩阵（打开、上传、下载、历史、CDP、WebMCP） | 02 §4.3、§5.1 | miniQ 浏览器系统插件的安全对齐 | P2 | 中 |
| F14 | 全局开关 "Allow … to use installed plugins"，以及 "Request a plugin" 入口（带限流） | 02 §5.1 | 便于排障，也能收集用户需求 | P1（开关）/ P3（请求） | 小 |
| F15 | Company knowledge 兼容：识别标准 `search`/`fetch` 工具，输出带绝对 URL 的引用 | 03 §3.4 | 让知识库类 MCP 自动接入引用渲染 | P2 | 小–中 |

---

## 3. 外部事实核实（本轮未完成，全部标"未核实"）

| 事项 | 方案中的依赖 | 状态 | 建议核实方式 |
|---|---|---|---|
| rmcp 是否支持 streamable-http client 与 OAuth | §4.1 整体选型 | **未核实**。评审者印象中 rmcp 有 `transport-streamable-http-client`、`auth` 等 feature，但版本号、对 CIMD 的支持、2025-11-25 协议版本的支持都未确认 | 查 https://github.com/modelcontextprotocol/rust-sdk 的 `crates/rmcp/Cargo.toml` features 与 examples；在 PoC 中连接 Linear/GitHub 远程 MCP 跑通 OAuth |
| GitHub/Notion/Linear/Atlassian/飞书 官方 MCP 端点与认证方式 | §4.2 示例、官方目录预置 | **未核实**。方案示例 `https://mcp.linear.app/mcp` 未验证；飞书是否提供官方远程 MCP 未知 | 逐家查官方文档，记录 URL、传输方式（SSE 还是 streamable-http）、认证方式（OAuth DCR/CIMD 或 PAT） |
| Node 22/24 权限模型能否限制网络 | §6+ Node 原生工具沙箱（未细读） | **未核实**。评审者印象中 `--permission` 在 22/24 覆盖文件系统、child_process、worker、addons，**不含网络**。如果属实，网络隔离必须依赖 OS 沙箱或代理 | 查 https://nodejs.org/api/permissions.html（v22、v24 两个版本） |
| MCP Apps 标准（`ui://`）现状 | F7 | 部分核实：03 记录 ChatGPT 自 2026-02-22 起兼容 MCP Apps，规范地址是 https://apps.extensions.modelcontextprotocol.io/api/ 。标准的版本和稳定性**未核实** | 抓取规范页，确认版本、宿主必选能力、安全要求 |
| hooks stdout 输出 schema | I3 | **未核实** | 对照 https://developers.openai.com/codex/hooks 与 Claude Code hooks 文档原文 |

---

## 4. 兼容策略总体评价

- 方向合理：以 Agent Plugins 1.0 为主格式，兼容 `.codex-plugin`、`.claude-plugin` 和 miniQ v1，并把 Loader 统一到内部模型。
- 主要风险是"声称同名、实际不同名"：B1、I3、I9 都属于这类，会让导入和双向兼容在细节上失败。
- 建议新增一份《兼容矩阵》附录，逐字段列出"官方名 / Codex 本机名 / Claude 名 / miniQ 名 / 读写方向 / 测试夹具"。
- 本机 18 个 Codex 插件（13 个 bundled + 5 个 runtime）与若干 Claude 插件应作为回归夹具。
- 与 Codex 共用 `~/.agents/plugins` 是好决定，但必须同时交付 I1 的宿主能力门控。
