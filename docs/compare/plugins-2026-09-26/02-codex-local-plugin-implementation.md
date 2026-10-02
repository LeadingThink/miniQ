# Codex（ChatGPT.app 内）本地插件实现逆向调研

> 调研日期：2026-09-26。对象是本机 `/Applications/ChatGPT.app`，其内嵌 Codex 桌面端（`package.json` 版本 `26.901.51231`）、`~/.codex/`、`~/.cache/codex-runtimes/`。
> 方法：只读。读取了 manifest 和配置文件，对 `app.asar` 解包后 grep UI 文案，对 `codex` 二进制跑 `strings`，CLI 只运行 `--help`。**没有**启动或操作 ChatGPT 应用，**没有**读取 `auth.json` 等凭据文件。
> 标注约定：
> - **【证实】**：有文件证据，附路径或片段。
> - **【推测】**：由证据推断，但没有直接看到实现。
> - 路径缩写：
>   - `$APP` = `/Applications/ChatGPT.app/Contents/Resources`
>   - `$BUN` = `$APP/plugins/openai-bundled`
>   - `$RT` = `~/.cache/codex-runtimes/codex-primary-runtime`
>   - `$ASAR` = `/tmp/codex-asar`（解包产物）
>   - `$STR` = `/tmp/codex-strings.txt`（对 Codex 二进制跑 `strings` 的结果，共 74025 行）

---

## 0. 结论速览

| # | 问题 | 一句话结论 | 可信度 |
|---|---|---|---|
| 1 | 包格式 | 插件是一个目录，核心为 `.codex-plugin/plugin.json`。可选配套文件：`skills/`、`.mcp.json`、`.app.json`、`assets/`、`bin/`、`scripts/`。市场是 `.agents/plugins/marketplace.json` | 证实 |
| 2 | 可贡献内容 | 5 类：Skills、MCP servers、Apps（connector 引用）、Hooks、UI 元数据（interface）。进入模型上下文的方式是 "Capabilities from the `X` plugin" 段落，外加技能列表 | 证实 |
| 3 | 市场/分发 | 市场来源有 local 和 git 两种（GitHub `owner/repo`、HTTPS/SSH Git URL，支持 `--ref`、`--sparse`）。安装时复制到 `~/.codex/plugins/cache/<mkt>/<plugin>/<version>/`。另有内置市场、个人市场、Workspace/云端共享 | 证实 |
| 4 | 运行时 | MCP 支持 stdio 和 Streamable HTTP，OAuth 支持 AUTO/CIMD/DCR。审批有三层：工具级 `approval_mode`、服务器级 `default_tools_approval_mode`、会话/持久审批。Hook 可以在沙箱外运行，因此需要用户 Trust | 证实 |
| 5 | UX | 有插件目录页、详情页、Composer 插件选择器、`@` 提及（`plugin://name@mkt`）、`$skill`、defaultPrompt 启动提示；模型可调用 `request_plugin_install` 推荐安装插件 | 证实 |
| 6 | 13 个捆绑插件 | 9 个带 skills，5 个带 MCP，1 个带 desktop MCP，1 个带 App，2 个在 manifest 内联 hooks。browser 和 chrome 通过全局 `node_repl` MCP 工作 | 证实 |
| 7 | Connectors 与插件 | App 就是远端 connector（`connector_…` id），模型看到的是 `codex_apps` 一类 MCP 下的一组工具。插件通过 `.app.json` 引用 App，把 App 打包进插件并触发授权 | 证实（关系）/推测（内部 MCP 名） |

---

## 1. 包格式与 manifest schema

### 1.1 目录布局【证实】

以捆绑插件 `sites` 为例（`ls -A $BUN/plugins/sites`）：

```
.app.json  .codex-plugin/plugin.json  OWNERS  TEMPEST.md  TEMPEST_REVIEW  assets/  scripts/  skills/
```

13 个捆绑插件的顶层文件：

| 插件 | 顶层条目（`ls -A`） |
|---|---|
| browser | `.codex-plugin assets docs node_modules scripts skills` |
| chrome | `.codex-plugin assets docs extension-host node_modules scripts skills` |
| codex-app-tools | `.codex-plugin desktop-mcp.json scripts server.mjs` |
| computer-history | `.codex-plugin .mcp.json assets bin skills` |
| computer-use | `.codex-plugin .mcp.json assets bin skills`（`.codex-plugin/` 内另有 `computer-use-node-repl.md`） |
| deep-research | `.codex-plugin assets skills` |
| latex | `.codex-plugin DEPENDENCIES.md README.md THIRD_PARTY_NOTICES.md assets bin scripts skills tests` |
| messages | `.codex-plugin .mcp.json assets bin` |
| record-and-replay | `.codex-plugin .mcp.json assets bin skills` |
| sites | `.app.json .codex-plugin OWNERS TEMPEST.md TEMPEST_REVIEW assets scripts skills` |
| unified-computer-use | `.codex-plugin .mcp.json resources scripts` |
| user-writing | `.codex-plugin assets skills` |
| visualize | `.codex-plugin assets skills` |

纠错：之前的摘要认为存在独立的 `hooks.json` 文件，但实际**没有任何插件带 `hooks.json`**。hooks 是内联在 `plugin.json` 里的（见 1.4）。

### 1.2 `plugin.json` 字段（官方校验器口径）【证实】

来源有两处：
- `~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`
- `references/plugin-json-spec.md`（218 行）

spec 自述："The validator mirrors the workspace plugin ingestion schema"。

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | 是 | 标识符规则（见 `identifier_validation.py`），须与目录名、市场条目名一致 |
| `version` | 是 | 严格 semver。本地开发用 `<base>+codex.<cachebuster>` 做缓存击穿 |
| `description` | 是 | 自由文本。捆绑插件把"别名 + 使用时机"写在这里（见 browser） |
| `author` | 实际要求 `author.name` | 仅允许 `{name, email, url(https)}` |
| `homepage` `repository` `license` `keywords` | 否 | — |
| `skills` | 否 | 路径，约定为 `./skills/` |
| `mcpServers` | 否 | 指向 `.mcp.json`，**或者直接内联服务器对象** |
| `apps` | 否 | 指向 `.app.json`，仅在该文件真实存在时出现 |
| `interface` | 是（在校验器口径下） | 见 1.3 |
| `id` | 否 | — |

校验器拒绝所有其他字段。spec 原文："Validation rejects unsupported manifest fields such as `hooks`"。

### 1.3 `interface`（展示元数据）【证实】

| 字段 | 必填 | 约束 |
|---|---|---|
| displayName / shortDescription / longDescription / developerName / category | 是 | 字符串 |
| capabilities | 是 | 字符串数组。实际取值为 `Interactive`、`Read`、`Write` |
| defaultPrompt（或 `default_prompt`） | 至少一个 | 实际为字符串数组，最多 3 条，UI 中作为 starter prompts |
| websiteURL / privacyPolicyURL / termsOfServiceURL | 否 | 必须是 https |
| brandColor | 否 | `#RRGGBB` |
| composerIcon / logo / logoDark / screenshots | 否 | 必须是插件内的真实文件 |

runtime 插件实例（`$RT/.../spreadsheets/.codex-plugin/plugin.json` 经 jq 抽取）：

```json
"interface":{"displayName":"Spreadsheets","category":"Productivity",
 "capabilities":["Interactive","Write"],
 "defaultPrompt":["Create a spreadsheet to analyze this company's financials", …]}
```

### 1.4 捆绑插件与校验器的偏差（重要）【证实】

OpenAI 自家的捆绑插件并不完全符合公开校验器：

| 偏差 | 证据 |
|---|---|
| `hooks` 内联在 plugin.json | browser、chrome：`"hooks":{"hooks":{"Stop":[{"hooks":[{"type":"mcp_tool","server":"node_repl","tool":"turn_ended","input":{…"${session_id}"…}}]}]}}` |
| `publicationPolicy` | user-writing：`"publicationPolicy":"INTERNAL_ONLY"` |
| 无 `interface`、无 `author` | codex-app-tools、unified-computer-use（纯运行时插件，不在目录中展示） |
| 无 `capabilities` | computer-history、computer-use、record-and-replay |

**推测**：实际的摄取器比 `validate_plugin.py` 更宽松，至少接受 `hooks`。UI 文案 "Hooks can run outside of the sandbox…" 和 hooks 设置页中的 "From Plugins" 来源分类也支持这一点（见 §4.6）。`validate_plugin.py` 代表的是"对外发布（workspace 摄取）"的严格口径。

### 1.5 配套文件 schema【证实】

| 文件 | 顶层 | 条目格式 | 实例 |
|---|---|---|---|
| `.mcp.json` | `mcpServers` | 名称 → 服务器对象（与 config.toml 的 `[mcp_servers.X]` 键相同） | computer-use：`{"command":"./bin/computer-use-client-launcher","args":["mcp"],"cwd":".","env_vars":["CODEX_HOME"]}` |
| `desktop-mcp.json` | `mcpServers` | 同上。仅由桌面端主进程读取，不走通用插件加载 | codex-app-tools 的 `codex_app` |
| `.app.json` | `apps` | 名称 → `{id, category?}` | sites：`{"sites":{"id":"connector_20205bf7d4e99a89d7154bb849718324"}}`；spreadsheets：`{"connected_documents":{"id":"connector_openai_codex_document_control"}}` |
| `skills/<n>/SKILL.md` | YAML frontmatter `name`、`description` | Markdown 正文 | 见 §2.2 |
| `skills/<n>/agents/openai.yaml` | `interface`、`policy`、`dependencies` | interface：display_name、short_description、icon_small、icon_large、brand_color、default_prompt；policy：`allow_implicit_invocation`；dependencies：`tools` | deep-research：`allow_implicit_invocation: true` |

`desktop-mcp.json` 由主进程专门读取的证据在 `$ASAR/.vite/build/main-BT6ViFC-.js`：

```js
y.default.readFile(p.default.join(a.path,`desktop-mcp.json`),`utf8`)
… let{mcpServers:{codex_app:c}}=QO.parse(JSON.parse(s)),l={...c.env,[pf]:r}
```

其中 `pf` 即管道路径环境变量，注入为 `CODEX_APP_TOOLS_PIPE_PATH`。缺失时返回 `missing-pipe`、`missing-plugin`、`missing-definition`。

### 1.6 市场文件 `marketplace.json`【证实】

来源：`$BUN/.agents/plugins/marketplace.json`，以及 spec 中的 "Marketplace field guide"。

| 字段 | 说明 |
|---|---|
| `name` | 市场 id，例如 `openai-bundled`、`openai-primary-runtime`、个人市场默认 `personal` |
| `interface.displayName` | 例如 `"OpenAI Bundled"` |
| `plugins[]` | 有序数组，**顺序即 UI 渲染顺序** |
| `plugins[].source` | `{source:"local", path:"./plugins/<n>"}`，路径相对市场根目录 |
| `plugins[].policy.installation` | `NOT_AVAILABLE` / `AVAILABLE` / `INSTALLED_BY_DEFAULT` |
| `plugins[].policy.authentication` | `ON_INSTALL` / `ON_USE`（何时触发 App/OAuth 授权） |
| `plugins[].policy.products` | 可选，按产品门控（spec："omit it unless product gating is explicitly requested"） |
| `plugins[].category` | 分类，例如 Productivity、Engineering、Research、Developer Tools、Education & Research |

市场所在位置：
- 个人市场：`~/.agents/plugins/marketplace.json`，隐式发现，不需要 `marketplace add`。
- 仓库/团队市场：`<repo>/.agents/plugins/marketplace.json`。

依据为 `references/installing-and-updating.md` 第 28–29、65–68 行。本机不存在 `~/.agents/plugins`。

两套内置市场的策略对比：

| 市场 | 插件数 | installation | authentication |
|---|---|---|---|
| openai-bundled | 13 | 全部 `AVAILABLE` | 全部 `ON_INSTALL` |
| openai-primary-runtime | 5 | 全部 `AVAILABLE` | 全部 `ON_USE` |

---

## 2. 插件能贡献什么，如何加载与暴露给模型

### 2.1 贡献类型总表【证实】

| 类型 | 声明方式 | 加载后形态 | 暴露给模型的方式 |
|---|---|---|---|
| Skills | `skills: "./skills/"` | 技能条目（name + description + SKILL.md 路径） | 系统提示中的 `## Skills` 列表，渐进式披露；以插件名为前缀 |
| MCP servers | `mcpServers` → `.mcp.json` | 与用户 `[mcp_servers]` 同级的 MCP 客户端 | MCP 工具（直接给出或经 `tool_search` 延迟加载） |
| Apps | `apps` → `.app.json` | 引用远端 connector id | "Apps from this plugin available in this session" |
| Hooks | plugin.json 内联 `hooks` | 生命周期回调 | 不直接暴露。在 Stop 等事件时由宿主执行 |
| interface | plugin.json | 目录卡片、详情页、starter prompts | 不进入模型上下文（**推测**） |
| desktop MCP | `desktop-mcp.json` | 仅桌面端特供的 MCP | 工具由宿主经管道动态提供 |

### 2.2 注入模型上下文的文本【证实】

`$STR` 第 5865 行附近有插件能力段落模板（字符串为碎片化片段）：

```
Capabilities from the `<plugin>` plugin:
- Skills from this plugin are prefixed with `<plugin>:`      ← 前缀格式为推测，原文此处被截断
- Apps from this plugin available in this session: …
- MCP servers from this plugin available in this session: …
```

源码路径同时出现 `core/src/plugins/metrics.rs`、`core/src/session/turn_input.rs`、`core/src/session/mcp_prewarm.rs`。**推测**：插件能力段落在每轮 turn input 构建时注入，MCP 服务器会预热。

技能注入提示在 `$STR` 第 34071 行附近（"How to use skills"），要点如下：
- **发现**：`## Skills` 段列出 name、description、SKILL.md 位置。位置可以是绝对路径、`### Skill roots` 下的短别名（如 `r0`），也可以是非文件系统引用（`skill://`）。
- **触发**：用户点名（`$SkillName` 或纯文本）或任务明显匹配时使用。点名多个就全部使用。不跨轮延续，除非再次提到。
- **使用**：先完整读 SKILL.md（分页就读到 EOF），再按需读取引用的文件。这就是渐进式披露。
- **缺失**：简短说明并回退。

`agents/openai.yaml` 的 `policy.allow_implicit_invocation` 控制技能能否被隐式触发，即不点名也能按描述匹配（依据为校验器字段；运行时语义属**推测**）。

### 2.3 App 的注入文本【证实】

`$STR` 第 6239 行：

```
## Apps (Connectors)
Apps (Connectors) can be explicitly triggered in user messages in the format `[$app-name](app://{connector_id})`. …
An app is equivalent to a set of MCP tools within the `<…>` MCP.
An installed app's MCP tools are either provided to you already, or can be lazy-loaded through the `tool_search` tool.
Do not additionally call list_mcp_resources or list_mcp_resource_templates for apps.
```

### 2.4 未安装插件的推荐与模型发起安装【证实】

- `$STR` 第 27775 行有 `<recommended_plugins></recommended_plugins>`，说明文字为 "Here is a list of plugins that are available but not installed."，配置键为 `plugins.recommendations`。
- 工具 `request_plugin_install`（`core/src/tools/handlers/request_plugin_install.rs`）的参数有 `tool_type`（`connector`|`plugin`）、`action_type`（仅 `install`）、`plugin_id`、`suggest_reason`。
- 使用条件：用户明确要某插件，且 `tool_search` 已穷尽，且该插件位于 `<recommended_plugins>` 中。"DO NOT call this tool in parallel with other tools."
- 用户可以 accept、decline、cancel，并可"持久化禁用该建议"（"failed to persist disabled tool suggestion"）。
- 安装后会刷新 apps 工具缓存（"failed to refresh codex apps tools cache after plugin install request"）。
- TUI 暂不支持："plugin install requests are not available in codex-tui yet"。

### 2.5 加载链路（安装 → 生效）

| 步骤 | 证据 | 可信度 |
|---|---|---|
| 市场注册到 config：`[marketplaces.<n>] source_type/source` | `~/.codex/config.toml` | 证实 |
| 捆绑市场先复制到 `~/.codex/.tmp/bundled-marketplaces/openai-bundled`，再作为 local 市场注册 | config 中 `source="/Users/…/.codex/.tmp/bundled-marketplaces/openai-bundled"` | 证实（复制动机为推测） |
| 安装时复制到 `~/.codex/plugins/cache/<mkt>/<plugin>/<version>/` | 实际目录，例如 `cache/openai-bundled/visualize/1.0.29` | 证实 |
| 启用状态写入 `[plugins."<name>@<mkt>"] enabled=true` | config.toml | 证实 |
| 部分插件有 `latest` 符号链接 | 仅 `chrome/latest -> 26.715.61943` | 证实 |
| 同步和对账：`plugin/reconcile`、`plugin/installed` | `$STR` 中的 RPC 名 | 证实（名称）/行为推测 |
| 技能变化需要刷新："Refresh to use new skill(s)" | plugins-page 文案 | 证实 |
| 开关全部插件需要重启："Restart {appName} to apply this change" | plugins-settings-row | 证实 |

本机缓存（`ls ~/.codex/plugins/cache/*/*`）：

| 市场 | 插件 → 版本 |
|---|---|
| openai-bundled | browser 26.901.51231；chrome 26.715.61943 + latest；codex-app-tools 0.1.3；computer-use 1.0.1000926；unified-computer-use 26.901.51231；visualize 1.0.29 |
| openai-primary-runtime | documents、pdf、presentations、spreadsheets、template-creator，均为 26.923.10815 |

注意：chrome 已缓存但**没有**出现在 config 的 `[plugins]` 中，属于曾安装或预热残留（**推测**）。另外，市场里的 deep-research、latex、sites 等在本机未安装。

---

## 3. 市场与分发

### 3.1 CLI（`codex plugin --help` 等）【证实】

| 命令 | 作用 |
|---|---|
| `codex plugin add <PLUGIN[@MARKETPLACE]>` | 安装；`--marketplace`、`--json` |
| `codex plugin list` | 列出；`--available`、`--json` |
| `codex plugin remove` | 卸载并删除本地缓存 |
| `codex plugin marketplace add <SOURCE>` | SOURCE 可为本地路径、`owner/repo[@ref]`、HTTPS Git URL、SSH Git URL；`--ref`、`--sparse` |
| `codex plugin marketplace upgrade [NAME]` | 刷新 Git 市场快照 |

`$STR` 第 22801 行："Pass either `PLUGIN@MARKETPLACE` or pass `PLUGIN` with `--marketplace MARKETPLACE`"。

### 3.2 市场来源类型与记录字段【证实】

`MarketplaceSourceType` 取 `git` 或 `local`。持久化字段有：`source_type`、`sparse_paths`、`last_updated`、`last_revision`、`commit_hash`、`repository_url`。

UI 文案（plugins-page）：
- "Add from a GitHub repo, Git URL, or local folder."
- 占位符 `openai/plugins or git@github.com:org/repo.git`，字段 "Git ref"（默认 `main`）、"Sparse paths"（示例 `plugins/codex`）。
- "Only Git marketplaces can be upgraded"、"Upgrade all marketplaces"。
- "Built-in marketplaces cannot be removed"、"Built-in marketplaces update automatically"。
- "Only configured marketplaces can be removed"。

### 3.3 插件来源分类（详情页文案）【证实】

`plugin-detail-page-*.js`：

| 文案 | 含义 |
|---|---|
| "Local plugin" / "From your personal marketplace on this machine" | 个人市场 |
| "Folder marketplace plugin" / "From a folder marketplace" | 本地目录市场 |
| "Git marketplace plugin" / "From the {marketplaceName} Git marketplace" | Git 市场 |
| "Workspace plugin" / "From your {workspaceName} workspace" | 工作区（企业）目录 |
| "Your cloud plugin" / "Created by you in the cloud" | 云端自建 |
| "Remote host plugin" / "From your remote host" | 远程主机（remote app server） |
| "Installed by admin" / "Disabled by admin" / "Access is turned off by your admin" | 管理员托管 |

### 3.4 分享（plugin/share/*）【证实】

- RPC：`plugin/share/{save, checkout, delete, list, updateTargets}`。
- 分享范围的 UI 文案："Anyone in {workspaceName} with the link"、"Only those invited"、"Can view"、"Can edit"。
- 限制：
  - "Only plugins you created can be shared"
  - "Plugins from imported marketplaces can't be shared"
  - "Sharing can only be edited when you have a local copy"
  - "Shared version is out of date"
- "Visible in {workspaceName} directory"：可以发布到工作区目录。

### 3.5 版本与缓存击穿【证实】

`installing-and-updating.md`：本地迭代时把版本改为 `<base-version>+codex.<cachebuster>`（`update_plugin_cachebuster.py`，默认取 UTC 时间戳），再执行 `codex plugin add <name>@<mkt>` 重新安装。cachebuster 应替换而非追加。

**推测**：缓存按 `version` 分目录，版本不变时不会重新复制。

### 3.6 runtime 市场（按需下载的重型运行时）【证实】

`$RT/runtime.json`：
- `bundleFormatVersion 2`、`bundleVersion "26.923.10815"`、`artifactToolVersion "2.8.76"`
- `bundledPlugins ["plugins/openai-primary-runtime"]`
- `skillsToRemove [codex-primary-runtime/spreadsheets, codex-primary-runtime/slides, doc, docs, spreadsheet, slides]`：迁移时清理旧的同名技能
- nativeDependencies：libheif、jxrlib、libreoffice-headless、poppler、git
- node v24.19.0、python 3.12.14、LibreOffice 25.2-headless

也就是说，Office 类插件与一个独立下载的"运行时包"绑定发布，版本号与桌面端版本不同（26.923 对比 26.901）。

---

## 4. 运行时：MCP、OAuth、审批、沙箱、超时

### 4.1 MCP 服务器配置键【证实】

来源为 `$STR` 与 config。插件 `.mcp.json` 和 `[mcp_servers.X]` 使用同一套键。

| 类别 | 键 |
|---|---|
| 启动（stdio） | `command` `args` `cwd` `env` `env_vars`（从父进程透传变量名） |
| 远程（Streamable HTTP） | `url` `bearer_token_env_var` `http_headers` `env_http_headers` `http_headers_helper` |
| 认证 | `auth`（`oauth` \| `chatgpt`）、`scopes`、`oauth_resource`，OAuth：`client_id` `callback_url` `callback_port` |
| 生命周期 | `enabled` `required` `startup_timeout_sec` `tool_timeout_sec` |
| 工具过滤 | `enabled_tools` `disabled_tools` `omit_tools_from`（如 `code_mode`、`deferred`） |
| 审批 | `default_tools_approval_mode`；`tools.<t>.approval_mode` |
| 输出 | `tools.<t>.output_token_limit`；`supports_parallel_tool_calls` |

插件实例：
- unified-computer-use `.mcp.json`：`"cua_repl":{"command":"node","args":["scripts/launch.mjs"],"enabled":false,"enabled_tools":["js","js_reset"],"omit_tools_from":["code_mode","deferred"],"startup_timeout_sec":120,"tools":{"js":{"output_token_limit":25000}}}`
- 插件内 `cwd:"."`、`./bin/...` 等相对路径是相对插件缓存根目录解析的（**推测**，依据是 launcher 均用相对路径）。

### 4.2 OAuth【证实】

- CLI：`codex mcp add NAME --url … --oauth-client-id --oauth-client-registration AUTO|CIMD|DCR --oauth-resource`；`codex mcp login NAME --scopes`。
- UI（plugins-page 中的 "Add MCP server" 表单）：
  - 类型 "STDIO" / "Streamable HTTP"。
  - 字段 "Bearer token env var"、"Headers from environment variables"、"Environment variable passthrough"。
  - "OAuth client registration: Automatic / CIMD / DCR"。
  - 其中 "Client ID metadata document (CIMD)"、"Dynamic client registration (DCR)"。
- RPC：`mcpServer/oauth/login` 发起，`mcpServer/oauthLogin/completed` 为完成通知。
- App（connector）的授权走 ChatGPT 账号侧：
  - 有 `app-connect-oauth-callback-page-*.js`。
  - 详情页文案 "Connect another account"、"Reconnect {accountName}"、"Authentication update required"、"Disconnects all accounts"。**一个 App 可以连接多个账户并起昵称**（"Add a nickname"）。
- 插件安装返回 `appsNeedingAuth`（RPC 字段名），配合 policy `authentication: ON_INSTALL | ON_USE` 决定在安装时还是首次使用时要求连接（字段为证实，时机语义为**推测**）。

### 4.3 审批【证实】

| 层级 | 机制 | 证据 |
|---|---|---|
| 工具级 | `approval_mode`：`auto` / `prompt` / `writes` / `approve`（`AppToolApproval` 枚举） | `$STR`；codex-app-tools 的 desktop-mcp.json |
| 服务器默认 | `default_tools_approval_mode` | codex-app-tools：`"default_tools_approval_mode":"approve"` |
| App 风险开关 | `destructive_enabled` `open_world_enabled` `default_tools_enabled` | `$STR` |
| 审批类别 | `codex_approval_kind`：`mcp_tool_call`、`codex_sensitive_action`；附带 `tool_title`、`connector`、`browser_use`、`computer_use` | `$STR` |
| 记忆范围 | `persist` / `always` / `session` | `$STR` |
| 自动审查 | `approvals_reviewer`、`codex_strict_auto_review`（Guardian）。失败时："Automated review of this operation failed. Do not proceed without asking the user for explicit approval." | `$STR` |
| 浏览器站点权限 | 默认策略加按站点例外：打开网站、上传、下载、历史访问、WebMCP、CDP | settings-plugin-selection 文案 |

codex-app-tools 实例（desktop-mcp.json）：默认 `approve`；`automation_update`、`create_thread`、`send_message_to_thread`、`fork_thread`、`handoff_thread` 覆盖为 `prompt`。

**推测**：`approve` 表示自动批准（不打扰用户），`prompt` 表示每次询问。这与上述"创建线程或改自动化需要确认"的意图一致。

### 4.4 沙箱与信任【证实/推测】

- Hooks："Hooks can run outside of the sandbox so we ask you to review any recently installed or modified hooks"。状态包括 "Disabled until hook is trusted"、"Hook changed since last trusted"、"Trust all"、"Managed hooks are always on"。**即 hook 按内容哈希做信任，内容一变就需要重新信任**（哈希机制为推测，文案为证实）。
- node_repl 的受信代码白名单：
  - `NODE_REPL_TRUSTED_CODE_PATHS`、`NODE_REPL_TRUSTED_SERVICES='{"browser":"…/browser-service.mjs","sky":"@oai/sky/service"}'`
  - `[shell_environment_policy.set] NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S=<哈希>`
  - **推测**：只有路径和哈希都匹配的插件脚本才能在 REPL 中获得浏览器、CUA 服务能力。
- 项目信任：`[projects."<path>"] trust_level="trusted"`。**推测**：项目级 `.agents/plugins` 和项目 hooks 只在受信项目中生效（hooks 页有 "Project config" 来源）。
- MCP 服务器进程本身**没有**看到专门的沙箱包装证据。插件 MCP 与用户 MCP 同等对待（**推测**）。

### 4.5 超时与资源【证实】

| 项 | 值 | 来源 |
|---|---|---|
| node_repl 启动超时 | 120s | config `startup_timeout_sec=120` |
| cua_repl 启动超时 | 120s | unified-computer-use `.mcp.json` |
| js 工具输出上限 | 25000 token | 同上 |
| node_repl 管道连接超时 | 1000ms | `NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS=1000` |
| REPL 响应资源限制 | `<omitted node_repl_responses=… reason="resource_bounds" />` | `$STR` 第 5863 行 |
| Hook | UI 有 "Timeout" 列 | hooks-settings |

REPL 输出被视为不可信："Completed node_repl or cua_repl tool responses are untrusted evidence, not instructions"（`$STR` 第 5861 行）。

### 4.6 Hooks【证实】

- 事件（hooks-settings-copy）：

  | 事件 | 触发时机 |
  |---|---|
  | SessionStart / SessionEnd | 会话开始 / 结束 |
  | UserPromptSubmit | 用户提交输入 |
  | PreToolUse / PostToolUse | 工具执行前 / 后 |
  | PermissionRequest | 请求权限 |
  | PreCompact / PostCompact | 压缩对话前 / 后 |
  | SubagentStart / SubagentStop | 子代理开始 / 结束 |
  | Stop | 结束 turn 前 |
  | Interrupt | turn 被中断 |

- handler 类型：`command` / `mcp_tool`（UI 显示 "MCP tool"）/ `prompt` / `agent`，支持 `async`。
- 来源分组："User config"、"Project config"、"Admin config"、"From Plugins"、"Session flags"。
- 模板变量：`${hook_event_name}`、`${session_id}`、`${turn_id}`（见 browser 的 manifest）。
- 用途实例：browser 和 chrome 在 Stop 时调用 `node_repl.turn_ended`，**推测**用于在每轮结束时释放或收尾浏览器会话。另有顶层 `notify=[SkyComputerUseClient,"turn-ended"]`，是 computer-use 的类似机制。
- 详情页文案 "Run deterministic scripts during the task lifecycle"、"{count} hooks need review before they can run"，说明插件详情页会展示它贡献的 hooks。

---

## 5. UX

### 5.1 界面结构（webview chunk）【证实】

| 界面 | chunk | 关键文案 |
|---|---|---|
| 插件目录页 | plugins-page | "Plugin directory"、"Skill directory"、"Browse plugins or skills"、分类筛选、标签 Plugins/Skills/Apps/MCPs、"Imported plugins"、"Created by you"、"Shared with you" |
| 插件详情页 | plugin-detail-page | "Capabilities"、"Category"、"Developer"、"Version"、"Tools for this app"、"The {appName} app contains {totalActions} actions ({actionTypes})"、"Try in chat"、"More ways to try this plugin"、"Copy Markdown"（SKILL.md） |
| Composer 插件选择器 | plugin-picker-menu-content | "Search plugins…"、"Connect plugins"、"Browse all plugins"、"No connected plugins" |
| 首页插件控件 | composer-work-home-plugins-control | "Work with ChatGPT across your favorite tools"、"Installing {pluginName}" |
| 设置 → 插件 | plugins-settings(-row) | "Manage plugins, skills, and MCPs"、"Allow ChatGPT to use installed plugins"（全局开关） |
| 设置 → 浏览器插件 | settings-plugin-selection | 站点权限矩阵，"Enable/Disable/Install {pluginName}" |
| 设置 → Hooks | hooks-settings | 见 §4.6 |
| 设置 → MCP | mcp-settings | "Connect external tools and data sources" |
| 请求插件 | plugins-page | "Request a plugin"、"Tell us which plugin you'd like…"，有限流："You've submitted several requests. Try again in a minute" |
| 创建 | plugins-page | "Create plugin"、"Create skill"、"Record a skill"（对应 record-and-replay）、"Describe your plugin" |

### 5.2 提及与调用语法【证实】

| 语法 | 对象 | 证据 |
|---|---|---|
| `[@Name](plugin://<plugin>@<marketplace>)` | 插件 | codex-home-announcements：`[@Codex Replay](plugin://codex-replay@openai-curated-remote)` |
| `plugin://browser?browserId=…&tabId=…&title=…&url=…` | 浏览器标签页提及（带参数） | app-initial：`let r=\`plugin://${t.pluginId}?${n}\`` 并有大小上限 |
| `[$app-name](app://{connector_id})` | App/connector | `$STR` 第 6239 行 |
| `$skill-name` | 技能 | 技能提示与 default_prompt，例如 "Use $deep-research…" |
| `skill://` | 非文件系统技能引用 | `$STR` 第 37359 行 `app://plugin://skill://` |
| 结构化输入 `type: mention` / `skill` | 子代理与 API 输入项 | `$STR` 第 28034 行："structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name>" |

另外，插件 `description` 中会写别名，供模型识别。browser 的写法是 "Aliases: @browser, @browser-use, browser-use, Browser, in-app browser."。

还有一个观察：app-primary 中存在从插件名到"artifact 类型"的映射，`kUe=new Map([["documents","document"],["presentations","presentation"],["spreadsheets","spreadsheet"],["sites","site"],…])`。**推测**：UI 用它把插件提及渲染成对应的产物卡片或模板。

### 5.3 Starter prompts【证实】

`interface.defaultPrompt` 为 1–3 条字符串，技能层还有 `agents/openai.yaml` 的 `default_prompt`。UI 入口为 "Try now"、"Try in chat"。例子：
- chrome 有 3 条。
- user-writing 有 1 条。
- deep-research 的技能级 default_prompt 为 "Use $deep-research. Run this at xhigh, create a dedicated subagent…"，即直接带有推理强度和子代理的执行指令。

### 5.4 状态与错误处理（UI 文案）【证实】

| 类别 | 文案 |
|---|---|
| 加载 | "Loading plugins…"、"Loading marketplaces…"、"Loading tools…"、"Preparing your plugin"、"Finalizing details"、"Almost there!" |
| 安装 | "Install plugin"、"Installing"、"Installed"、"Uninstalling"、"Finish setup"、"Connect app"、"Authenticate" |
| 失败 | "Failed to load plugins"、"Failed to add marketplace"、"{marketplaceName} marketplace is configured, but failed to refresh the plugin list"、"Some marketplaces could not be loaded"、"This plugin could not be loaded from its marketplace entry."、"This plugin is not available in your current plugin marketplaces"、"Plugin not found" |
| 可用性 | "Plugins are not available for this host"、"Unavailable in this context"、"App unavailable"、"This app is disabled" |
| 状态码（`$STR`） | `disabled_by_admin`、`plan_not_eligible`、`required_app_unavailable` |
| 刷新 | "Refresh to use new skill(s)"、"Failed to refresh skills and apps"、"Restart {appName} to apply this change" |
| 激励 | "Earn workspace credits by installing and successfully using the {pluginName} plugin" |

### 5.5 App-server RPC（UI ↔ Rust 核心）【证实】

来源为 `app-initial-*.js`、`app-primary-*.js` 和 `$STR`。

| 域 | 方法 |
|---|---|
| plugin | `plugin/list` `read` `search` `install` `uninstall` `installed` `reconcile` `skill/read` `share/*` |
| marketplace | `marketplace/add` `remove` `upgrade` |
| skills | `skills/list` `skills/changed` `skills/config/write` `skills/extraRoots/set` |
| app | `app/list` `app/list/updated` `app/read` `app/installed` |
| mcp | `mcpServerStatus/list` `mcpServer/startupStatus/updated` `mcpServer/reload` `mcpServer/oauth/login` `mcpServer/oauthLogin/completed` `mcpServer/tool/call` `mcpServer/resource/read` `mcpServer/elicitation/request` `mcpServer/event/stream/{start,stop,notification}` |
| config | `config/read` `config/value/write` `config/batchWrite` `config/mcpServer/reload` |
| hooks | `hooks/list` |

`plugin/install` 相关的字段名 `appsNeedingAuth`、`forceRemoteSync` 已确认存在，但完整的请求和响应结构**未能取得**（awk 上下文输出丢失）。

---

## 6. 13 个捆绑插件能力清单

### 6.1 总表【证实】

| 插件 | 版本 | 显示名 | 类别 | capabilities | Skills | MCP | 其他 | 本机启用 |
|---|---|---|---|---|---|---|---|---|
| browser | 26.901.51231 | Browser | Engineering | Interactive,Read,Write | control-in-app-browser | 无（用全局 node_repl + `browser-service.mjs`） | Stop hook | 是 |
| chrome | 26.901.51231 | Chrome | Productivity | Interactive,Read | control-chrome | 无（node_repl） | Stop hook；extension-host（原生消息） | 否（仅缓存） |
| codex-app-tools | 0.1.3 | — | Developer Tools（市场条目） | — | 无 | `desktop-mcp.json`：codex_app | 管道代理 | 是 |
| computer-history | 1.0.1000926 | Computer History | Productivity | — | computer-history | computer-history（Sky 客户端 `computer-history mcp`） | — | 否 |
| computer-use | 1.0.1000926 | Computer Use | Productivity | — | computer-use | computer-use（Sky 客户端 `mcp`） | computer-use-node-repl.md | 是 |
| deep-research | 0.1.1 | Deep Research | Research | Interactive,Read,Write | deep-research | 无 | — | 否 |
| latex | 0.2.6 | LaTeX | Education & Research | Interactive,Read,Write | latex-compile、latex-doctor、texlive-runtime-installer | 无 | bin/tectonic | 否 |
| messages | 1.0.1000926 | Messages | Productivity | Read,Write | 无 | messages（Sky 客户端 `messages mcp`） | — | 否 |
| record-and-replay | 1.0.1000926 | Record & Replay | Productivity | — | record-and-replay | event-stream（Sky 客户端 `event-stream mcp`） | — | 否 |
| sites | 0.1.57 | Sites | Productivity | Interactive,Write | sites-building、sites-hosting | 无 | `.app.json` → connector_20205bf7…；scripts/package-site.sh | 否 |
| unified-computer-use | 26.901.51231 | — | Engineering（市场条目） | — | 无 | cua_repl（`enabled:false`，node launch.mjs） | resources/*.md 工具描述覆盖 | 是 |
| user-writing | 0.1.2 | Write like me | Productivity | Read | writing-style | 无 | `publicationPolicy: INTERNAL_ONLY` | 否 |
| visualize | 1.0.29 | Visualize | Productivity | Interactive,Read,Write | visualize（514 行） | 无 | — | 是 |

统计：9 个带 skills（共 13 个技能），5 个带 `.mcp.json`，1 个带 `desktop-mcp.json`，1 个带 `.app.json`，2 个带内联 hooks，2 个无 interface。

### 6.2 各插件实现要点【证实，除非另注】

| 插件 | 要点 | 证据 |
|---|---|---|
| browser | 描述中写明别名，并要求 "Do not satisfy explicit @browser … with macOS `open`"。scripts 下有 browser-service.mjs、browser-client.mjs、browser-accessibility.wasm.br、扩展与原生宿主检测脚本。SKILL.md 首节要求"先选对界面"：语义操作优先查找 connector | `$BUN/plugins/browser/…` |
| chrome | 复用用户 Chrome 的登录态和扩展；"Prefer purpose-built connectors… ask the user to reauthenticate or explicitly approve Chrome as a fallback" | plugin.json |
| codex-app-tools | `server.mjs`（25176 行）是 MCP 代理：`tools/list` 和 `tools/call` 经 `CODEX_APP_TOOLS_PIPE_PATH` 管道转发给宿主，并带 `_meta` 的 `openai/threadId`、`turnId`、`toolCallId`。可见的工具名：automation_update、create_thread、send_message_to_thread、fork_thread、handoff_thread。仅本地主机（`e.kind!=="local"` 时返回空） | desktop-mcp.json、main-BT6ViFC-.js |
| computer-use / messages / record-and-replay / computer-history | 4 个插件共用 `bin/computer-use-client-launcher`，它执行 `${CODEX_HOME}/computer-use/Codex Computer Use.app/…/SkyComputerUseClient "$@"`，用第一个参数区分子服务（`mcp`、`messages mcp`、`event-stream mcp`、`computer-history mcp`）。**即一个原生 App 承载多个 MCP** | 各插件 `.mcp.json`、`bin/` |
| computer-use | 另有 node_repl 通道：`@oai/sky` API（click、drag、get_app_state、list_apps、type_text…，`target:"mac"`）。config 中独立的 `[mcp_servers.computer-use] enabled=false` | `.codex-plugin/computer-use-node-repl.md`、config |
| unified-computer-use | `launch.mjs` 以 `NODE_REPL_TOOL_OVERRIDES` 拉起 node_repl，覆盖工具描述（js、js_reset），并转发信号；报错 "CUA REPL could not start"。默认 `enabled:false`，**推测**由功能开关或宿主按需启用 | `.mcp.json`、`resources/` |
| latex | 自带 `bin/tectonic`，失败回退到 TeX Live/MacTeX；有 doctor 与安装器技能；含 tests | 目录、SKILL.md |
| sites | 通过 `.app.json` 绑定 Sites connector，用于远端托管；本地 `package-site.sh` 打包；项目标记 `.openai/hosting.json` | 目录、SKILL.md |
| deep-research | 纯技能，输出带引用的 DOCX；技能 policy 允许隐式调用 | agents/openai.yaml |
| visualize | 纯技能（514 行 SKILL.md），在对话中渲染交互式可视化 | SKILL.md |
| user-writing | 纯技能，通过"已连接的 Apps"检索用户过往写作；仅内部发布 | plugin.json |

### 6.3 runtime 市场 5 个插件（对照）【证实】

| 插件 | 技能 | 其他 |
|---|---|---|
| documents | documents | — |
| pdf | pdf | — |
| presentations | presentations | — |
| spreadsheets | spreadsheets、excel-live-control | `.app.json` → `connector_openai_codex_document_control` |
| template-creator | template-creator | — |

5 个插件的 capabilities 都是 `Interactive,Write`，都有 3 条 defaultPrompt。它们依赖 `$RT` 下的 node、python、LibreOffice 和 poppler。

---

## 7. Connectors / Apps 与插件的关系

| 维度 | 结论 | 证据 / 可信度 |
|---|---|---|
| 本质 | App 等于 ChatGPT 侧的远端 connector（id 形如 `connector_<hex>` 或 `connector_openai_…`），对模型呈现为某个 MCP 下的一组工具 | `$STR` 第 6239 行 "An app is equivalent to a set of MCP tools within the `…` MCP"（证实） |
| 插件如何引用 | `.app.json` 的 `apps.<key>.id` 指向 connector id。插件本身不包含 connector 实现 | sites、spreadsheets（证实） |
| 授权 | 由 marketplace 的 policy `authentication: ON_INSTALL / ON_USE` 决定时机；安装流程返回 `appsNeedingAuth`；UI 显示 "Connect app"、"Finish setup"、"Enable and connect this app to try it now" | 证实（字段与文案）/时机语义为推测 |
| 多账户 | 一个 App 可以连接多个账户并起昵称，支持重连和断开 | plugin-detail-page 文案（证实） |
| 工具加载 | 直接提供，或通过 `tool_search` 延迟加载；插件安装后刷新 "codex apps tools cache" | `$STR`（证实）。**推测**内部 MCP 名为 `codex_apps` |
| 提及 | App 用 `app://<connector_id>`，插件用 `plugin://<name>@<mkt>`，两者在 composer 中统一处理（`msr="app://"`、`hsr="plugin://"`） | app-initial（证实） |
| 自动建议 | app-initial 中 `vsr({apps, mcpServerStatuses, prompt})` 按 prompt 过滤可访问的 App，用于 composer 联想（"ambient suggestion"） | 证实（函数存在）/行为推测 |
| 风险开关 | App 级 `destructive_enabled`、`open_world_enabled`、`default_tools_enabled`，以及工具级 approval | `$STR`（证实） |
| 推荐安装 | `request_plugin_install` 的 `tool_type` 可以是 `connector` 或 `plugin` | 证实 |
| 目录页 | 插件目录页有独立的 "Apps" 标签，以及 "No installed apps"、"Loading apps…" | plugins-page（证实） |

一句话总结：**插件是分发与打包单位；App/Connector 是托管在服务端、带账户授权的工具集合；MCP server 是本地或自定义的工具进程；Skill 是 Markdown 形式的程序性知识**。插件可以同时打包后三者。

---

## 8. 相关本地组件与插件的关系

| 组件 | 路径 | 与插件的关系 | 可信度 |
|---|---|---|---|
| `codex` 二进制 | `$APP/codex`；`~/.codex/plugins/.plugin-appserver/codex`（220MB） | Rust 核心，也是 app-server，承载 plugin、marketplace、skills、mcp、hooks 等 RPC | 证实 |
| `codex-code-mode-host` | `$APP/`；`.plugin-appserver/`（62MB） | Mach-O arm64。与 `code_mode`、`code_mode_host` 功能开关对应；`.mcp.json` 的 `omit_tools_from:["code_mode"]` 说明插件工具可以在 code mode 中被排除 | 证实（存在与开关名）/职责推测 |
| `cua_node` | `$APP/cua_node/bin/{node,node_repl}`；`lib/node_modules/@oai`、playwright、sharp、tesseract.js 等 | node_repl MCP 的运行时，承载 browser、chrome、computer-use 的 JS API | 证实 |
| `codex_chronicle` | `$APP/codex_chronicle` | 未深入分析。**推测**与 computer-history 的本地事件流有关 | 推测 |
| Codex Computer Use.app | `~/.codex/computer-use/` | SkyComputerUseClient，被 4 个插件的 launcher 复用 | 证实 |
| `$APP/skills` | App 内置技能目录 | 与插件技能并列的另一来源（本次未展开） | 证实（存在） |
| `~/.codex/skills/.system/` | 系统技能，例如 plugin-creator | 提供创建和校验插件的规范 | 证实 |
| automations | `~/.codex/automations/<id>/automation.toml` 以及日期子目录 | 与插件无直接关系；`use-plugin-scheduled-tasks-*.js` 和 "Scheduled"、"Custom schedule" 文案说明插件详情页可以挂定时任务 | 证实（文件）/关系推测 |

`automation.toml` 格式【证实】（prompt 已截断）：

```toml
version = 1
id = "ai"
kind = "cron"            # 另一例为 "heartbeat"
name = "每日 AI 新闻公众号草稿"
prompt = "…"
status = "PAUSED"
rrule = "RRULE:FREQ=DAILY;BYHOUR=4;BYMINUTE=0"
model = "gpt-5.6-sol"
reasoning_effort = "high"
execution_environment = "local"
target = { type = "project", project_id = "local-…" }   # heartbeat 用 target_thread_id
cwds = ["/Users/…/zaiwenai"]
```

---

## 9. 对旧文档 `chatgpt-plugin-ecosystem.md` 的核实与纠错

| 旧文档说法 | 核实结果 |
|---|---|
| "13 个核心插件"，但只列了 12 个 | 实际为 13 个，旧文档**漏掉了 `computer-use`**（经 grep 逐项计数核对）。完整清单见 §6 |
| `.codex-plugin` 是"标识为原生插件" | 不准确。它是目录，核心文件是 `.codex-plugin/plugin.json` |
| `.app.json` "声明内嵌应用与前端视图" | **错误**。它只引用远端 connector id（`{id, category}`），不含前端视图 |
| 插件"通过独立子进程拉起" | 部分正确。纯技能插件（deep-research、visualize、user-writing）没有任何进程；browser 和 chrome 复用全局 node_repl，不自带 MCP |
| browser "自动 Cookie/Session 隔离，按域名防外溢" | **无证据**。实际证据是按站点的权限设置（打开、上传、下载、历史、CDP、WebMCP），以及 SKILL.md 中 "It can have existing signed-in sessions" |
| unified-computer-use "整合截图、AX 树、前后台双通道" | **无证据**。实际是 node_repl 包装（cua_repl，工具为 js、js_reset），默认 `enabled:false` |
| codex-app-tools "暴露项目工作区管理 API" | 不准确。它是经管道转发的宿主工具代理，已知工具与线程、自动化相关 |
| computer-history "记录会话截图，防止死循环" | **错误**。实际是"Ask ChatGPT about what you were doing recently"，基于本地事件流和记忆摘要回答近期活动问题 |
| record-and-replay "转化为自动化脚本" | 不准确。它把录制转化为**可复用技能**（UI 中的 "Record a skill"），MCP 名为 `event-stream` |
| latex "语法校验、公式渲染预览" | 不准确。它负责编译（Tectonic 或 TeX Live 回退）、环境诊断和安装 TeX Live |
| sites "本地轻量 Web 服务器、侧边栏预览" | **错误**。它负责构建并**部署**到 ChatGPT Sites 托管（带 connector 和服务条款） |
| messages "系统通知、邮件/消息通道" | **错误**。它负责读取、搜索、发送 macOS "信息" App 的消息和本地附件。默认只使用用户批准过的会话，发送前需要用户确认消息内容和收件人（longDescription） |
| user-writing "文风质量分析" | 不准确。它通过已连接 Apps 检索用户过往写作以模仿文风，仅内部发布 |
| runtime 插件路径 `…/openai-primary-runtime/plugins` | 基本正确。安装后的实际路径为 `~/.codex/plugins/cache/openai-primary-runtime/<p>/26.923.10815/`。spreadsheets 还有 `excel-live-control` 技能和一个 App |
| automations 存储在 `~/.codex/automations/<task_id>/` | 正确，文件为 `automation.toml`（见 §8）。"系统级守护进程拉起"没有证据 |
| memories/goals sqlite | 本次未核实（超出范围） |
| 未提及 | 旧文档缺少以下内容：市场体系、policy、CLI、hooks、审批模式、OAuth、`plugin://` 提及、`request_plugin_install`、分享与工作区分发 |


---

## 10. 对 miniQ 的启示（简要，属设计建议而非事实）

| 主题 | 可借鉴点 |
|---|---|
| 包格式 | 一个目录，一个 manifest，贡献物通过相对路径引用。用严格校验器约束外部插件，内置插件可以使用扩展字段（hooks） |
| 市场 | 用 `marketplace.json` 的有序列表加 policy（installation、authentication）。来源为 local 或 git（ref、sparse）。安装即复制到按版本分目录的缓存，config 只记录 `name@mkt enabled` |
| 暴露给模型 | 每个插件一段 "Capabilities from X" 摘要，技能渐进式披露，大量工具走 `tool_search` 延迟加载，未安装插件放进 `<recommended_plugins>` 并由专用工具发起安装 |
| 安全 | 工具级 approval_mode 与服务器默认值分层；hook 需要信任并在变更后重新审核；REPL 输出标记为不可信 |
| UX | `plugin://name@mkt` 与 `app://id` 统一提及；defaultPrompt 作为 starter；错误状态细分（市场加载失败、条目无法加载、管理员禁用、套餐不符） |

---

## 附：证据路径索引

| 证据 | 路径 |
|---|---|
| 捆绑市场 | `$BUN/.agents/plugins/marketplace.json`、`$BUN/.bundle-id`（UUID） |
| 捆绑插件 manifest | `$BUN/plugins/<n>/.codex-plugin/plugin.json` |
| MCP/App 配套文件 | `$BUN/plugins/{computer-history,computer-use,messages,record-and-replay,unified-computer-use}/.mcp.json`、`codex-app-tools/desktop-mcp.json`、`sites/.app.json` |
| runtime | `$RT/runtime.json`、`$RT/plugins/openai-primary-runtime/.agents/plugins/marketplace.json` |
| 安装缓存 | `~/.codex/plugins/cache/` |
| 配置 | `~/.codex/config.toml`（已脱敏） |
| 规范 | `~/.codex/skills/.system/plugin-creator/{SKILL.md,references/*.md,scripts/validate_plugin.py}` |
| 桌面主进程 | `$ASAR/.vite/build/main-BT6ViFC-.js` |
| UI | `$ASAR/webview/assets/{plugins-page,plugin-detail-page,plugin-picker-menu-content,plugins-settings*,settings-plugin-selection,hooks-settings*,mcp-settings,app-initial,app-primary}-*.js` |
| 核心字符串 | `$STR` 第 5861–5870 行（插件能力段），第 6239 行（Apps），第 27318–27335 行（request_plugin_install），第 27775 行（recommended_plugins），第 28034 行（mention），第 34071 行（skills） |
