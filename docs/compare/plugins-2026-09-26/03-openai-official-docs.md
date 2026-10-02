# OpenAI 官方文档调研：ChatGPT / Codex 插件（Plugins）扩展体系

> 调研日期：2026-09-26
> 资料来源：OpenAI 官方开发者文档（developers.openai.com，Markdown 版在页面 URL 后加 `.md` 获取）与用户文档（learn.chatgpt.com/docs，索引见 https://learn.chatgpt.com/llms.txt）
> 说明：
> - 每条结论都附上来源 URL。Codex 用户文档页在 developers.openai.com/codex/* 与 learn.chatgpt.com/docs/* 两处都有引用（文档内部链接两种域名混用）。下文统一写 developers.openai.com 形式，内容以抓取时（2026-09-26）为准。
> - 凡没有拿到原文或只看到标题、没读到正文的内容，都标注「未能核实」。
> - `https://developers.openai.com/codex/changelog.md` 抓取返回 Not found，因此变更时间线以 What's new 页和 Plugin UI changelog 为准。

---

## 0. 总览：概念与关系

| 概念 | 官方定义（摘要） | 来源 |
|---|---|---|
| Skill（技能） | 把「指令 + 资源」打包，是一个包含 `SKILL.md` 的目录 | https://developers.openai.com/codex/skills-and-plugins ；https://developers.openai.com/codex/skills |
| Plugin（插件） | 可安装的包，可含 skills、MCP server，以及生命周期 hooks；MCP server 还可以带自定义 ChatGPT UI | https://developers.openai.com/plugins/concepts/plugins |
| MCP server / App / Connector | 在管理员文档里，「app」和「MCP server」指同一种已连接集成，两个词可互换 | https://developers.openai.com/codex/enterprise/apps-and-connectors |
| Plugins Directory | 「ChatGPT and Codex share one universal plugin directory」，即 ChatGPT 与 Codex 共用一个公共插件目录 | https://developers.openai.com/codex/skills-and-plugins |
| Marketplace | 由 JSON 描述的插件目录，用于本地开发、测试和私有分发，和公共目录相互独立 | https://developers.openai.com/plugins/build/plugins#how-local-marketplaces-work |
| Hooks | 在 agent 生命周期的关键点运行自定义命令，2026-05 GA | https://developers.openai.com/codex/hooks ；https://developers.openai.com/codex/whats-new |
| AGENTS.md | 分层的项目/全局指令文件 | https://developers.openai.com/codex/agent-configuration/agents-md |

插件形态（Plugin architecture 页的形态表）：

| 形态 | 内容 | 典型用途 |
|---|---|---|
| Skills only | 只有 `skills/` | 可复用工作流、提示与脚本 |
| MCP server only | 远程 MCP server（UI 可选） | 连接外部服务的数据与动作 |
| Skills + MCP | 两者组合 | 带工作流编排的连接器 |
| MCP server with UI | MCP 工具 + UI 资源（iframe） | 在 ChatGPT 中渲染交互界面 |

- 来源：https://developers.openai.com/plugins/concepts/plugins
- 同页结构树为：Plugin → Skills；MCP server（可选）→ Tools / 结构化结果；UI resources（可选）。
- ChatGPT 支持开放的「MCP Apps UI standard」，并在其上提供可选的 ChatGPT 扩展。

---

## 1. 插件（Plugin）定义

### 1.1 包结构

官方当前推荐的是可移植的「Agent Plugins 1.0」格式：根目录放 `plugin.json`，`.codex-plugin/plugin.json` 退为可选的兼容 overlay。

来源：https://developers.openai.com/plugins/build/plugins#plugin-structure

```text
my-plugin/
├── plugin.json            # 可移植清单（必需，入口）
├── mcp.json               # 可选：打包的 MCP servers（固定路径）
├── skills/<name>/SKILL.md # 可选：技能（自动发现，无需在清单声明）
├── assets/                # 图标、logo、截图
├── hooks/hooks.json       # 可选：默认 hooks 发现位置
├── .app.json              # 可选：引用已注册的 MCP server（App）映射
└── .codex-plugin/plugin.json  # 可选：旧版/兼容 overlay（仅放 plugin.json）
```

要点：

- `plugin.json`、`mcp.json`、`skills/`、`assets/` 放在插件根目录。如果使用 Codex overlay，`.codex-plugin/` 里只放它的 `plugin.json`；hooks、`.app.json` 等被引用的资源仍留在根目录。（同上）
- OpenAI 也接受旧版清单和 Claude 兼容清单，但新包应使用 Agent Plugins 格式。（同上）
- `.app.json` 文件名必须带前导点，不支持 `app.json`。示例：`{"apps":{"team-tools":{"id":"asdk_app_example","required":true}}}`。来源：https://developers.openai.com/codex/enterprise/plugin-management#reference-an-existing-app-with-appjson

### 1.2 `plugin.json` 字段

根清单字段是可移植元数据：

| 字段 | 含义 |
|---|---|
| `$schema` | 声明 Agent Plugins 版本，如 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` |
| `name` | 插件标识，建议使用稳定的 kebab-case，同时作为组件命名空间 |
| `version`、`description` | 可选，发布与发现元数据 |
| `author{name,email,url}`、`homepage`、`repository`、`license`、`keywords` | 发布者与发现元数据 |

`extensions.com.openai` 字段是 OpenAI 专有设置：

| 字段 | 含义 |
|---|---|
| `apps` | 指向 `.app.json`，即已注册 MCP server 的映射 |
| `hooks` | 生命周期 hooks 配置。可以是单个路径、路径数组、内联对象或内联对象数组；显式值会**替换**默认的 `hooks/hooks.json` 发现，而不是叠加 |
| `interface.displayName` / `shortDescription` / `longDescription` | 安装界面上的标题与描述 |
| `interface.developerName` / `category` / `capabilities`（如 `["Read","Write"]`） | 发布者与能力元数据 |
| `interface.websiteURL` / `privacyPolicyURL` / `termsOfServiceURL` | 外部链接 |
| `interface.defaultPrompt`（数组）/ `brandColor` / `composerIcon` / `logo` / `screenshots` | 起始提示词与视觉呈现 |

规则：

- 如果 `extensions.com.openai` 是对象，它会**整体替换** `.codex-plugin/plugin.json` overlay，两者不合并；缺失时才由 overlay 提供 OpenAI 设置。
- 可移植包始终从 `skills/` 发现技能、从 `mcp.json` 发现 MCP。extension 或 overlay 里的 `skills`/`mcpServers` 声明不能替换、禁用或增加这些组件，只对没有可移植根清单的旧包生效。
- 路径规则：以 `./` 开头，相对于插件根，且不得越出插件根。视觉资源建议放在 `./assets/`。

本小节来源：https://developers.openai.com/plugins/build/plugins#manifest-fields 、#add-openai-specific-metadata 、#path-rules

> 注意：调研任务原本关注的 `.codex-plugin/plugin.json` 在当前文档中已降级为兼容 fallback。它的完整字段表（旧版 `skills`、`mcpServers`、`apps`、`hooks`、`interface` 等）没有找到独立的 schema 页，**未能核实**完整字段清单。

### 1.3 插件可包含的内容

| 组件 | 位置 / 声明方式 | 说明 | 来源 |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | 自动发现 | https://developers.openai.com/plugins/build/plugins |
| MCP servers | 根 `mcp.json`（`$schema: .../mcp.schema.json`，`mcpServers.<name>{type:"streamable-http",url}`）；旧版为 `.mcp.json` | 传输方式由插件决定，不走用户配置 | 同上；https://developers.openai.com/codex/extend/mcp |
| Apps（已注册的 ChatGPT App / Connector） | `.app.json`，通过 `extensions.com.openai.apps` 引用 | 引用 `asdk_app_...` ID，可设 `required` | https://developers.openai.com/codex/enterprise/plugin-management |
| Hooks | 默认 `hooks/hooks.json`，或 `extensions.com.openai.hooks` | 属于非托管 hooks，需要用户信任后才会运行 | https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks |
| UI 资源 | 由 MCP server 以 `ui://` 资源提供 | 见第 4 章 | https://developers.openai.com/plugins/build/chatgpt-ui |

Hook 命令可用的环境变量：

- `PLUGIN_ROOT`（安装后的插件根目录）和 `PLUGIN_DATA`（可写数据目录）。
- 为兼容 Claude，同时设置 `CLAUDE_PLUGIN_ROOT` 和 `CLAUDE_PLUGIN_DATA`。
- 来源同上。

### 1.4 Marketplace（`marketplace.json`）

文件位置（来源：https://developers.openai.com/plugins/build/plugins#how-local-marketplaces-work）：

| 类型 | 路径 |
|---|---|
| 仓库 marketplace | `$REPO_ROOT/.agents/plugins/marketplace.json` |
| 兼容旧格式 | `$REPO_ROOT/.claude-plugin/marketplace.json` |
| 个人 marketplace | `~/.agents/plugins/marketplace.json` |
| 管理员 | 系统 `config.toml` 或云端托管配置中的 `marketplaces.<name>` |

结构示例（节选）：

```json
{
  "name": "local-example-plugins",
  "interface": { "displayName": "Local Example Plugins" },
  "plugins": [{
    "name": "my-plugin",
    "source": { "source": "local", "path": "./plugins/my-plugin" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

字段规则：

- 顶层 `name` 标识 marketplace，`interface.displayName` 是桌面 App 中显示的标题。
- 每个插件条目都必须包含 `policy.installation`、`policy.authentication` 和 `category`。
- `policy.installation` 取值：`AVAILABLE`、`INSTALLED_BY_DEFAULT`、`NOT_AVAILABLE`。
- `policy.authentication` 取值：`ON_INSTALL`（安装时认证）或 `ON_USE`（首次使用时认证）。
- `source.path` 相对于 marketplace 根目录，以 `./` 开头，且不得越界。本地条目也可以直接写字符串路径。
- 来源：https://developers.openai.com/plugins/build/plugins#marketplace-metadata

Source 类型：

| `source` | 必填 / 可选字段 | 说明 |
|---|---|---|
| `local` | `path` | 本地目录 |
| `url` | `url`，`ref`/`sha` | 插件位于 Git 仓库根目录 |
| `git-subdir` | `url`、`path`，`ref`/`sha` | 插件位于仓库子目录 |
| `npm` | `package`（可带 scope），`version`（版本/tag/范围），`registry` | 需要本机有 npm CLI |

- 如果某个条目的 source 无法解析，Codex 只跳过该条目，不会让整个 marketplace 失败。（同上）
- 用 Admin 导入 GitHub 时，Git 源可以选择 `ref` 或 40 位完整 commit `sha`。来源：https://developers.openai.com/codex/enterprise/plugin-management#supported-formats

### 1.5 安装流程与 CLI 命令

CLI 命令（来源：https://developers.openai.com/plugins/build/plugins ；https://developers.openai.com/codex/plugins）：

| 命令 | 作用 |
|---|---|
| `codex` 后输入 `/plugins` | 打开 TUI 插件浏览器：按 marketplace 分组（marketplace 标签页），可查看详情、安装、卸载；在已安装插件上按 Space 切换启用/禁用 |
| `codex plugin marketplace add owner/repo [--ref main]` | 添加 GitHub 简写源，也支持 `owner/repo@ref` |
| `codex plugin marketplace add https://github.com/x/plugins.git --sparse .agents/plugins` | 添加 Git URL（HTTP(S)/SSH）源；`--sparse` 可重复使用，仅适用于 Git |
| `codex plugin marketplace add ./local-marketplace-root` | 添加本地目录源 |
| `codex plugin marketplace list` / `upgrade [name]` / `remove <name>` | 列出、升级（刷新）、移除 marketplace |

- 官方文档只写了 `marketplace` 子命令和 `/plugins` 浏览器，但 codex-rs 源码中还有 `add`、`list`、`remove` 子命令，详见 §10.1（源码已核实）。
- 安装位置：`~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`。本地插件的 `$VERSION` 为 `local`，运行时加载的是缓存副本，而不是 marketplace 条目原路径。来源：https://developers.openai.com/plugins/build/plugins#how-local-marketplaces-work
- 安装后，打包的 skills 在新会话中可用；MCP server 可能还需要额外设置或认证。来源：https://developers.openai.com/codex/plugins
- 以 API key 登录时，可以在 CLI 和桌面 App 的 Codex 中浏览、安装 OpenAI 精选插件。部分插件因需要不受支持的 OAuth 能力而不可用。用量显示在 platform.openai.com/usage。来源：https://developers.openai.com/codex/plugins
- 创作路径：
  - 在 ChatGPT Work 中用 `@plugin-creator`，在 Codex 中用 `$plugin-creator`，可以通过对话生成插件脚手架。
  - 可传入 `plugin_asdk_app...` 形式的 ID 来接入已有 MCP server。
  - 来源：https://developers.openai.com/plugins/build/plugins

### 1.6 启用/禁用、版本与更新

| 维度 | 机制 | 来源 |
|---|---|---|
| 用户级启用/禁用 | 插件浏览器把选择写入 `~/.codex/config.toml` 的 `[plugins."<plugin>@<marketplace>"] enabled = true/false` | https://developers.openai.com/plugins/build/plugins#how-local-marketplaces-work |
| 仓库级 | 在仓库的 `.codex/config.toml` 中写同样的键；只有**受信任项目**才会加载。项目设置覆盖用户、云托管和系统默认，但仍受 requirements 约束 | 同上 #enable-or-disable-a-plugin-for-a-repo |
| 禁用 ≠ 卸载 | `enabled=false` 时插件不卸载；marketplace 刷新时仍可能安装或刷新这些已配置插件的文件 | 同上 |
| 插件内 MCP 策略 | `[plugins."my-plugin".mcp_servers.docs]` 下可设 `enabled`、`default_tools_approval_mode`、`enabled_tools`、`disabled_tools`、`tools.<tool>.approval_mode` | 同上；https://developers.openai.com/codex/config-file/config-reference |
| 版本 | 清单中的 `version`；缓存路径按版本分目录；npm 源支持 semver 范围 | https://developers.openai.com/plugins/build/plugins |
| 更新 | CLI 用 `codex plugin marketplace upgrade`；工作区 GitHub 导入默认每日同步，也可点 **Sync now**；无效更新会保留上一个可用版本；源中删掉的条目会被标记为 **No longer in source** 而不删除 | https://developers.openai.com/codex/enterprise/plugin-management#keep-plugins-up-to-date |
| 公共目录更新 | 发布后 OpenAI 会周期性抓取 MCP 工具：被删除的工具立即下线；新增或修改的工具通过自动检查后生效；插件信息和导入的技能变更需要重新提交新版本并审核 | https://developers.openai.com/plugins/deploy/submission#how-published-mcp-metadata-versions-work |
| 卸载 | 「Uninstall plugin」。工作区安装的插件或默认插件可能没有该选项；卸载不会断开在 ChatGPT 中单独连接的 MCP 集成 | https://developers.openai.com/codex/plugins |

### 1.7 三种分发渠道

| 渠道 | 范围 | 方式 | 来源 |
|---|---|---|---|
| 本地 / 仓库 / 个人 marketplace | 开发者本机、团队仓库 | `marketplace.json` + CLI | https://developers.openai.com/plugins/build/plugins |
| 发布到工作区（Workspace） | 组织内指定角色 | chatgpt.com/plugins → Personal → 三点菜单 → Publish（需要工作区管理员）；可用 `features.plugin_sharing = false` 关闭 | 同上 #publish-a-local-plugin-to-your-workspace |
| 管理员 GitHub 导入 | 整个工作区 | Admin > Plugins > Add > Import marketplace，每日同步 | https://developers.openai.com/codex/enterprise/plugin-management |
| 公共 Plugins Directory | 所有 ChatGPT + Codex 用户 | 通过 platform.openai.com/plugins 提交审核 | https://developers.openai.com/plugins/deploy/submission |

补充：导入的插件如果在 `mcp.json`/`.mcp.json` 中声明了 MCP server（即使是远程 HTTPS），会被标为 **Desktop only**，只能在 ChatGPT 桌面 App 中使用。来源：https://developers.openai.com/codex/enterprise/plugin-management#desktop-only-plugins

---

## 2. Skills（技能）

### 2.1 `SKILL.md` 与目录结构

- 技能是一个目录。`SKILL.md` 的 frontmatter 必须有 `name` 和 `description`。
- 可选内容：`scripts/`（脚本）、`references/`（参考资料）、`assets/`（资源），以及 `agents/openai.yaml`（外观、调用策略、依赖）。
- 来源：https://developers.openai.com/codex/skills

```md
---
name: skill-name
description: Explain exactly when this skill should and should not trigger.
---
Skill instructions for ChatGPT or Codex to follow.
```

- 规范基于开放的 Agent Skills 标准。来源：https://agentskills.io/specification（Codex 文档中有链接；规范原文本次**未能核实**）
- 官方示例仓库：https://github.com/openai/skills（`skills/.curated/` 下有 gh-fix-ci、pdf、linear 等）

### 2.2 渐进披露（Progressive disclosure）

- 初始只把技能列表（名称 + 描述）注入上下文，上限为上下文窗口的 **2%**；窗口未知时上限为 **8,000 字符**。
- 超出上限时先缩短描述；仍放不下则省略部分技能并给出警告。
- 技能被选中后，才读取完整的 `SKILL.md`，并按需读取 scripts/references。
- 配置键 `skills.max_context_tokens` 可以调整该上限。
- 来源：https://developers.openai.com/codex/skills ；https://developers.openai.com/codex/config-file/config-reference

### 2.3 作用域（Scopes）

| Scope | 位置 | 用途 |
|---|---|---|
| `REPO` | `$CWD/.agents/skills` | 当前目录的专用技能 |
| `REPO` | `$CWD/../.agents/skills` | Git 仓库内上级目录 |
| `REPO` | `$REPO_ROOT/.agents/skills` | 仓库根目录，全仓共享 |
| `USER` | `$HOME/.agents/skills` | 个人跨项目技能 |
| `ADMIN` | `/etc/codex/skills` | 机器或容器级共享（SDK 脚本、自动化） |
| `SYSTEM` | 随 Codex 内置 | OpenAI 提供的通用技能（如 skill-creator、skill-installer） |

- 支持符号链接的技能目录（扫描时跟随 symlink）。
- 修改会被自动检测，没有生效时重启即可。
- 来源：https://developers.openai.com/codex/skills#where-to-save-skills

插件内的技能属于第五类来源，随插件安装和启用生效。来源：https://developers.openai.com/codex/skills#distribute-skills-with-plugins

### 2.4 调用方式

| 方式 | ChatGPT | Codex（CLI/IDE/桌面） |
|---|---|---|
| 显式 | `@skill` 提及 | `$skill` 提及、`/skills` 命令；桌面 App 中已启用技能出现在 `@` 菜单（2026-03） |
| 隐式 | 模型按 `description` 匹配后自动调用 | 同左；可用 `policy.allow_implicit_invocation: false` 关闭 |

- 来源：https://developers.openai.com/codex/skills ；https://developers.openai.com/codex/skills-and-plugins ；https://developers.openai.com/codex/whats-new（2026-03-16–20）
- 审批：`approval_policy.granular.skill_approval` 可以控制技能相关的审批提示。来源：https://developers.openai.com/codex/config-file/config-reference 。具体触发条件（例如技能脚本执行前是否询问）**未能核实**。

### 2.5 `agents/openai.yaml`

```yaml
interface:
  display_name: "Optional user-facing name"
  short_description: "Optional user-facing description"
  icon_small: "./assets/small-logo.svg"
  icon_large: "./assets/large-logo.png"
  brand_color: "#3B82F6"
  default_prompt: "Optional surrounding prompt to use the skill with"
policy:
  allow_implicit_invocation: false   # 默认 true
dependencies:
  tools:
    - type: "mcp"
      value: "openaiDeveloperDocs"
      description: "OpenAI Docs MCP server"
      transport: "streamable_http"
      url: "https://developers.openai.com/mcp"
```

- 来源：https://developers.openai.com/codex/skills#optional-metadata
- `dependencies.tools` 声明技能依赖的 MCP 工具。
- 配置标志 `features.skill_mcp_dependency_install` 暗示可以自动安装这些依赖（来源：config-reference），其具体行为**未能核实**。

### 2.6 创建、安装与开关

| 操作 | 方式 | 来源 |
|---|---|---|
| 创建 | ChatGPT Work 用 `@skill-creator`，Codex 用 `$skill-creator`；默认生成纯指令型技能 | https://developers.openai.com/codex/skills |
| 录制生成 | Record & Replay：在 macOS 上演示流程后生成技能（2026-06，需要 Computer Use，EEA/英国/瑞士首发不可用） | https://developers.openai.com/codex/whats-new |
| 安装精选技能 | `$skill-installer linear`；也可以从其他仓库下载 | https://developers.openai.com/codex/skills#install-curated-skills-for-local-use |
| 禁用 | `~/.codex/config.toml` 中配置 `[[skills.config]] path=".../SKILL.md" enabled=false`，然后重启 | 同上 |
| 从 MCP 导入技能 | 插件提交门户支持上传技能或从 MCP 导入技能 | https://developers.openai.com/plugins/build/skills ；https://developers.openai.com/plugins/deploy/submission |
| 企业管控 | Skill controls 页面（技能分发与管理、归属控制） | https://developers.openai.com/codex/enterprise/skills（细节**未能核实**） |

最佳实践：一个技能只做一件事；除非需要确定性行为，否则优先写指令而不是脚本；步骤用祈使句写清输入和输出；用测试提示词校验触发效果。来源：https://developers.openai.com/codex/skills#best-practices

---

## 3. MCP

### 3.1 CLI 命令

| 命令 | 说明 | 来源 |
|---|---|---|
| `codex mcp add <name> --env K=V -- <stdio command>` | 添加 stdio server，例如 `codex mcp add context7 -- npx -y @upstash/context7-mcp` | https://developers.openai.com/codex/extend/mcp |
| `codex mcp add <name> --url https://... [--oauth-client-id id]` | 添加 HTTP server，可预配 OAuth client，命令会显示回调 URL | 同上 |
| `codex mcp list` / `codex mcp --help` | 列出已配置的 server / 查看帮助 | 同上 |
| `codex mcp login <name> [--oauth-client-registration cimd\|dcr]` | 发起 OAuth 登录。默认 auto，所选注册方式不写入配置 | 同上 |
| TUI 中的 `/mcp` | 查看 server 状态；OAuth server 上会显示 **Authenticate** | 同上 |

### 3.2 `[mcp_servers.<id>]` 配置字段

| 类别 | 字段 |
|---|---|
| stdio | `command`、`args`、`env`（表）、`env_vars`、`cwd` |
| HTTP | `url`、`bearer_token_env_var`、`http_headers`、`env_http_headers`、`http_headers_helper`、`auth`（可选 `oauth` 等） |
| OAuth | `oauth.client_id`、`oauth.callback_url`、`oauth.callback_port`、`scopes`、`oauth_resource` |
| 生命周期 | `enabled`、`required`、`startup_timeout_sec` / `startup_timeout_ms`、`tool_timeout_sec`、`experimental_environment` |
| 工具过滤与审批 | `enabled_tools`、`disabled_tools`（在 enabled 之后应用）、`default_tools_approval_mode`（如 `"prompt"`）、`tools.<tool>.approval_mode`（如 `"approve"`）、`tools.<tool>.output_token_limit` |
| 全局 | `mcp_oauth_credentials_store`、`mcp_oauth_callback_port`、`mcp_oauth_callback_url`、`mcp_optional_startup_grace_ms` |
| requirements 身份匹配 | `mcp_servers.<id>.identity.command.*` 与 `identity.url.{match,value,expression}`，用于约束允许的 MCP server |

- 来源：https://developers.openai.com/codex/extend/mcp ；https://developers.openai.com/codex/config-file/config-reference
- `approval_mode` 的完整枚举（除 `prompt` 和 `approve` 外是否还有 `auto`/`deny`）**未能核实**。

### 3.3 OAuth

- 注册方式：Codex 支持 OAuth Client ID Metadata Documents（CIMD），不可用时回退到 DCR，也可以预配 client。某些回调主机、路径或查询参数需要 DCR 或预配 client。来源：https://developers.openai.com/codex/extend/mcp#oauth-client-registration
- Scopes：优先使用配置的 `scopes`，否则使用 server 公布的 scopes。返回 403 且提示 insufficient scope 时不会自动重新登录。（同上）
- 插件内的 HTTP MCP 可以在 `.mcp.json` 里声明 `oauth{clientId, callbackUrl, callbackPort}`（camelCase）。`callbackPort` 覆盖全局端口，否则使用临时端口。（同上）
- ChatGPT 侧（作为 MCP 客户端）：
  - 首选 CIMD，通过 `client_id_metadata_document_supported: true` 声明。
  - 支持 `none`（PKCE 公共客户端）和 `private_key_jwt`。
  - 采纳 MCP SEP-3149 的 CIMD 过渡方案，DCR 仍支持。
  - 来源：https://developers.openai.com/plugins/build/auth#client-registration
- 2026-08-21 起的稳定值：
  - 稳定回调 `https://chatgpt.com/connector_platform_oauth_redirect`
  - 稳定 CIMD client ID `https://chatgpt.com/oauth/client.json`
  - 来源：https://developers.openai.com/plugins/changelog
- 其他服务端要求：受保护资源元数据（RFC 9728）、授权服务器元数据、在整个流程中回传 `resource` 参数、issuer 校验、mTLS、工作区域名限制、多账户 profile 工具。来源：https://developers.openai.com/plugins/build/auth（各小节标题已确认，逐条细节未全部展开）

### 3.4 规范特性支持情况

| 特性 | OpenAI 文档中的表述 | 来源 |
|---|---|---|
| Tool annotations | `readOnlyHint`、`destructiveHint`、`openWorldHint` 在提交时**必填**，`idempotentHint` 可选；引用 MCP 2025-11-25 的 ToolAnnotations | https://developers.openai.com/plugins/reference#annotations ；https://developers.openai.com/plugins/deploy/submission |
| 注解作用 | 帮助 ChatGPT 和 Codex 选择确认与安全行为，但不能替代服务器端的授权、校验和确认 | https://developers.openai.com/plugins/build/mcp-server#tool-annotations-and-elicitation |
| Codex 对 destructive 的处理 | 声明了副作用的 app/connector 工具会触发审批；声明为 destructive 的 app/MCP 工具**总是**需要审批；`apps.*.destructive_enabled` 和 `open_world_enabled` 可以整体屏蔽这类工具 | https://developers.openai.com/codex/agent-approvals-security ；config-reference |
| Structured content | 返回 `structuredContent`（给模型和组件）、`content`（文本）、`_meta`（只给组件，对模型隐藏）；建议声明 `outputSchema`，`structuredContent` 必须与之匹配 | https://developers.openai.com/plugins/build/mcp-server ；https://developers.openai.com/plugins/reference |
| Elicitation | 支持。只用于向用户收集合理的结构化信息，不得用来收集密钥或绕过认证。Codex 中由 `approval_policy.granular.mcp_elicitations` 控制是否弹出（否则自动拒绝）；等待 elicitation 响应的时间不计入 hook 超时 | https://developers.openai.com/plugins/build/mcp-server ；config-reference ；https://developers.openai.com/codex/hooks |
| Server instructions | ChatGPT 自 2026-05-26 起读取 initialize 返回的 instructions | https://developers.openai.com/plugins/changelog |
| Resource links（`resource_link` 内容类型） | 由 MCP 2025-06-18 规范引入（见 §10.2）。OpenAI 文档中没有检索到 ChatGPT/Codex 是否支持的表述，支持情况**未能核实** | https://modelcontextprotocol.io/specification/2025-06-18/changelog |
| 公司知识（Company knowledge） | 实现标准的 `search`/`fetch` 工具，其他只读工具标 `readOnlyHint:true`；引用需返回绝对 URL | https://developers.openai.com/plugins/build/mcp-server#company-knowledge-compatibility |

---

## 4. Apps SDK / Connectors（UI 与 ChatGPT 集成）

### 4.1 UI 机制：MCP Apps 标准加 ChatGPT 扩展

- 推荐路径是先实现开放的 MCP Apps 标准，再只在需要 ChatGPT 专有能力时使用 `window.openai`。来源：https://developers.openai.com/plugins/build/chatgpt-ui
- 2026-02-22 起，ChatGPT 宣布完全兼容 MCP Apps 规范（https://apps.extensions.modelcontextprotocol.io/api/）。来源：https://developers.openai.com/plugins/changelog

MCP Apps 标准与 ChatGPT 扩展的对照：

| 能力 | MCP Apps 标准 | ChatGPT 扩展 / 兼容别名 |
|---|---|---|
| 把工具关联到 UI 资源 | `_meta.ui.resourceUri` | `_meta["openai/outputTemplate"]`（兼容别名） |
| 接收工具输入 | `ui/initialize` + `ui/notifications/tool-input` | `window.openai.toolInput` |
| 接收工具结果 | `ui/notifications/tool-result` | `window.openai.toolOutput` |
| 从 UI 调用工具 | `tools/call` | `window.openai.callTool` |
| 发送后续消息 | `ui/message` | `window.openai.sendFollowUpMessage` |

来源：https://developers.openai.com/plugins/build/chatgpt-ui

资源声明：

- MIME 类型为 `text/html;profile=mcp-app`（SDK 常量 `RESOURCE_MIME_TYPE`，来自 `@modelcontextprotocol/ext-apps/server` 的 `registerAppResource`）。
- URI 形如 `ui://project-board/v1.html`，**资源 URI 即缓存键**，发生破坏性变更时要换新 URI。
- `_meta.ui` 可设 `prefersBorder`、`domain`，以及 `csp{connectDomains, resourceDomains, frameDomains}`。嵌套 iframe 默认被阻止，`frameDomains` 需要说明理由并经过审核。
- 只有负责渲染的工具才应带 `_meta.ui.resourceUri`。
- 其他 `_meta` 键：
  - `openai/toolInvocation/invoking` 与 `openai/toolInvocation/invoked`（调用状态文案）
  - `openai/widgetDescription`
  - `openai/session`（匿名会话 ID）
  - `_meta.ui.visibility`：替代已弃用的 `openai/visibility`（2026-07-21）
- 来源：https://developers.openai.com/plugins/build/chatgpt-ui ；https://developers.openai.com/plugins/changelog

`window.openai` 仅 ChatGPT 提供的扩展能力：

| API | 用途 |
|---|---|
| `requestCheckout` | Instant Checkout（即时结账） |
| `uploadFile(file,{library:true})`、`selectFiles()`、`getFileDownloadUrl` | ChatGPT 文件与文件库 |
| `requestModal({template})` | 由宿主控制的模态框，可切换模板 |
| `widgetState` / `setWidgetState` | 组件状态持久化 |
| `openExternal({href, redirectUrl})`、`setOpenInAppUrl` | 外部跳转、全屏时「Open in App」的目标 |
| `toolResponseMetadata` | 完整工具结果信封，含隐藏的 `_meta` |
| 宿主样式变量 | `hostContext.styles.variables`（2026-05-28） |

来源：https://developers.openai.com/plugins/build/chatgpt-ui ；https://developers.openai.com/plugins/changelog ；https://developers.openai.com/plugins/reference

- UI 组件库：`@openai/apps-sdk-ui`（https://openai.github.io/apps-sdk-ui/）。
- 示例：https://github.com/openai/openai-apps-sdk-examples。

### 4.2 在 ChatGPT 与 Codex 中的呈现差异

| 维度 | ChatGPT（Web/桌面/移动，Chat 与 Work） | Codex（桌面 App 内 Codex、CLI） |
|---|---|---|
| 插件可用性 | 可用 | 桌面 App 与 CLI 的插件浏览器可用；**IDE 扩展不可用** |
| UI iframe 组件 | 按 MCP Apps 渲染 | Codex 中是否渲染自定义 UI，文档没有明确说明，**未能核实** |
| 技能提及 | `@` | `$`（桌面端 `@` 菜单也会列出技能） |
| Hooks | ChatGPT Work 的运行时会加载插件 hooks（脚本必须存在于执行环境中，Web 安装不会部署脚本） | 加载 |
| 本地 MCP（stdio / `mcp.json`） | Web/移动端不支持；导入的此类插件标为 Desktop only | 支持 |

来源：https://developers.openai.com/codex/enterprise/apps-and-connectors ；https://developers.openai.com/plugins/concepts/plugins ；https://developers.openai.com/codex/enterprise/plugin-management

补充：2026-03-25 插件刚上线时只在 Codex 中可用，已获批的 Apps SDK 集成可以作为 Codex 插件分发。来源：https://developers.openai.com/plugins/changelog

### 4.3 认证与隐私

- 匿名只读的 MCP 可以不做认证；凡是暴露用户数据或写操作的，都应做 OAuth 2.1 认证。同一套 MCP 授权契约同时适用于 ChatGPT 和 Codex。来源：https://developers.openai.com/plugins/build/auth
- 管理员视角：让插件或 MCP 在 ChatGPT 中可用，**不等于**授予外部服务中的数据或操作权限。能力链是：
  1. Availability（可用性）
  2. Included skills（附带技能）
  3. MCP server access（MCP 访问）
  4. Actions and permissions（Action control / App permissions）
  5. Service authorization（服务侧授权）
  6. Runtime permissions（运行时权限）
  - 来源：https://developers.openai.com/codex/enterprise/apps-and-connectors#understand-the-capability-chain
- 2026-06-12 起，用户可以选择已连接应用何时询问权限：总是询问、变更前询问，或仅在重要变更前询问；支持全局和按应用设置。来源：https://developers.openai.com/plugins/changelog
- 安全与隐私指南涵盖：数据最小化、提示词注入与写操作、网络访问、认证授权、运维就绪。来源：https://developers.openai.com/plugins/guides/security-privacy（逐条内容**未能核实**）
- 用户侧：数据发送到外部服务后，适用该服务的条款和隐私政策。来源：https://developers.openai.com/codex/plugins

### 4.4 目录提交与审核

| 步骤 | 内容 | 来源 |
|---|---|---|
| 权限 | 组织角色需有 **Apps Management = Write**（组织 owner 默认拥有），在 platform.openai.com/plugins 提交 | https://developers.openai.com/plugins/deploy/submission |
| 类型 | 仅技能、仅远程 MCP（UI 可选）、MCP + 上传或导入的技能；MCP 必须是稳定的公网 HTTPS 地址（本地 MCP 需联系 OpenAI） | 同上 |
| 表单 | Info、MCP（含模板 URL、域名验证）、Skills、Prompts、Testing（测试用例）、Global（国家/地区与政策声明）、Submit | 同上 |
| 身份 | 需要验证开发者或企业身份 | 同上 |
| 流程 | 提交 → OpenAI 审核（时长不定）→ 通过后由开发者自行选择何时发布 → 进入 ChatGPT 与 Codex 共用的 Plugins Directory | 同上 #public-publishing-flow |
| 持续审核 | 发布后定期扫描工具；变更须通过自动检查，未通过时保留旧定义 | https://developers.openai.com/plugins/deploy/app-review |
| 审核要点 | 工具名、描述、schema、注解与实际行为一致；CSP 与 UI 行为一致；iframe 策略；应用指南（App guidelines） | https://developers.openai.com/plugins/deploy/submission ；https://developers.openai.com/plugins/app-guidelines |
| 迁移 | Claude Code 插件或连接器迁移有专门指南 | https://developers.openai.com/plugins/guides/submit-claude-plugin（正文**未能核实**） |
| 开发测试 | ChatGPT 开发者模式中添加 MCP server、检查工具选择、刷新元数据，也可在 API Playground 中测试 | https://developers.openai.com/plugins/deploy/connect-chatgpt |

---

## 5. Hooks、AGENTS.md、Subagents、Automations 与插件的关系

### 5.1 Hooks

事件（来源：https://developers.openai.com/codex/hooks）：

| 时机 | 事件 |
|---|---|
| 会话或子代理开始 | `SessionStart`、`SubagentStart` |
| 回合内 | `UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStop`、`Stop` |
| 中断 | `Interrupt`（不适用于子代理） |
| 主线程结束 | `SessionEnd`（不适用于子代理） |

配置与加载：

| 项 | 说明 |
|---|---|
| 配置位置 | `~/.codex/hooks.json`、`~/.codex/config.toml` 中的 `[hooks]`、`<repo>/.codex/hooks.json`、`<repo>/.codex/config.toml`、插件、托管（requirements.toml / MDM / 云端） |
| 叠加 | 所有层都会加载，高层不替换低层；项目层 hooks 仅在 `.codex/` 受信任时加载 |
| 结构 | 事件 → matcher 组（如 `"startup\|resume"`）→ handlers（`type:"command"`、`command`、`statusMessage`，以及 `async`、`additionalContextLimit`、`commandWindows`） |
| 执行 | 匹配到的命令 hooks 并发执行；`PreToolUse` 可以带 `permissionDecisionReason` 拒绝工具调用 |
| 信任 | 非托管 hooks（包括**插件 hooks**）必须经用户审查并信任；信任绑定到 hook 的哈希，内容改动后需要重新信任；CLI 中用 `/hooks` 审查、信任或禁用 |
| 托管 | 托管 hooks 由策略信任，用户不能禁用；`allow_managed_hooks_only` 可以只允许托管 hooks；托管目录由 `hooks.managed_dir` / `hooks.windows_managed_dir` 指定 |
| 绕过 | `--dangerously-bypass-hook-trust` 可在单次调用中跳过信任检查 |
| 开关 | `features.hooks` |

与插件的关系：

- 启用插件后，运行时会把插件 hooks 与用户、项目、托管 hooks 一起加载。
- 安装或启用插件**不等于**信任其 hooks。
- 企业可以通过 MDM 部署 hook 脚本。
- 来源：https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks
- 里程碑：Hooks 于 2026-05（5 月 11–15 日这周）GA。来源：https://developers.openai.com/codex/whats-new

### 5.2 AGENTS.md

- 全局层：`~/.codex`（或 `CODEX_HOME`）下的 `AGENTS.override.md`，没有则用 `AGENTS.md`，只取第一个非空文件。
- 项目层：从 Git 根目录往下走到 cwd，在每一级目录依次检查 `AGENTS.override.md`、`AGENTS.md` 和 fallback 文件名。
- 按从根到叶的顺序拼接，越靠近 cwd 的文件优先级越高。
- `project_doc_max_bytes` 默认 32 KiB；空文件跳过；指令链每次运行只构建一次。
- 来源：https://developers.openai.com/codex/agent-configuration/agents-md
- 与插件的关系：官方文档**没有**提到插件可以打包 AGENTS.md。插件通过 skills 和 hooks（如 SessionStart 注入上下文）提供指令。`/init` 可生成项目指令（2026-06）。「插件不能携带 AGENTS.md」这一结论属于推断，**未能核实**。

### 5.3 Subagents（子代理）

- 配置键：
  - `agents.{enabled, max_concurrent_threads_per_session, max_threads, default_subagent_model, default_subagent_reasoning_effort, interrupt_message}`
  - `agents.<name>.{description, config_file}`：自定义代理，指向独立配置文件
- 来源：https://developers.openai.com/codex/config-file/config-reference ；https://developers.openai.com/codex/agent-configuration/subagents
- Hooks 有 `SubagentStart` 和 `SubagentStop` 两个事件。
- 插件能否打包自定义子代理定义：文档没有检索到，**未能核实**。

### 5.4 Automations / Scheduled tasks

- 文档页名为「Scheduled tasks」（https://developers.openai.com/codex/automations）：支持定时任务并选择运行环境（2026-03-09–13）。
- 2026-08-25 起，可以由 Gmail、Slack、GitHub 事件触发（ChatGPT Web/移动端、符合条件的套餐）；需要先连接对应应用并授权。
- 来源：https://developers.openai.com/codex/whats-new
- 与插件的关系：事件触发依赖已连接的 app（即 MCP 或连接器），本质上复用插件或连接器的能力。自动化能否由插件声明，**未能核实**。
- 相关：企业可以启用 Codex access tokens，供脚本、调度器和私有 CI 使用（2026-05）。来源同上。

### 5.5 关系小结

| 机制 | 能否放进插件 | 由谁信任或控制 |
|---|---|---|
| Skills | 能（`skills/`） | 插件启用状态；技能开关；`allow_implicit_invocation` |
| MCP servers | 能（`mcp.json` / `.mcp.json` / `.app.json`） | `plugins.<p>.mcp_servers.*`；审批模式；工作区 apps |
| Hooks | 能（`hooks/hooks.json` 或 manifest 中的 `hooks`） | 用户逐个哈希信任；托管策略 |
| AGENTS.md | 文档未提及（**未能核实**） | 项目信任 |
| Subagents | 文档未提及（**未能核实**） | `agents.*` 配置 |
| Automations | 文档未提及（**未能核实**） | 产品 UI、管理员 |

---

## 6. 安全：沙箱、审批、网络、插件信任与托管配置

### 6.1 沙箱与审批

| 项 | 要点 | 来源 |
|---|---|---|
| 插件继承宿主策略 | 插件遵循宿主的 sandbox 和 approval 策略；外部服务使用各自的认证 | https://developers.openai.com/codex/plugins |
| `sandbox_mode` | read-only / workspace-write / danger-full-access；`sandbox_workspace_write.{writable_roots, network_access, exclude_tmpdir_env_var, exclude_slash_tmp}` | https://developers.openai.com/codex/sandboxing ；config-reference |
| 权限配置档（permission profiles） | Codex 0.138.0+ 推荐使用 `default_permissions` + `allowed_permission_profiles`，取代 `sandbox_mode` | https://developers.openai.com/codex/permissions ；https://developers.openai.com/codex/enterprise/managed-configuration |
| `approval_policy` | `on-request`、`never`，或 `{granular={sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval}}`；原 `untrusted` 策略已退役，需要迁移 | https://developers.openai.com/codex/agent-approvals-security |
| 自动审批审查 | `approvals_reviewer`；`--approve-for-me`（CLI 0.147.0）可对符合条件的请求自动审查，但不扩大文件系统或网络权限；`features.guardian_approval` | https://developers.openai.com/codex/whats-new ；config-reference |
| App 工具 | `apps._default` / `apps.<id>` 下的 `enabled`、`destructive_enabled`、`open_world_enabled`、`default_tools_approval_mode`、`approvals_reviewer`、`tools.<t>.{enabled, approval_mode}` | config-reference |
| OS 级沙箱 | macOS Seatbelt、Linux、Windows（`windows.sandbox`、`sandbox_private_desktop`）、Dev Containers | https://developers.openai.com/codex/agent-approvals-security#os-level-sandbox |

### 6.2 网络

- 命令网络通过代理隔离，支持网络策略、本地或私网目标限制、DNS 重绑定防护，并列出了危险设置。
- 文档也说明了命令网络代理之外的流量，例如 `web_search = "disabled" | "live"`。
- 来源：https://developers.openai.com/codex/agent-approvals-security#network-access
- MCP 远程服务的流量是否经过该代理：**未能核实**。
- 托管侧：requirements 中有「Configure network access requirements」一节。来源：https://developers.openai.com/codex/enterprise/managed-configuration#configure-network-access-requirements

### 6.3 插件信任模型

| 层 | 机制 |
|---|---|
| 来源信任 | 公共目录经过 OpenAI 审核和持续扫描；本地、个人或 Git marketplace 由用户自行负责；企业可以用 `marketplaces.restrict_to_allowed_sources` 限制来源 |
| 项目信任 | 仓库的 `.codex/config.toml` 和项目 hooks 只在受信任项目中加载 |
| Hooks 信任 | 插件 hooks 属于非托管 hooks，按哈希信任，改动后需要重新信任 |
| 工具信任 | 注解驱动审批（destructive 总是需要审批）；审批模式可逐个工具配置 |
| 服务授权 | 独立 OAuth；插件可用不代表服务侧有权限 |

来源：https://developers.openai.com/plugins/build/plugins ；https://developers.openai.com/codex/hooks ；https://developers.openai.com/codex/enterprise/managed-configuration ；https://developers.openai.com/codex/enterprise/apps-and-connectors

### 6.4 `requirements.toml` 与托管配置

`requirements.toml` 的加载层级（低 → 高）：

1. 系统 `/etc/codex/requirements.toml`（Windows 为 `%ProgramData%\OpenAI\Codex\requirements.toml`）
2. 云端企业托管
3. 旧版 `managed_config.toml` 中被重新解释的字段
4. macOS MDM 的 `com.openai.codex:requirements_toml_base64`

合并规则：标量和列表由高层覆盖，表按键合并，rules、hooks 等有各自的专门合并规则。来源：https://developers.openai.com/codex/enterprise/managed-configuration#locations-and-precedence

与插件相关的 requirements：

```toml
features.plugins = false          # 关闭插件（API key 登录时同样生效）
features.plugin_sharing = false   # 禁止发布到工作区
[marketplaces]
restrict_to_allowed_sources = true
[marketplaces.allowed_sources.openai_curated]
source = "git"
url = "https://github.com/openai/plugins.git"   # 允许 OpenAI 精选 Git 目录（不加 ref）
[marketplaces.allowed_sources.internal_git]
source = "host_pattern"
host_pattern = '^git\.example\.com$'
[marketplaces.allowed_sources.local_plugins]
source = "local"
path = "/opt/company/codex-plugins"
```

- 不匹配的 marketplace add、plugin install 和 Git 刷新都会被拒绝，运行时也会过滤。
- 内置插件和远程安装的工作区插件不受此限制。
- 这些限制只在桌面 App 和 Codex CLI 中生效，**不控制** ChatGPT Web/移动端，也不会给 IDE 扩展增加插件。
- 其他可约束项：
  - `allowed_approval_policies`、`allowed_approvals_reviewers`、`allowed_sandbox_modes`、`allowed_permission_profiles`
  - `remote_sandbox_config[]`（按主机覆盖）
  - `allow_managed_hooks_only`、`allow_appshots`
  - `browser_use.*`、`computer_use.allow_persistent_approval`
  - MCP server 身份白名单（`mcp_servers.<id>.identity.*` 和插件内的同名键）
  - deny-read、命令 rules
- `managed_config.toml` 只提供托管**默认值**，不是强制策略；支持 MDM 下发。marketplace 和插件默认值可写在系统或云端 `config.toml` 中，同样不是强制策略。
- 本小节来源：https://developers.openai.com/codex/enterprise/managed-configuration ；https://developers.openai.com/codex/config-file/config-reference

---

## 7. UX：发现、安装、提及、建议与设置

| 场景 | 行为 | 来源 |
|---|---|---|
| 发现（ChatGPT） | chatgpt.com/plugins，分 Personal 等标签；公共 Plugins Directory 由 ChatGPT 与 Codex 共用 | https://developers.openai.com/plugins/build/plugins ；https://developers.openai.com/codex/skills-and-plugins |
| 发现（CLI） | `/plugins` 浏览器按 marketplace 分标签；CLI 0.147.0 起可搜索本地、个人、工作区和远程目录 | https://developers.openai.com/codex/plugins ；https://developers.openai.com/codex/whats-new |
| 安装界面 | 显示 `interface` 元数据（名称、描述、开发者、能力、截图、隐私和条款链接、起始提示词、品牌色、composerIcon） | https://developers.openai.com/plugins/build/plugins |
| 认证时机 | `policy.authentication` 为 `ON_INSTALL` 或 `ON_USE` | 同上 |
| 默认安装 | `INSTALLED_BY_DEFAULT`；管理员可按角色设为 Available 或 Installed | 同上；https://developers.openai.com/codex/enterprise/plugin-management |
| 提及 | ChatGPT 用 `@`，Codex 用 `$`；桌面 App 的 `@` 菜单会列出已启用技能（2026-03-19） | https://developers.openai.com/codex/skills-and-plugins ；https://developers.openai.com/codex/whats-new |
| 工具建议 | `tool_suggest.{discoverables, disabled_tools}` 配置键说明存在「建议可发现工具或插件」的机制，但交互细节**未能核实** | https://developers.openai.com/codex/config-file/config-reference |
| 插件或技能页面 | 2026-03-25 插件上线时改版了插件和技能页面，状态更清晰；2026-06 改进了插件管理 | https://developers.openai.com/codex/whats-new |
| 设置页 | 桌面 App 设置中有 Import（从 Claude Code、Cursor 等导入技能和插件，可自动同步）；CLI 用 `/import` | https://developers.openai.com/codex/whats-new ；https://developers.openai.com/codex/reference/settings（设置页插件项的逐条内容**未能核实**） |
| 起始提示词 | `defaultPrompt`（插件）与 `default_prompt`（技能） | https://developers.openai.com/plugins/build/plugins ；https://developers.openai.com/codex/skills |
| 管理员导出 | Admin > Plugins > Public > Export CSV，列出公共插件、应用、技能元数据（2026-08-17） | https://developers.openai.com/codex/whats-new |

---

## 8. 2025–2026 变更时间线

| 日期 | 事件 | 来源 |
|---|---|---|
| 2025 年 | Apps SDK、ChatGPT 连接器和 Codex 技能在 2025 年的早期里程碑，未在本次抓取的页面中找到（What's new 最早只到 2026-02），**未能核实** | — |
| 2026-01-15 | 工具调用带 `_meta["openai/session"]`；`requestModal` 支持切换模板 | https://developers.openai.com/plugins/changelog |
| 2026-01-21 | 公司知识 `search`/`fetch` 兼容指南 | 同上 |
| 2026-02-02 | `openExternal` 的 `redirectUrl:false`、`setOpenInAppUrl`、`openai/widgetDescription`、`sendFollowUpMessage` 的 `scrollToBottom` | 同上 |
| 2026-02-02–06 | Codex app 在 macOS 上线 | https://developers.openai.com/codex/whats-new |
| 2026-02-22 | ChatGPT 完全兼容 MCP Apps 规范 | https://developers.openai.com/plugins/changelog |
| 2026-03-09 | `uploadFile` 支持非图片文件 | 同上 |
| 2026-03-09–13 | 定时任务可选择运行环境 | https://developers.openai.com/codex/whats-new |
| 2026-03-19 | 已启用技能出现在 `@` 菜单 | 同上 |
| 2026-03-24 | `selectFiles` 和 `uploadFile({library:true})` 支持文件库 | https://developers.openai.com/plugins/changelog |
| **2026-03-25** | **Plugins 发布**：可安装的技能、连接器和 MCP 捆绑包；起初只在 Codex 中可用；已获批的 Apps SDK 集成可作为 Codex 插件分发 | https://developers.openai.com/codex/whats-new ；https://developers.openai.com/plugins/changelog |
| 2026-05-06 | 文档推荐为工具声明 `outputSchema` | https://developers.openai.com/plugins/changelog |
| 2026-05-13/14 | **Hooks GA**；Codex access tokens | https://developers.openai.com/codex/whats-new |
| 2026-05-26 | ChatGPT 读取 MCP server instructions | https://developers.openai.com/plugins/changelog |
| 2026-05-27/28 | `toolResponseMetadata` 保留完整信封；审批后再投递 tool-input；宿主 CSS 变量 | 同上 |
| 2026-06-08–12 | 迁移或导入流程、`/init`、改进插件管理 | https://developers.openai.com/codex/whats-new |
| 2026-06-12 | ChatGPT 应用权限控制（总是、变更前、仅重要变更前） | https://developers.openai.com/plugins/changelog |
| 2026-06-15–19 | Record & Replay 把演示转成技能 | https://developers.openai.com/codex/whats-new |
| 2026-07-09 | Codex app 并入 ChatGPT 桌面 App（macOS/Windows） | 同上 |
| 2026-07-21 | 弃用 `_meta["openai/visibility"]`，改用 `_meta.ui.visibility` | https://developers.openai.com/plugins/changelog |
| 2026-07（下旬） | Codex CLI 0.146.0 支持 Agent Plugins 清单、工作区插件发布和其他 marketplace | https://developers.openai.com/codex/whats-new ；https://github.com/openai/codex/releases/tag/rust-v0.146.0 |
| 2026-08-03–07 | Codex CLI 0.147.0 支持可移植 Agent Plugins、跨目录搜索、`--approve-for-me`；上线教育类插件 | https://developers.openai.com/codex/whats-new ；https://github.com/openai/codex/releases/tag/rust-v0.147.0 |
| 2026-08-11 | 从 Claude Code、Claude Cowork、Cursor 导入指令、技能和插件；CLI 支持 `/import` | https://developers.openai.com/codex/whats-new |
| 2026-08-17 | 管理员可导出公共插件 CSV | 同上 |
| 2026-08-20 | Apple Messages 插件（仅 Mac） | 同上；https://developers.openai.com/codex/plugins |
| 2026-08-21 | 稳定 OAuth 回调和 CIMD client ID | https://developers.openai.com/plugins/changelog |
| 2026-08-25 | 定时任务支持由应用事件触发（Gmail、Slack、GitHub） | https://developers.openai.com/codex/whats-new |

---

## 9. 未能核实清单（汇总）

1. `.codex-plugin/plugin.json` 旧版 schema 的完整字段。（`codex plugin` 的子命令已由源码核实，见 §10.1。）
2. ChatGPT/Codex 对 MCP `resource_link`、URL 模式 elicitation、tasks、icons 的支持情况（这些是规范特性，产品支持情况未能核实）；`approval_mode` 的完整枚举。
3. Codex（非 ChatGPT）是否渲染 MCP Apps UI iframe。
4. 插件能否打包 AGENTS.md、子代理定义或自动化。
5. `tool_suggest` 的交互细节；设置页中插件相关项的逐条内容。
6. `skill_approval` 的触发条件；`skill_mcp_dependency_install` 的具体行为。
7. 2025 年 Apps SDK 与 Codex 技能的早期时间点（本次抓取的 What's new 页最早只到 2026-02）。
8. Security & Privacy 指南、Skill controls、Claude 插件迁移指南的逐条正文。

---

## 10. 补查（2026-09-26 追加）

### 10.1 codex-rs 源码：`codex plugin` 子命令

来源：https://github.com/openai/codex/blob/main/codex-rs/cli/src/plugin_cmd.rs 与 `marketplace_cmd.rs`，main 分支 commit `98072cf`（2026-09-27 UTC）

| 子命令 | 源码注释 / 参数 |
|---|---|
| `codex plugin add <PLUGIN[@MARKETPLACE]>` | 从已配置或远程的 marketplace 安装插件；`-m/--marketplace`、`--json` |
| `codex plugin list` | 列出已配置和远程 marketplace 中的插件；`-m/--marketplace`、`--json`、`--available`（在 JSON 中包含未安装插件，需与 `--json` 同用） |
| `codex plugin remove <PLUGIN[@MARKETPLACE]>` | 卸载插件并删除本地缓存；`-m`、`--json` |
| `codex plugin marketplace add/list/upgrade/remove` | 与官方文档一致（`MarketplaceSubcommand` 枚举） |

结论：插件选择器格式为 `PLUGIN@MARKETPLACE`，与 config.toml 中的 `[plugins."<plugin>@<marketplace>"]` 键一致。安装子命令叫 `add`，不叫 `install`。

### 10.2 MCP 规范新特性（作为理解 OpenAI 支持项的背景）

2025-06-18 版（相对 2025-03-26 的变更），来源：https://modelcontextprotocol.io/specification/2025-06-18/changelog

| 变更 | 与 OpenAI 文档的对应 |
|---|---|
| 移除 JSON-RPC batching | — |
| 结构化工具输出（`structuredContent` / `outputSchema`） | 被 OpenAI 采用，推荐声明 `outputSchema`（§3.4） |
| MCP server 被归类为 OAuth Resource Server（受保护资源元数据）；客户端必须实现 RFC 8707 Resource Indicators | 对应 OpenAI auth 文档中的受保护资源元数据和 `resource` 参数（§3.3） |
| Elicitation | 被 OpenAI 采用（§3.4） |
| 工具结果中的 Resource links | OpenAI 支持情况**未能核实** |
| HTTP 必须携带 `MCP-Protocol-Version` 头；新增 `_meta` 用法和 `title` 字段 | OpenAI 大量使用 `_meta`（§4.1） |

2025-11-25 版，来源：https://modelcontextprotocol.io/specification/2025-11-25/changelog

| 变更 | 与 OpenAI 文档的对应 |
|---|---|
| 支持 OIDC Discovery；通过 `WWW-Authenticate` 做增量 scope 授权（SEP-835） | Codex 对 403 insufficient scope 不自动重新登录（§3.3） |
| **CIMD** 成为推荐的客户端注册方式（SEP-991） | ChatGPT 和 Codex 都首选 CIMD（§3.3） |
| tools、resources、prompts 支持 icons（SEP-973）；工具命名指南（SEP-986） | 未见 OpenAI 表述，**未能核实** |
| Elicitation 枚举改为更标准的方式；**URL 模式 elicitation**（SEP-1036）；elicitation 字段支持默认值 | OpenAI 要求不得用 elicitation 收集密钥或认证信息；是否支持 URL 模式**未能核实** |
| Sampling 支持工具调用（`tools`/`toolChoice`） | **未能核实** |
| 实验性 **tasks**（持久请求、轮询、延迟结果，SEP-1686） | **未能核实** |
| 输入校验错误作为 Tool Execution Error 返回；默认 JSON Schema 方言为 2020-12；PRM 发现与 RFC 9728 对齐 | — |
| ToolAnnotations（readOnly/destructive/openWorld/idempotent） | OpenAI 提交时引用 2025-11-25 的 ToolAnnotations（§3.4） |

### 10.3 已复核的说法

以下说法已在 `/tmp/oai` 缓存的原文中逐条 grep 确认：

- Desktop only 标记、`.app.json`（带前导点）、「No longer in source」、capability chain，来源：https://developers.openai.com/codex/enterprise/plugin-management ，https://developers.openai.com/codex/enterprise/apps-and-connectors
- CLI 0.146.0 / 0.147.0 的插件相关内容；7 月 9 日 Codex app 并入 ChatGPT 桌面 App；2026-08-20 Apple Messages 插件发布说明，来源：https://developers.openai.com/codex/whats-new
