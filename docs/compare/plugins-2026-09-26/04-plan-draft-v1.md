# miniQ 插件体系对齐 ChatGPT/Codex：差距矩阵与技术方案（初稿 v1）

> 状态：初稿，待评审。依据 [01 miniQ 盘点](01-miniq-plugin-inventory.md)、[02 Codex 本机实现](02-codex-local-plugin-implementation.md)、[03 OpenAI 官方文档](03-openai-official-docs.md)。
> 目标读者：产品负责人确认后交给研发同事执行。本文不含代码实现。

---

## 0. 结论先行

miniQ 现在的"插件"本质上是**一个本地工具注册器**：只能从本地目录装 WASM/Node 工具或技能包，MCP 只有 stdio + 单一 `mcp_call` 入口，没有市场、没有更新、没有连接器、没有 hooks、没有 @ 提及。ChatGPT/Codex 的"插件"则是一个**能力分发单元**：一个包里打包技能、MCP server、应用连接器、hooks、UI 元数据，经 marketplace 分发、版本化缓存、按需认证、在对话里被提及和被推荐。

对齐不是给现有插件页加字段，而是要做 **五件大事**：

1. **统一插件包与市场**：采用官方可移植格式（根 `plugin.json` + `skills/` + `mcp.json` + `hooks/` + `assets/`），兼容 `.codex-plugin/` 与 `.claude-plugin/`，保留 miniQ 独有的 WASM/Node 工具作为扩展段；新增 marketplace（本地、Git、官方源）、版本化缓存、更新与回滚、CLI。
2. **MCP 2.0**：换用官方 Rust SDK，支持 Streamable HTTP、OAuth（CIMD/DCR/PKCE）、env/headers、每个 MCP 工具注册为一等工具（延迟加载 + tool_search）、按工具审批、resources/prompts/elicitation、健康状态与日志。
3. **连接器（Connectors）**：以"远程 MCP + OAuth 模板"的方式提供 GitHub、Notion、Linear、飞书、Google 等官方连接器插件，让 miniQ 第一次能"碰到用户的 SaaS 数据"。
4. **对话内体验**：`@插件/连接器/资源` 提及、`$技能` 提及、MCP prompts 进 `/` 菜单、起始提示词、模型主动推荐并请求安装插件、审批卡片支持"此工具始终允许"、MCP Apps 交互式 UI 卡片。
5. **安全与治理**：整包完整性哈希、官方源签名、分级信任、hooks 逐条信任、修复 WASM 免审批漏洞、落实 skill `allowed_tools`、插件级权限实际生效；企业托管策略作为后续能力。

另外一项独立但高杠杆的工作：**一键导入** Codex / Claude Code / Cursor 已配置的 MCP 与插件，降低迁移成本。

预计 5 个里程碑、约 16–18 周、3–4 名工程师并行（见 §9）。

---

## 1. 差距矩阵

图例：✅ 已对齐 ｜ 🟡 部分 ｜ ❌ 缺失。"优先级" P0 为必须、P1 为重要、P2 为后续。

### 1.1 包格式与分发

| 维度 | ChatGPT/Codex | miniQ 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| 清单格式 | 根 `plugin.json`（Agent Plugins 1.0），兼容 `.codex-plugin/`、`.claude-plugin/` | `manifest.toml`，`deny_unknown_fields`，id 必须反向域名 | ❌ 不兼容任何生态包 | P0 |
| 包内组件 | skills、MCP、apps、hooks、assets | tool（WASM/Node）或 skills，二选一 | ❌ | P0 |
| 展示元数据 | `interface.*`：displayName、描述、开发者、分类、能力、图标、截图、隐私/条款链接、defaultPrompt、brandColor | name/description/author | ❌ | P0 |
| Marketplace | `.agents/plugins/marketplace.json`；local/url/git-subdir/npm 源；个人/仓库/管理员/云端 | 无 | ❌ | P0 |
| 安装缓存 | `cache/<market>/<plugin>/<version>/`，运行缓存副本 | 直接复制到插件目录，无版本 | ❌ | P0 |
| 更新/回滚 | marketplace upgrade、每日同步、失败保留旧版本 | 无 | ❌ | P1 |
| 启用范围 | 用户级 + 受信任项目级 `[plugins."name@market"]` | 全局一个开关 | 🟡 | P1 |
| CLI | `codex plugin add/list/remove`、`plugin marketplace add/list/upgrade/remove`、`/plugins` | 只有通用 `miniq rpc` | ❌ | P1 |
| 官方目录 | 公共 Plugins Directory + 审核 | 无 | ❌ | P1 |
| 默认安装 | `INSTALLED_BY_DEFAULT`；13 个捆绑插件 | 能力全部内置为工具，不可按插件管理 | 🟡 | P1 |
| 迁移导入 | 支持从 Claude Code / Cursor 导入 | 仅导入外部会话，不导入插件/MCP | ❌ | P1 |

### 1.2 运行时与模型暴露

| 维度 | ChatGPT/Codex | miniQ 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| MCP 传输 | stdio + Streamable HTTP | 仅 stdio，协议 2024-11-05 | ❌ | P0 |
| MCP 认证 | OAuth（CIMD 优先、DCR 回退）、bearer token env | 无 | ❌ | P0 |
| MCP 配置 | env、env_vars、cwd、headers、超时、enabled/disabled_tools | name/command/args/enabled | ❌ | P0 |
| MCP 工具暴露 | 每个工具一等注册，通过 tool_search 延迟加载 | 单一 `mcp_call`（High 风险），模型看不到工具列表 | ❌ | P0 |
| MCP resources/prompts/elicitation | 支持（resources 可提及，elicitation 表单） | 无 | ❌ | P1 |
| 工具注解 | readOnlyHint/destructiveHint/openWorldHint 影响审批 | 无 | ❌ | P0 |
| 插件能力块 | "Capabilities from the X plugin" 注入 | 无（仅 `<available_skills>`） | ❌ | P1 |
| 技能渐进披露 | 列表预算约 2% 上下文；按需读取 | 有 `<available_skills>` + `skill_read`，无预算 | 🟡 | P1 |
| 技能元数据 | `agents/openai.yaml`：外观、是否允许隐式调用、依赖 | 无 | ❌ | P1 |
| `allowed_tools` | —（官方未强制）| 解析但不生效 | 🟡 | P1 |
| 推荐安装 | `<recommended_plugins>` + `request_plugin_install` | 无 | ❌ | P1 |
| Hooks | 12 类事件，命令型，信任绑定哈希 | 仅内部 `executor/hooks.rs` after_success，无用户/插件 hooks | ❌ | P1 |
| 交互式 UI | MCP Apps（`ui://` 资源）+ `window.openai` 兼容层 | 无 | ❌ | P2 |
| 连接器 | Gmail/日历/Drive/GitHub/Slack 等，`app://` | 无 | ❌ | P0（产品价值最高） |

### 1.3 安全与治理

| 维度 | ChatGPT/Codex | miniQ 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| 包完整性 | 缓存按版本；Git 可钉 sha | Node 指纹只覆盖 entry 文件 | ❌ | P0 |
| 发布者签名 | 官方目录审核 | 无 | ❌ | P1 |
| 审批粒度 | 每工具 approval_mode、server 默认、Guardian 自动审阅 | 会话级 AlwaysAsk/Auto/FullAccess + ApprovedForSession | 🟡 | P0 |
| 插件工具审批 | 统一管线 | **WASM 工具永远 Low 免审批**（`host.rs:375-377`） | ❌ 安全漏洞 | P0 |
| 权限生效 | 沙箱 + 网络策略 | permissions 只是声明 | ❌ | P1 |
| Hooks 信任 | 逐条信任、改动重审 | — | ❌ | P1 |
| 托管策略 | `requirements.toml`：限源、禁插件、仅托管 hooks | 无 | ❌ | P2 |
| 凭据存储 | 系统钥匙串 | 无 | ❌ | P0（随 OAuth） |

### 1.4 体验（UX）

| 维度 | ChatGPT/Codex | miniQ 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| 插件目录 | 分类浏览、搜索、marketplace 标签页 | 已安装列表 + "从目录安装" | ❌ | P0 |
| 详情页 | 截图、能力、包含组件、隐私链接、起始提示词 | 无 | ❌ | P0 |
| 安装流程 | 一键安装 + ON_INSTALL 认证 | 选目录 | ❌ | P0 |
| 提及 | `@插件`、`@连接器`、`$技能` | 无（只有 `/` 斜杠菜单） | ❌ | P0 |
| 起始提示词 | 安装后/空会话显示 defaultPrompt | 无 | ❌ | P1 |
| 审批卡片 | 显示插件来源、工具注解、"总是允许此工具" | 通用审批卡 | 🟡 | P0 |
| 设置 | 每插件的 MCP 工具开关、认证状态、重连 | MCP 页仅增删 | ❌ | P1 |
| 移动端 | ChatGPT 移动端可用连接器 | 复用桌面页面，无专门适配 | 🟡 | P1 |
| 开发者体验 | `plugin-creator`、validator、本地 marketplace 热加载 | 有 `develop-miniq-plugin` 技能 | 🟡 | P1 |

---

## 2. 总体架构

### 2.1 目标形态

```
┌────────────── 前端（桌面 / 移动 / CLI）──────────────┐
│ 插件目录 · 详情页 · 已安装 · Marketplaces · MCP · Hooks │
│ Composer：@ 提及 / $ 技能 / / prompts / 起始提示词      │
│ 审批卡 · 安装推荐卡 · 认证卡 · MCP Apps UI 卡            │
└──────────────────────┬────────────────────────────────┘
                      │ JSON-RPC（plugin.* / marketplace.* / mcp.* / hooks.* / connector.*）
┌─────────────────────▼──────── miniq-daemon ──────────┐
│ PluginService：安装/卸载/启用/更新/回滚/信任             │
│ ContributionResolver：把已启用插件展开为 skills、MCP、   │
│   hooks、native tools、connectors、prompt 块             │
│ McpHub：连接池（stdio/HTTP）、OAuth、工具注册、资源、事件 │
│ HookRunner：事件分发、信任校验、超时                     │
│ ToolRouter：一等工具 + 延迟加载 + 审批策略                │
└───┬────────────┬─────────────┬───────────────┬─────────┘
    │            │             │               │
 miniq-plugins  miniq-mcp(新)  miniq-skills    miniq-hooks(新)
 (package/      (rmcp 封装、    (三层 + 插件层 (事件、协议、
  marketplace/   oauth、        + 预算)          信任存储)
  cache/runtime) keychain)
```

### 2.2 核心概念统一

| 概念 | 定义 | 唯一键 |
|---|---|---|
| Marketplace | 一个插件索引源（本地目录 / Git / HTTPS 索引 / 内置官方） | `marketplace name` |
| Plugin | 市场中的一个条目，安装后是一个缓存版本目录 | `name@marketplace` |
| Contribution | 插件贡献的组件：skill / mcp server / hook / native tool / connector / prompt | `name@market/kind/id` |
| Connector | 带 OAuth 模板与图标的远程 MCP server，以插件形式分发 | `connector id` |
| System plugin | 把内置能力（浏览器、电脑操作、文档、媒体）包装成可见、可禁用的插件 | `name@miniq-system` |

**原则**：用户看到的一切扩展能力都以"插件"为单位展示与管理；手动添加的 MCP server 与本地技能作为"个人"来源归入同一视图。

### 2.3 数据目录

根目录沿用 `miniq_local::data_dir()`（默认 `~/.local/share/miniq`，可用 `MINIQ_DATA_DIR` 覆盖）。

```
<data_dir>/
  plugins/
    config.toml                 # [plugins."name@market"] enabled/mcp 策略；[marketplaces.<name>]
    marketplaces/<name>/         # Git 源克隆或索引快照
    cache/<market>/<plugin>/<version>/   # 只读安装副本
    data/<market>/<plugin>/      # 插件可写数据（PLUGIN_DATA）
    state.json                  # 安装记录：版本、包哈希、来源 sha、安装时间、信任级别
  mcp/
    servers.toml                # 用户手动添加的 MCP（替代现有配置，自动迁移）
    logs/<server>.log           # stderr 滚动日志
  hooks/
    hooks.json                  # 用户 hooks
    trust.json                  # hook 哈希信任记录
```

项目级：`<workspace>/.miniq/plugins.toml`、`<workspace>/.miniq/hooks.json`、`<workspace>/.agents/plugins/marketplace.json`（仅在**受信任工作区**生效）。

凭据：OAuth token、API key 一律存系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service，`keyring` crate），配置文件只存引用。无钥匙串的服务器（Linux 无桌面）回退为 `0600` 加密文件并提示。

---

## 3. 工作流 A：插件包格式与 Marketplace

### 3.1 包格式

**主格式**：采用 Agent Plugins 1.0（与 OpenAI 当前推荐一致）。

```
my-plugin/
├── plugin.json                 # 必需
├── skills/<skill>/SKILL.md     # 自动发现
├── mcp.json                    # MCP servers
├── hooks/hooks.json            # hooks
├── assets/                     # icon、logo、截图
├── .app.json                   # 连接器引用（miniQ 解释为 connector id）
└── extensions/miniq/           # miniQ 独有：WASM/Node 原生工具
```

`plugin.json` 中 miniQ 专有设置放在 `extensions."dev.miniq"`：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "github-helper",
  "version": "1.2.0",
  "description": "...",
  "author": {"name": "..."},
  "extensions": {
    "com.openai": { "interface": { "displayName": "GitHub 助手", "defaultPrompt": ["..."] } },
    "dev.miniq": {
      "interface": { "displayName": "GitHub 助手" },
      "nativeTools": [{ "runtime": "wasm", "entry": "./extensions/miniq/tool.wasm", "permissions": ["http_client"] }],
      "minMiniqVersion": "0.2.0"
    }
  }
}
```

**读取规则（兼容层）**：

1. 优先根 `plugin.json`。
2. 否则 `.codex-plugin/plugin.json`（旧 Codex 格式，含 `skills`/`mcpServers`/`apps`/`hooks`/`interface`）。
3. 否则 `.claude-plugin/plugin.json`（Claude Code 格式：commands、agents、skills、hooks、mcpServers）。Claude 的 `commands/*.md` 转换为 miniQ 斜杠命令；`agents/*.md` 转换为子代理预设（P2）。
4. 否则旧版 `manifest.toml`（miniQ v1），内部转换为统一模型，**保持完全兼容**，不强制迁移。
5. `interface` 取值顺序：`extensions."dev.miniq".interface` → `extensions."com.openai".interface` → 顶层字段推导。
6. 路径必须以 `./` 开头，规范化后不得越出插件根（防目录穿越、符号链接逃逸）。

**统一内部模型**（`miniq-plugins::package::PluginPackage`）：

```
PluginPackage {
  id: PluginId { name, marketplace },
  version, description, author, homepage, repository, license, keywords,
  interface: Interface { display_name, short/long_description, developer, category,
                         capabilities, website/privacy/terms urls, default_prompts,
                         brand_color, icon, logo, screenshots },
  skills: Vec<SkillRef>, mcp_servers: Vec<McpServerSpec>, hooks: Vec<HookSpec>,
  connectors: Vec<ConnectorRef>, native_tools: Vec<NativeToolSpec>,
  slash_commands: Vec<CommandSpec>,     // 来自 Claude commands 或 MCP prompts
  source_format: AgentPlugins | CodexLegacy | Claude | MiniqV1,
  content_hash: Sha256,                  // 整包树哈希
}
```

每个格式一个 `Loader`，统一产出上述模型；`validate` 输出结构化诊断（错误/警告，带文件与字段路径）。

### 3.2 Marketplace

**格式**：直接采用 `marketplace.json`（与官方一致），位置：

| 类型 | 路径/配置 |
|---|---|
| 官方 | 内置 `miniq-official`，HTTPS 索引（七牛 CDN + GitHub 镜像），带签名 |
| 系统 | 内置 `miniq-system`，打包在安装包内，承载 system plugins |
| 个人 | `~/.agents/plugins/marketplace.json`（与 Codex 共用路径，天然兼容） |
| 仓库 | `<workspace>/.agents/plugins/marketplace.json`、`.claude-plugin/marketplace.json` |
| 用户添加 | `config.toml` 中 `[marketplaces.<name>] source = "git"|"local"|"https"` |

**Source 类型**：`local`、`url`（Git 仓库根）、`git-subdir`、`npm`（P2，需要本机 npm）、`https-archive`（miniQ 扩展，tar.gz + sha256，用于官方源，避免依赖 git）。

**条目策略**：`policy.installation`（AVAILABLE / INSTALLED_BY_DEFAULT / NOT_AVAILABLE）、`policy.authentication`（ON_INSTALL / ON_USE）、`category`，与官方同义。

**Git 实现**：用 `gix`（纯 Rust）做浅克隆 + sparse checkout；不依赖系统 git。支持 `ref` 与 40 位 `sha` 钉版本。

**官方索引**：`index.json` + `index.json.sig`（ed25519，公钥编译进二进制），每个条目带 `https-archive` URL 与 sha256。发布流程接入现有七牛上传流水线（参考 release workflow），需考虑七牛 504 重试。

### 3.3 安装、更新、回滚

**安装流程（事务化）**：

1. 解析来源 → 下载/克隆到临时目录。
2. 格式识别 + 校验（路径、schema、大小上限：默认 200MB、文件数上限）。
3. 计算整包树哈希；官方源校验签名与 sha256。
4. 展示**安装确认**：包含的技能、MCP server（命令行/URL）、hooks、原生工具、权限、需要认证的连接器、信任级别。
5. 原子 rename 到 `cache/<market>/<plugin>/<version>/`，写 `state.json`。
6. 贡献注册（见 3.4）；ON_INSTALL 认证的连接器立即弹出 OAuth。
7. 任一步失败整体回滚；不留残留目录。

**更新**：后台每 24 小时（可配置）刷新 marketplace；发现新版本在插件页显示"可更新"，官方源插件可选"自动更新"。更新 = 安装新版本目录 → 切换 current 指针 → 保留上一个版本用于回滚（保留 1 个）。新版本新增权限、hooks、MCP 命令变化时**必须重新确认**。

**禁用 ≠ 卸载**：禁用只移除贡献；卸载删除缓存与贡献，询问是否删除 `data/` 与 OAuth 凭据。

### 3.4 贡献解析（ContributionResolver）

daemon 在启动、插件变更、工作区切换时重算"有效贡献集"：

```
有效集 = 系统插件 ∪ 用户启用插件 ∪ （受信任工作区）项目启用插件 ∪ 个人 MCP/技能/hooks
        − 被禁用项 − 策略禁止项
```

- **技能**：直接从缓存目录加载，命名空间 `plugin-name:skill-name`，**不再复制到用户目录**（修复残留问题）；旧版复制过的技能在迁移时清理（依据 `state.json` 记录）。
- **MCP**：交给 McpHub 以 `plugin-name/server` 为 key 连接。
- **Hooks**：交给 HookRunner，未信任的保持挂起。
- **原生工具**：WASM/Node 保持现有运行时，工具名加前缀 `plugin__tool`。
- **斜杠命令**：进入 Composer `/` 菜单，分组显示插件名。
- **Prompt 块**：生成 `Capabilities from the X plugin` 段（§5.1）。

变更通过事件 `plugin.contributionsChanged` 推送前端与正在进行的会话（下一回合生效）。

### 3.5 CLI

```
miniq plugin list [--json]
miniq plugin add <name>[@market] | <path> | <git-url> [--ref ..]
miniq plugin remove <name@market> [--purge-data]
miniq plugin enable|disable <name@market> [--project]
miniq plugin update [<name@market>|--all]
miniq plugin info <name@market>
miniq plugin validate <path>        # 开发者用，输出诊断
miniq plugin init <name> [--with skills,mcp,hooks,wasm,node]
miniq plugin marketplace add <owner/repo[@ref]> | <url> [--sparse p] | <path>
miniq plugin marketplace list | upgrade [name] | remove <name>
miniq mcp add <name> -- <cmd> [args] | --url <url> [--header K=V] [--env K=V]
miniq mcp list | remove | login <name> | logout <name> | tools <name>
miniq hooks list | trust <id> | untrust <id>
miniq import --from codex|claude|cursor [--dry-run]
```

CLI 走 daemon RPC；daemon 未运行时 CLI 直接调用库（只读命令）或自动拉起 daemon。这一点对"只装 CLI 的服务器 + 手机远程"场景很重要。

---

## 4. 工作流 B：MCP 2.0

### 4.1 技术选型

新建 `crates/miniq-mcp`，基于官方 Rust SDK **`rmcp`**（client 特性：stdio + streamable-http + auth）。现有 `daemon/src/mcp.rs`（208 行手写 stdio 客户端）整体替换。协议版本协商到 2025-06-18（支持则 2025-11-25）。

### 4.2 配置模型

```toml
[servers.linear]
url = "https://mcp.linear.app/mcp"          # 或 command/args
headers = { "X-Team" = "abc" }
bearer_token_env = "LINEAR_TOKEN"            # 或 oauth = "auto"
env = { FOO = "bar" }; env_vars = ["PATH"]   # stdio：默认只透传白名单
cwd = "..."; startup_timeout_sec = 20; tool_timeout_sec = 120
enabled = true
enabled_tools = []; disabled_tools = ["delete_issue"]
default_tools_approval_mode = "auto"         # auto | ask | never_ask | deny
[servers.linear.tools.create_issue]
approval_mode = "ask"
```

与 Codex `[mcp_servers.<id>]` 字段保持同名，便于导入。修复现状"子进程继承 daemon 全部环境变量"——默认只透传 PATH/HOME/LANG 等白名单。

### 4.3 连接生命周期（McpHub）

- 懒连接：会话首次需要该 server 的工具时连接；已启用 server 在 daemon 启动后后台预热 `tools/list` 结果并缓存（带 TTL 与 `list_changed` 通知刷新）。
- 状态机：`disabled → connecting → ready | needs_auth | error(reason)`；指数退避重连；状态通过事件推送 UI。
- stderr 写入滚动日志，UI 可查看最近 200 行。
- 取消：回合中止时发送 `notifications/cancelled`。
- 进度：`notifications/progress` 转为执行活动流中的进度条。

### 4.4 工具一等注册与延迟加载

- 每个 MCP 工具注册为 `mcp__<server>__<tool>`（与 Claude/Codex 命名习惯一致，长度超限时哈希截断），出现在 ToolRouter 中，带真实 JSON Schema 与描述。
- **延迟加载**：MCP 与插件工具默认不进入首轮 tools 列表（控制上下文）；系统提示中给出"已连接 server 与工具名摘要"，模型用现有 `tool_search`（扩展 `server:` 过滤与名称前缀匹配）取回 schema 后调用。工具总数少于阈值（如 ≤ 20）时直接内联。
- 保留 `mcp_call` 一个版本作为兼容，之后移除。
- 结构化输出：`structuredContent` 优先；`resource_link` 转为可点击附件；图片内容进入视觉工作记忆。

### 4.5 审批映射

| 来源 | 默认风险 |
|---|---|
| `readOnlyHint=true` 且非 `openWorldHint` | Low |
| 无注解 | Medium |
| `destructiveHint=true` 或 `openWorldHint=true` 写操作 | High（**始终询问**，FullAccess 模式下也提示一次/会话） |

优先级：策略 deny > 工具级 `approval_mode` > server 默认 > 注解推导 > 会话审批模式。审批卡新增"总是允许此工具"（写回 `tools.<tool>.approval_mode = "never_ask"`）与"本会话允许此 server"。

### 4.6 OAuth

- 发现：401 + `WWW-Authenticate` → Protected Resource Metadata → Authorization Server Metadata。
- 客户端注册：CIMD（miniQ 托管一个 client metadata URL）优先，DCR 回退，最后允许用户手填 client_id/secret。
- 授权码 + PKCE；回调监听 `127.0.0.1` 随机端口（固定路径 `/oauth/callback`）；token 刷新自动进行；token 存钥匙串。
- **远程场景**（手机连接服务器上的 daemon）：浏览器跑在手机上，回调无法到达服务器 localhost。方案：OAuth 回调改走 miniQ 中继页面（`https://oauth.miniq.app/cb`，只转发 code 到 daemon 的已认证通道，不落盘），或让用户复制回调 URL 粘贴回 App。P1 做粘贴方案，P2 做中继。

### 4.7 Resources / Prompts / Elicitation

- Resources：`@` 菜单可搜索 MCP resources（`resources/list` + templates），选中后作为附件注入；新增 `mcp_read_resource` 工具。
- Prompts：映射为 `/server:prompt` 斜杠命令，参数弹表单。
- Elicitation（form 模式）：复用现有 `QuestionCard` 组件渲染 JSON Schema 表单；URL 模式打开浏览器。
- Sampling：不支持（安全与成本考虑），声明 capability 为空。

### 4.8 导入

`miniq import`/设置页"从其他客户端导入"：读取

- `~/.codex/config.toml` 的 `[mcp_servers.*]` 与已安装插件（`~/.codex/plugins/cache`）
- `~/.claude.json` / 项目 `.mcp.json`、`~/.claude/plugins`
- `~/.cursor/mcp.json`、Claude Desktop `claude_desktop_config.json`

展示差异清单，用户勾选导入；密钥类 env 值提示存入钥匙串。

---

## 5. 工作流 C：模型上下文、技能与 Hooks

### 5.1 插件能力块

每回合系统提示新增（按预算裁剪）：

```
<plugins>
## Capabilities from the GitHub plugin (github@miniq-official)
- Skills: $github:review-pr, $github:triage
- Tools (load via tool_search "server:github"): list_issues, create_pr, ...
- Connected account: octocat
</plugins>
```

预算：技能列表 + 插件块合计不超过上下文窗口 2%（窗口未知时 8,000 字符），超出时按"最近使用 / 被 @ 提及 / 项目级优先"排序保留，其余只列名称。

### 5.2 推荐与请求安装

- 维护 `<recommended_plugins>`：官方市场中未安装、与当前请求相关的插件（基于类别、关键词，本地计算，不外发用户内容），每回合至多 3 个。
- 新工具 `request_plugin_install(name, reason)`：前端弹出安装卡片（图标、描述、需要的权限），用户确认后安装并在同一回合继续。用户拒绝后同一会话不再推荐该插件。

### 5.3 技能增强

- 兼容 `SKILL.md` 官方字段（`name`、`description` 必填）与 `agents/openai.yaml`（`interface`、`policy.allow_implicit_invocation`、`dependencies.tools`）；miniQ 同时读取 `agents/miniq.yaml`。
- `$skill` 提及：Composer 输入 `$` 弹出技能选择；显式提及的技能在该回合直接注入全文。
- `allow_implicit_invocation=false` 的技能不进入 `<available_skills>`，只能被显式提及。
- `dependencies.tools` 引用 MCP 工具时，技能详情页显示"需要连接 X"。
- `allowed_tools` **真正生效**：技能被激活的回合内，工具调用若不在名单中则需要审批（不是硬拒绝，避免误伤），审批卡注明原因。
- 作用域增加 system（随安装包）、admin（`/etc/miniq/skills`，P2）、plugin（只读，随插件生命周期）。

### 5.4 Hooks（新子系统 `miniq-hooks`）

- **事件**（首批 8 个，与 Codex 同名）：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`Stop`、`SessionEnd`。后续补 `SubagentStart/Stop`、`Interrupt`、`PostCompact`。
- **协议**：命令型 handler；stdin 输入 JSON（session_id、cwd、event、tool_name、tool_input 等，与 Codex/Claude 字段同名）；stdout 输出 JSON（`decision`、`permissionDecisionReason`、`additionalContext`）；退出码 2 表示阻断。环境变量 `PLUGIN_ROOT`、`PLUGIN_DATA` 以及兼容的 `CLAUDE_PLUGIN_ROOT/DATA`。
- **配置层**：用户 `hooks.json`、受信任工作区 `.miniq/hooks.json`、插件、托管（P2）；全部叠加。
- **信任**：非托管 hooks 首次出现时进入"待信任"，在 UI（设置 → Hooks）与 CLI 中逐条审查（显示命令、来源、事件）；信任绑定内容哈希，改动后回到待信任。未信任的 hook 不执行，并在会话中给出一次非阻断提示。
- **执行**：同事件并发、单个 hook 默认超时 30s、`additionalContext` 限长；在远程移动端场景 hooks 运行在 daemon 所在机器。
- 现有 `executor/hooks.rs` 的内部 after_success 逻辑保持不变，与用户 hooks 分离。

---

## 6. 工作流 D：连接器与系统插件

### 6.1 连接器

miniQ 没有 ChatGPT 那样的托管连接器后端，采用 **"连接器 = 官方插件（远程 MCP + OAuth 模板 + 图标 + 技能）"**：

| 首批连接器 | 实现方式 | 备注 |
|---|---|---|
| GitHub | 官方远程 MCP（`api.githubcopilot.com/mcp`）+ OAuth / PAT | 最成熟 |
| Notion | 官方远程 MCP + OAuth | |
| Linear | 官方远程 MCP + OAuth | |
| Atlassian（Jira/Confluence） | 官方远程 MCP + OAuth | |
| 飞书 / Lark | 官方 MCP（lark-openapi-mcp，stdio）+ 应用凭证 | 国内用户价值高 |
| Google（Gmail/日历/Drive） | 需 miniQ 自有 OAuth client 与 Google 审核；先做 stdio 社区 server + 用户自带凭据，官方版排后 | 合规成本高，P2 |
| Slack | 官方 MCP 可用性待核实 | P2 |

具体可用端点在实施前需逐个核实（本文未验证各厂商当前 URL）。

连接器在 UI 上单独成一个分组"连接器"，显示账户与连接状态；`@连接器` 可在对话中直接指定。`.app.json` 中引用的 OpenAI `connector_…`/`asdk_app_…` ID 在 miniQ 无法解析，安装时给出警告并跳过，若 marketplace 中存在同名 miniQ 连接器则提示替代。

### 6.2 系统插件（内置能力插件化）

不重写代码，只做**包装与呈现**：把现有内置工具按能力分组为 `miniq-system` 市场中的插件：浏览器、电脑操作、原生 App 自动化、文档（Word/PDF/表格/PPT 工作流技能 + 工具）、媒体生成、网页搜索、子代理与任务、定时任务、记忆。

- 每个系统插件有 `interface`（图标、描述、起始提示词），出现在插件目录"系统"分类。
- 可禁用：禁用后相应工具从 ToolRouter 移除、相关技能隐藏（例如用户不想让模型碰电脑操作）。
- 对应技能（document-workflow、pdf-workflow 等）归属到对应系统插件。

### 6.3 首批官方插件（非连接器）

在 `miniq-official` 市场首发：`plugin-creator`（对话式生成插件脚手架）、`deep-research`（技能 + 子代理编排）、`latex`（现有技能迁入）、`visualize`（现有可视化技能迁入）、`git-pro`（补齐 git 写操作技能与审批）、`sites`（静态站点生成与预览）。

---

## 7. 工作流 E：体验（UX）

### 7.1 信息架构

侧栏"插件"入口升级为一级页面，含标签：

- **发现**：按分类（效率、开发、数据、写作、设计、系统）+ 搜索 + 精选；每张卡片显示图标、名称、一句话、开发者、"已安装/安装"按钮。
- **已安装**：插件列表（启用开关、更新徽标、错误状态）；分组：插件 / 连接器 / MCP server / 技能。
- **Marketplaces**：添加/刷新/移除源。
- **Hooks**：待信任、已信任、已禁用。

现有独立的 MCP、技能页面合并为"已安装"内的分组，老入口保留跳转一个版本。

### 7.2 插件详情页

头图与品牌色、截图轮播、长描述、开发者与链接（官网/隐私/条款）、**包含内容**（技能、工具、MCP server、hooks、连接器，每项可展开）、所需权限与风险说明、认证状态（连接/断开账户）、版本与更新日志、"试一试"起始提示词（点击即新建会话并填入）。

### 7.3 Composer

- `@`：提及插件、连接器、MCP resource、文件（已有文件提及则并入同一菜单分组）；被提及插件在本回合强制注入能力块并优先使用其工具。
- `$`：技能。
- `/`：现有命令 + 插件斜杠命令 + MCP prompts，分组显示。
- 空会话：展示最近安装插件的起始提示词。

### 7.4 对话内卡片

- **安装推荐卡**（`request_plugin_install`）。
- **认证卡**：ON_USE 连接器首次使用时，内联"连接 GitHub 账户"按钮，完成后自动继续该工具调用。
- **审批卡增强**：显示插件图标、来源市场、工具注解徽标（只读/破坏性/联网）、参数预览；按钮"允许一次 / 本会话允许 / 总是允许此工具 / 拒绝"。
- **Elicitation 卡**：复用 QuestionCard。
- **MCP Apps UI 卡**（P2）：`ui://` 资源在沙箱 iframe（`sandbox="allow-scripts"`，独立 origin，CSP 限制）中渲染，实现 MCP Apps 标准的 postMessage 桥（工具调用需经审批）；`window.openai` 兼容层只实现常用子集（`callTool`、`setWidgetState`、`sendFollowUpMessage`）。

### 7.5 移动端

- 插件页响应式适配：发现与详情单列，已安装列表支持开关。
- OAuth：手机上完成授权时走 §4.6 的粘贴/中继方案。
- 本地路径安装、hooks 信任等"需在主机上确认"的操作，在移动端显示只读 + "在桌面端完成"提示；hooks 信任允许在移动端完成但需二次确认。

### 7.6 开发者体验

- `miniq plugin init/validate`，`plugin-creator` 技能。
- 本地开发市场：`miniq plugin marketplace add ./dir --watch`，文件变更自动重载（开发模式标记）。
- 插件诊断面板：加载日志、MCP stderr、hooks 执行记录（前端启用现有未用的 `plugin.getDiagnostics`）。
- 文档：重写 `docs/node-plugins.md`、`docs/wasm-plugins.md`、`docs/skill-pack-format.md`，新增 `docs/plugins/*`（格式、市场、MCP、hooks、发布）。

---

## 8. 工作流 F：安全与治理

| 项 | 方案 | 里程碑 |
|---|---|---|
| WASM 免审批 | 风险默认 Medium，按工具声明的 `readOnly` 降为 Low；走统一审批管线 | M0 |
| Node 指纹 | 改为整包树哈希（含 `node_modules`），任一文件变化需重新信任 | M0 |
| 插件技能残留 | 技能从缓存加载 + 迁移清理 | M1 |
| 整包完整性 | 安装时记录树哈希，启动时抽检（mtime 变化则重算），不匹配则禁用并提示 | M1 |
| 来源信任分级 | 官方（签名）/ 系统 / 工作区 / 第三方 Git / 本地开发；UI 用徽标区分，第三方首次安装显示风险提示 | M1 |
| 官方签名 | ed25519 签名索引；CI 中签名，私钥放 GitHub secret | M4 |
| MCP env 泄露 | 白名单透传 | M2 |
| 凭据 | 钥匙串存储；日志脱敏（Authorization、token 字段） | M2 |
| 权限生效 | Node：`--permission` 细化到 `--allow-fs-read=<plugin_root>,<workspace>`，按 `workspace_write` 决定写权限；网络：Node 22 权限模型不管网络，文档说明并在 UI 上标注"可联网"；WASM：按 `http_client` 等权限链接对应 host 接口（WIT v1.1 新增 `http.fetch` 受控接口，经 daemon 代理与审批） | M3 |
| Hooks 信任 | 哈希绑定 + 审查 UI | M3 |
| 托管策略 | `/etc/miniq/requirements.toml`（或 MDM 下发）：`allowed_marketplaces`、`disabled_plugins`、`allow_managed_hooks_only`、`mcp_allowlist` | M5 |
| 审计 | 插件安装/更新/授权/hook 执行写入审计日志 | M2 起 |

---

## 9. 里程碑与工作拆分

假设 3–4 名工程师：后端 A（Rust：插件/市场）、后端 B（Rust：MCP/OAuth）、前端 C（React：插件页、Composer、卡片）、全栈 D（CLI、hooks、官方插件内容、CI）。

### M0 修正与地基（1.5 周）

- WASM 审批修复、Node 整包指纹、Node `tools.unregister`/`log` 处理、文档与代码 4 处不一致修正。
- 补测试：WASM 工具成功执行端到端、插件 RPC 安装/卸载/启用集成测试、前端插件/MCP/技能面板基础测试。
- **验收**：WASM 工具调用出现审批卡；修改 Node 插件任一依赖文件后需要重新信任；CI 通过新增测试。

### M1 包格式 + Marketplace + 新插件页（4 周）

- A：`package` 多格式 loader + validate、`marketplace`（local/git/https-archive）、缓存、事务化安装、更新/回滚、ContributionResolver、技能从缓存加载与迁移。
- C：插件页新 IA（发现/已安装/Marketplaces）、详情页、安装确认对话框、更新徽标。
- D：CLI `plugin *`、`plugin marketplace *`、`plugin init/validate`。
- **验收**：能安装 Codex 本机的 `latex`、`visualize` 等纯技能插件目录（`.codex-plugin` 格式）并在对话中使用其技能；能添加一个 GitHub 上的 marketplace 并安装/更新/回滚；旧 `manifest.toml` 插件无需修改照常工作。

### M2 MCP 2.0 + 连接器基础（4 周，与 M1 后半并行）

- B：`miniq-mcp`（rmcp）、HTTP、OAuth + 钥匙串、一等工具注册 + tool_search 扩展、注解审批、按工具策略、resources/prompts/elicitation、日志与状态、导入器。
- C：MCP 分组 UI（状态、日志、工具开关、登录）、审批卡增强、认证卡、elicitation 卡。
- **验收**：用 URL 添加 Linear/Notion 远程 MCP 并完成 OAuth；模型通过 tool_search 找到并调用具体工具；破坏性工具始终询问；"总是允许"生效并可在设置中撤销；从 `~/.codex/config.toml` 一键导入 MCP。

### M3 对话体验 + 技能 + Hooks（3 周）

- A/D：插件能力块与预算、`<recommended_plugins>` + `request_plugin_install`、技能 `openai.yaml` 兼容与 `allowed_tools` 生效、`miniq-hooks` 子系统与信任、Node 权限细化、WIT v1.1 `http.fetch`。
- C：`@`/`$`/`/` 统一提及菜单、起始提示词、安装推荐卡、Hooks 设置页。
- **验收**：输入 `@GitHub` 后模型优先用 GitHub 工具；模型在需要时弹出安装推荐卡并在安装后继续；插件自带的 PreToolUse hook 未信任时不执行、信任后可阻断指定命令、修改脚本后需重新信任。

### M4 官方市场 + 首批插件 + 系统插件（3 周）

- D：官方索引签名与发布流水线（七牛 + GitHub 镜像）、首批连接器（GitHub、Notion、Linear、Atlassian、飞书）与官方插件（plugin-creator、deep-research、latex、visualize、git-pro、sites）。
- A/C：系统插件包装与可禁用、自动更新、信任徽标。
- **验收**：新装 miniQ 在"发现"中看到官方插件并一键安装；禁用"电脑操作"系统插件后模型无法调用 computer_use；篡改官方索引签名后客户端拒绝加载。

### M5 MCP Apps UI + 移动端 + 企业托管（3–4 周）

- C：MCP Apps 沙箱渲染与桥接、移动端插件页适配。
- B：OAuth 中继、托管策略 `requirements.toml`。
- **验收**：一个示例 MCP App 的交互卡片在桌面端与移动端都能渲染并调用工具（走审批）；手机远程连接服务器 daemon 时能完成连接器 OAuth；托管策略禁止的市场无法添加。

总计约 16–18 周（M1 与 M2 部分并行）。

---

## 10. 测试策略

- **契约测试**：每种包格式的正例/反例 fixtures（放 `crates/miniq-plugins/tests/fixtures/`），包括从本机 Codex 捆绑插件复制的真实样本（注意许可，只用于测试则放脱敏最小样本）。
- **MCP**：用 rmcp 起内存 server 与本地 HTTP server 做集成测试；OAuth 用本地 mock 授权服务器覆盖 CIMD/DCR/刷新/失效。
- **安全**：路径穿越、符号链接逃逸、超大包、签名篡改、hook 哈希变化、env 白名单。
- **端到端**：daemon RPC 集成测试覆盖安装→启用→对话调用→更新→回滚→卸载全链路。
- **前端**：插件页、详情页、提及菜单、各类卡片的组件测试；移动端布局测试（沿用 `*Mobile.test.tsx` 风格）。
- **回归**：旧 `manifest.toml` 插件与现有 MCP 配置自动迁移后行为不变。

---

## 11. 风险与未决问题

1. **格式跟随成本**：Agent Plugins 1.0 仍在演进（2026 年多次变更），需要指定专人每月跟踪 OpenAI/Claude 变更，loader 做宽松解析 + 警告而非拒绝。
2. **连接器合规**：Google 等需要应用审核与隐私政策；首批只做厂商提供官方远程 MCP 的连接器。
3. **OAuth 在远程/移动场景**：中继服务涉及服务端运维与安全审计。
4. **上下文膨胀**：大量 MCP 工具会挤占上下文，依赖延迟加载与预算策略，需要实测不同模型（包括不支持 tool_search 习惯的模型）的表现。
5. **Node 插件网络无法限制**：Node 权限模型不管网络；若需强隔离，后续考虑 OS 级沙箱（macOS seatbelt / Linux landlock），不在本期。
6. **MCP Apps UI 与 `window.openai` 兼容范围**：只做子集，文档明确列出。
7. **是否兼容加载 Codex 已安装插件**：技术上可直接读取 `~/.codex/plugins/cache`，但涉及对方产品目录，默认只做"导入复制"，不做"直接挂载"。
