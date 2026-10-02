# miniQ 插件体系盘点（事实清单）

> 调研日期：2026-09-27；只读调研，未改动代码。
> 证据格式为 `路径:行号`。“未实现/未发现”指在仓库中检索不到对应代码，不代表设计上排除。
> 前端路径中的 `src/` 均指 `apps/desktop/src/`。

## 0. 总览

| 维度 | 现状一句话 | 关键证据 |
|---|---|---|
| 插件运行时 | 3 种：WASM Component、受信 Node、纯技能包（Skills） | `crates/miniq-protocol/src/plugin.rs:15-21` |
| 插件能扩展什么 | 只有 **tool**（模型可调用工具）和 **skills**（技能包） | `crates/miniq-plugins/src/manifest.rs:12-15` |
| 安装来源 | 只能从本地目录安装或更新 | `crates/miniq-protocol/src/plugin.rs:78-83` |
| 签名 | 未发现发布者签名；只有 Node 插件的本地信任指纹 | `crates/miniq-plugins/src/manager.rs:808-825` |
| 沙箱 | WASM：Wasmtime，限制 fuel、内存、超时，WASI ctx 为空。Node：`--permission --allow-fs-read=.`，并清空环境变量 | `host.rs:98-99,246-252`；`node.rs:124-146` |
| MCP | 只支持 stdio 客户端，只有 `tools/list` 和 `tools/call`，通过单一的 `mcp_call` 工具暴露 | `crates/miniq-daemon/src/mcp.rs:1-3,159-182`；`crates/miniq-tools/src/mcp.rs:34-71` |
| Skills | 来源为内置、用户、项目三层并互相覆盖；以 `<available_skills>` 块注入提示词，再由 `skill_read` 按需读取 | `crates/miniq-skills/src/store.rs:117-160`；`crates/miniq-daemon/src/turn.rs:375-376` |
| 市场或索引 | 未发现 | 见第 6 节 |
| CLI plugin 子命令 | 未发现，只能用通用的 `rpc` 子命令 | `crates/miniq-cli/src/args.rs:95-96` |

---

## 1. 插件格式、生命周期、签名、沙箱与限制

### 1.1 目录与 manifest（`manifest.toml`）

| 字段 | 类型与约束 | 证据 |
|---|---|---|
| `id` | 至少 3 段、用点分隔；每段以小写字母开头，只含 `[a-z0-9-]`，不能以 `-` 结尾；必须与目录名一致 | `manifest.rs:37,163-177`；目录名一致的测试 `rejects_manifest_id_that_differs_from_directory` 在 `manager.rs` 的测试段（897-1164 行） |
| `name` | 不能为空 | `manifest.rs:38,106-108` |
| `version` | semver | `manifest.rs:39` |
| `api_version` | 必须精确等于 `1.0.0` | `manifest.rs:8,40,109-113` |
| `runtime` | `wasm`、`node`、`skills` | `manifest.rs:41`；`plugin.rs(protocol):15-21` |
| `entry` | WASM 要求 `.wasm`，Node 要求 `.js`/`.mjs`，都必须是相对路径且只含普通组件；Skills 必须为空 | `manifest.rs:43,147-158,179-199` |
| `capabilities` | 可选 `tool`、`skills`。Skills 运行时必须只写 `["skills"]`；其他运行时必须包含 `tool`，且写了 `skills` 就必须有 `skills` 列表 | `manifest.rs:12-15,114-129` |
| `skills` | 相对目录列表，每个目录下需有 `SKILL.md` | `manifest.rs:46,121`；`manager.rs:194-206` |
| `requires` | 依赖命令名，不能含路径分隔符；只做可用性检测，不阻止加载 | `manifest.rs:48,122-126`；`manager.rs:88-92,735` |
| `permissions` | 取值为 `log`、`workspace_read`、`workspace_write`、`http_client`、`memory_read`、`memory_write` | `manifest.rs:19-26,50` |
| `enabled` | 默认值 true，但 Node 插件实际默认禁用（见 1.3） | `manifest.rs:51-52,61`；测试 `node_plugins_default_to_disabled` 在 `manifest.rs:310` |
| `description`、`author` | 可选 | `manifest.rs:53-56` |
| `engine.node` | semver 范围。Node 插件必填，WASM 插件禁止填写 | `manifest.rs:30-31,58,131-134,143-145` |
| 未知字段 | 拒绝（`deny_unknown_fields`） | `manifest.rs:29,35` |

- **WIT 接口 v1**（`crates/miniq-plugins/wit/v1/plugin.wit:1-42`）
  - 宿主向插件导入的只有 `host.log(level, message)`（3-13 行）。
  - 插件导出 `identity()`、`tools()`、`execute(tool-name, arguments-json)`（34-36 行）。
  - world 为 `tool-plugin`（39-42 行）。
- **Node 协议**：JSON-RPC 2.0，版本 1，单帧上限 1 MiB，最多 32 个待处理请求（`crates/miniq-protocol/src/node_plugin.rs:5-7`）。
  - daemon 向插件发出：initialize、activate、tool.execute、tool.cancel、deactivate、shutdown、ping（51-66 行）。
  - 插件向 daemon 发出：hello、activated、tools.register、tools.unregister、tool.result、log、error、pong（69-86 行）。
- **SDK 与宿主包**
  - `packages/plugin-sdk`：`@miniq/plugin-sdk` 0.1.0，private。
  - `packages/node-plugin-host`：`@miniq/node-plugin-host` 0.1.0，private，要求 node>=22。
  - 宿主脚本在编译期内嵌：`crates/miniq-plugins/src/node.rs:81`。

### 1.2 生命周期

| 阶段 | 行为 | 证据 |
|---|---|---|
| 启动扫描 | daemon 启动时调用 `scan_and_load`，失败只记日志 | `crates/miniq-daemon/src/main.rs:70-72` |
| 数据目录 | `<data_dir>/plugins` | `crates/miniq-daemon/src/state.rs:171-175` |
| 扫描 | 跳过 `.install-*` 和 `.backup-*` 临时目录，以及内部 Node 宿主目录 | `manager.rs:19,294-306` |
| 安装 | 复制到 `.install-*` 临时目录，校验后 rename 到正式位置；已安装的插件不能重复安装 | `manager.rs:168,184-261` |
| 更新 | `update_from_directory` 通过 `.backup-*` 原子替换 | `manager.rs:175,219-261` |
| 复制安全 | 拒绝符号链接（`copy_directory`）；`secure_entry`/`secure_directory` 防止路径逃逸 | `manager.rs:706`；`manager.rs:827-859` |
| 卸载 | 调用 `remove_dir_all` | `manager.rs:273` |
| 启用或禁用 | 改写 manifest 的 `enabled` 并写回，再 unload 和 `load_directory` | `manager.rs:347-407` |
| 激活 | 按运行时分支：Wasm 在 544 行，Node 在 568 行，Skills 在 589-600 行。Skills 只校验 `SKILL.md`，不注册工具 | `manager.rs:544-624` |
| 工具注册 | 公开名为 `<plugin-id>.<tool>`，通过 `router.register_plugin` 注册并带运行时标签；重名时报 `RegistrationConflict` | `host.rs:350`；`node.rs:512`；`manager.rs:618-624`；`crates/miniq-tools/src/router.rs:313-322` |
| 状态 | Discovered、Disabled、Loading、Active、Failed、Unloading | `crates/miniq-protocol/src/plugin.rs:5-13` |
| 重载 | `reload` | `manager.rs:327` |
| 变更通知 | 发出 `Event::PluginsChanged` 事件 | `crates/miniq-daemon/src/gateway/plugin.rs:81-87` |

### 1.3 信任与签名

- **发布者签名、证书、校验和清单：** 均未发现。检索 manifest、manager 和 docs，都没有签名字段或签名校验代码。
- **Node 插件的本地信任：**
  - 启用时必须传 `confirm_trusted_code`（`manager.rs:368-371`）。
  - 确认后写入 `.trusted-node.json`（`manager.rs:18,374-394,675-698`）。
  - 加载时要求 `manifest.enabled && fingerprint 匹配`（`manager.rs:475-479`）。
- **指纹的覆盖范围：** 对 `(id, version, runtime, entry, permissions, engine)` 和 **entry 这一个文件的字节**做 SHA-256（`manager.rs:808-825`）。
  - 不包含 `capabilities`。
  - 不包含 entry 以外的 JS 文件和 `node_modules`。
- **WASM 插件：** 无需信任确认，因为 `set_enabled` 只对 Node 插件要求确认（`manager.rs:368-371`）。

### 1.4 沙箱与资源限制

| 项 | WASM | Node | 证据 |
|---|---|---|---|
| 隔离机制 | Wasmtime Component；每次调用新建 Store 和实例 | 独立 `node` 子进程，使用 Node Permission Model | `host.rs:11-12,237-252`；`node.rs:124-129` |
| 文件系统 | WASI ctx 为空，没有预开目录（`WasiCtxBuilder::new().build()`） | 只加 `--allow-fs-read=.`，cwd 为插件目录；未发现写权限 flag | `host.rs:248`；`node.rs:126-129` |
| 网络 | 空 ctx，未授予 socket | 代码未对网络加任何限制 flag | `host.rs:248`；`node.rs:124-150` |
| 环境变量 | 空 | `env_clear()` 后只放行白名单（PATH、TEMP、Windows 系统变量等）和 `MINIQ_PLUGIN_ID` | `node.rs:130-146` |
| manifest 权限的实际作用 | 只有 `log` 生效，用来控制 log 开关；声明其他权限会被拒绝 | 声明的权限**不映射**到任何 `--allow-*` flag，只用于展示和计算信任指纹 | `host.rs:243`；`manifest.rs:136-141`；`node.rs:124-128`（没有 permissions 引用） |
| CPU | fuel 1000 万/次，外加 epoch 中断 | 调用超时 | `host.rs:98-109`；`error.rs:116-133` |
| 内存 | 32 MiB（`StoreLimits`） | 未限制 | `host.rs:246,252` |
| 调用超时 | 5 s（`bounded_call`） | 5 s，超时后发送 `tool.cancel` | `host.rs:278-291`；`node.rs:360-385` |
| 输入/输出上限 | 1 MiB / 4 MiB | 帧上限 1 MiB | `host.rs:196,213`；`node_plugin.rs:6` |
| 并发 | 每个插件 4 个（Semaphore） | 最多 32 个待处理请求 | `host.rs:115`；`node_plugin.rs:7` |
| 组件大小 | 16 MiB | — | `host.rs:90` |
| 启动、握手、关闭 | — | 启动和握手各 5 s，关闭 2 s，stderr 最多 256 KiB | `error.rs:116-133`；`node.rs:212-285,459-486,699-716` |
| 进程回收 | — | `kill_on_drop`；Windows 下 `assign(child)`（文档称使用 Job Object） | `node.rs:33,150`；`docs/node-plugins.md:85` |

### 1.5 风险等级与审批

| 来源 | 风险 | 是否走审批 | 证据 |
|---|---|---|---|
| WASM 插件工具 | 固定为 Low | **不审批**，直接执行 | `host.rs:375-377`；`crates/miniq-daemon/src/executor.rs:509-567` |
| Node 插件工具 | 固定为 Medium，理由是 “trusted Node plugin executes with the current user account” | 需要审批；审批模式为工具名，可在会话内允许，`dontAsk` 模式下跳过 | `node.rs:544-547`；`executor.rs:81-129,557` |
| `mcp_call` | 固定为 High | 需要审批，模式为 `mcp_call:{server}` | `crates/miniq-tools/src/mcp.rs:52-57`；`executor.rs:81-129` |
| `skill_read` | Low | 不审批 | `crates/miniq-tools/src/skill.rs:42-47` |

---

## 2. 能力暴露面

| 扩展点 | 插件能否提供 | 说明与证据 |
|---|---|---|
| 模型工具（tool） | 能（WASM/Node） | 注册进 `ToolRouter`，来源记为 `ToolOrigin::Plugin`（`router.rs:48,313-322`）；可被 `tool_search` 动态检索到（`crates/miniq-tools/src/catalog.rs`，测试 `search_reads_the_latest_dynamic_catalog`:207） |
| Skills | 能（`runtime=skills`，或作为 tool 插件的附带能力） | 安装时复制到用户技能目录，见第 4 节 |
| Slash 命令 | 否 | 前端的静态命令 `plugins` 只负责跳到插件页（`src/composerCommands.ts:166-190`）。技能可以作为 `skill:<name>` 斜杠命令（`src/hooks/useSlashSkills.ts:40-51`）。未发现由插件声明的命令 |
| UI 扩展（面板、webview、设置项） | 否 | manifest 中没有相关字段（`manifest.rs:36-59`）；`crates/miniq-plugins/src/lib.rs:1-4` 注明“no daemon, RPC, UI or persistence dependency” |
| 插件设置或配置 schema | 未发现 | manifest 中没有 config 字段 |
| 通过插件打包 MCP 服务器 | 未发现 | manifest 中没有 mcp 字段；MCP 只能在设置里配置（第 3 节） |
| Hooks（生命周期或工具钩子） | 未发现 | `crates/miniq-daemon/src/executor/hooks.rs`（106 行）只对内置工具名硬编码处理 |
| 自动化或定时任务 | 否 | `schedule.*` RPC 是内置功能（`crates/miniq-daemon/src/gateway.rs:92-98`），与插件无关 |
| 上下文注入 | 只能通过 Skills | 技能块注入系统提示（`turn.rs:81-89,375-376`）；插件本身不能注入 |
| 访问宿主 API（memory、workspace、model、http） | 否 | WIT 中只有 `log`（`plugin.wit:3-13`）；Node 协议中也没有宿主 API 方法（`node_plugin.rs:51-86`） |

**daemon RPC**（`crates/miniq-daemon/src/gateway.rs:164-179`）：

| 模块 | 方法 |
|---|---|
| plugin | `plugin.list`、`plugin.install`、`plugin.uninstall`、`plugin.reload`、`plugin.setEnabled`、`plugin.getDiagnostics` |
| skill | `skill.list`、`skill.read`、`skill.setEnabled`、`skill.delete`、`skill.import`、`skill.distill`、`skill.refine`、`skill.save` |
| mcp | `mcp.list`、`mcp.update` |

`plugin.setEnabled` 对非布尔参数会返回明确的类型错误（`gateway/plugin.rs:98-135`）。

---

## 3. MCP

| 项 | 现状 | 证据 |
|---|---|---|
| 角色 | 只做客户端，未发现 MCP server 侧实现 | `crates/miniq-daemon/src/mcp.rs:1-3` |
| 传输 | 只有 stdio（换行分隔的 JSON）。HTTP、SSE、Streamable HTTP 未实现 | `mcp.rs:1-3,97-106` |
| 协议版本 | `2024-11-05` | `mcp.rs:15` |
| 配置字段 | `name`、`command`、`args`、`enabled`（默认 true）。没有 env、cwd、url、headers、OAuth | `mcp.rs:17-30` |
| 配置存储 | 设置中的 `mcp_servers` 字段；用 `mcp.update` 整体覆盖；校验只要求 name 和 command 不为空 | `state.rs:30`；`gateway/mcp.rs:64-85` |
| 子进程 | 继承 daemon 的环境变量（没有 `env_clear`），stderr 丢弃，`kill_on_drop` | `mcp.rs:98-105` |
| 握手 | `initialize`，capabilities 为空，随后发送 `notifications/initialized` | `mcp.rs:115-125` |
| 支持的方法 | 只有 `tools/list` 和 `tools/call`。resources、prompts、sampling、roots、通知和进度都未实现 | `mcp.rs:159-182` |
| 连接管理 | 懒连接并长驻；进程退出或请求出错后下次重建；每个请求超时 30 s | `mcp.rs:14,130-157` |
| 暴露给模型的方式 | 只有单一工具 `mcp_call(server, tool, arguments)`。MCP 工具**不会**逐个注册成独立工具，工具列表也不会注入提示词（`turn.rs` 中只有 `.with_mcp` 一处引用）。模型需要自己知道 server 名和 tool 名 | `crates/miniq-tools/src/mcp.rs:34-50`；`turn.rs:550`；`agent_tasks.rs:254` |
| 未配置时 | 没有配置任何 server 时 bridge 为 None，调用返回 “no MCP servers are configured” | `state.rs:225-234`；`crates/miniq-tools/src/mcp.rs:61-65` |
| 审批 | High 风险，按 server 维度审批 | `crates/miniq-tools/src/mcp.rs:52-57`；`executor.rs:81-129` |
| 前端 | 可以添加、开关、删除，也能测试连接；不能编辑已有项；参数按空格切分，不支持引号 | `src/components/Mcp.tsx:44-81,188-207,61` |
| 测试 | `mcp_configure_list_and_call_through_agent`、`mcp_unknown_server_reports_error`，使用 mock-mcp 二进制 | `crates/miniq-daemon/tests/m6_mcp.rs:70,157` |

---

## 4. Skills

| 项 | 现状 | 证据 |
|---|---|---|
| 格式 | `SKILL.md` = YAML frontmatter + 正文 | `crates/miniq-skills/src/parse.rs:72-106` |
| frontmatter 字段 | `name`（`[a-z0-9-]`，≤64）、`description`、`version`（u32，默认 1）、`origin`（bundled/user/distilled/installed）、`requires.bins`、`allowed_tools` | `parse.rs:25-70` |
| `allowed_tools` | 能解析，但**未被执行**：在 `parse.rs` 以外没有任何引用 | `parse.rs:49-51` |
| 来源和优先级 | 内置 < 用户（`<data_dir>/skills`）< 项目（`<ws>/.miniq/skills`），同名时后者覆盖前者 | `store.rs:96-160` |
| 内置技能 | 共 10 个：organize-directory、summarize-changes、email-draft、develop-miniq-plugin、document、pdf、spreadsheet、presentation、visualization、latex 的 workflow 技能 | `crates/miniq-skills/src/lib.rs:27` 起 |
| 启用状态 | 全局保存在 `skills-state.json` 的禁用集合里，按名称记录 | `store.rs:96-109,293` |
| 注入方式 | 每轮对话调用 `discover`，生成 `<available_skills>` 块（预算 12 000 字符，超出时依次降级为只有名称、再截断），附加到系统提示 | `crates/miniq-skills/src/prompt.rs:6,13-45`；`turn.rs:81-89,375-376` |
| 读取 | 模型调用 `skill_read` 获取全文和 `skillDir`；已禁用的技能会被拒绝 | `crates/miniq-tools/src/skill.rs:25-73` |
| 依赖 | 只检测 `requires.bins` 在 PATH 中是否存在，缺失不阻止使用 | `store.rs`（`dependencies`/`command_available`） |
| 学习 | `skill.distill` 从会话提炼技能，`skill.refine` 做增量改进，并扫描敏感信息 | `crates/miniq-skills/src/learn.rs:30-105` |
| 导入 | `import_directory` 导入到用户目录，不跟随符号链接 | `store.rs:222` |
| 删除 | 只能删除用户技能 | `store.rs:280` |
| 插件提供的技能 | `plugin.install` 成功后，如果 `info.skills` 非空，会把 `<path>/skills`（或整个 path）**复制**到用户技能目录 | `crates/miniq-daemon/src/gateway/plugin.rs:26-53` |
| 插件技能的生命周期 | `plugin.uninstall` 和 `plugin.setEnabled` **不会**同步技能库，禁用或卸载插件后技能仍然存在。导入发生在插件安装之后，导入失败时插件不会回滚 | `gateway/plugin.rs:26-72` |
| 插件激活时的技能处理 | 只校验 `SKILL.md`，不注册工具，也不写入 SkillStore | `manager.rs:589-600` |

---

## 5. 前端 UI

### 5.1 桌面端（Tauri + React）

| 页面 | 组件 | 功能 |
|---|---|---|
| 插件 | `src/components/Plugins.tsx:8`（253 行） | 列表；从本地目录安装（Tauri 目录选择器，非 Tauri 时用 `window.prompt`，SSH 下用远程路径对话框）（32-41 行）；启用开关（180-189 行）；受信代码使用原生 `window.confirm`（60-65 行）；更新时重新选择目录（84-110 行）；重载（116 行）；卸载（128-132 行）；订阅 `plugins_changed`（20-22 行） |
| 插件卡片字段 | 同上 177-216 行 | 显示 name、id、version、runtime、status、entry、capabilities、permissions、skills、dependencies、error；只在 Node 插件失败时显示 processState。**不显示** `tools`、`description`、`author`、`engineNode`（`src/types.ts:312-331`） |
| MCP | `src/components/Mcp.tsx:220`（241 行） | 名称、命令、参数；状态和工具名列表；只支持 stdio（150 行） |
| 技能 | `src/components/Skills.tsx:121`（233 行） | 列表、开关、只读详情、删除用户技能、导入目录 |
| 提炼 | `src/components/Distill.tsx:95` | 提炼、编辑草稿、敏感内容警告、更新同名技能；文案为英文 |
| 入口 | `src/components/Sidebar.tsx:69-71,206-218`（AppShell 中的具体行号未复核） | 首页卡片和搜索里只有技能与 MCP，没有插件入口 |
| 斜杠命令 | `src/composerCommands.ts:166-190`；`src/hooks/useSlashSkills.ts:40-51` | `/skills`、`/mcp`、`/plugins` 用于跳转页面；`skill:<name>` 用于调用技能 |
| 未使用的 RPC | — | 前端没有调用 `plugin.getDiagnostics` |
| 设置页 | `src/components/Settings.tsx` | 其中没有插件、MCP、技能相关项 |

### 5.2 移动端

- **目录：** 没有独立的 `apps/mobile`。Capacitor 的 android、ios 工程都在 `apps/desktop` 下，共用 `src`。
- **直连聊天模式：** 入口为 `src/components/MobileEntry.tsx`（具体行号未复核）。`MobileChat` 和 `useMobileChat.ts` 中未发现插件、技能、MCP。
- **远程模式：**
  - 复用 Sidebar 中的技能、MCP、插件入口（`src/components/Sidebar.tsx:206-218`；“更多功能”折叠的行号未复核）。
  - 安装时回退为用 `window.prompt` 输入 daemon 端的绝对路径（`Plugins.tsx:41`、`Skills.tsx:181`）。

---

## 6. 分发

| 项 | 现状 | 证据 |
|---|---|---|
| 市场、目录、远程索引 | 未发现 | 协议和前端中都没有 URL 或索引安装（`crates/miniq-protocol/src/plugin.rs:78-83`；前端 grep marketplace、registry 只命中 SSH 主机列表） |
| 安装包格式 | 目录；没有 zip、tgz、`.miniqplugin` 之类的包格式 | `manager.rs:168-261` |
| 更新检查或自动更新 | 未发现，只能手动选择新目录做更新 | `src/components/Plugins.tsx:84-110` |
| 版本兼容 | 只接受 `api_version == 1.0.0`；Node 插件检查 `engine.node` 范围 | `manifest.rs:109-113` |
| 内置插件 | 未发现随包预装的插件。仓库示例只有 `examples/node-plugins/text-utils`（`dev.miniq.text-utils`，Node，`permissions=[]`，`enabled=false`） | `examples/node-plugins/text-utils/manifest.toml:1-14` |
| 内置技能 | 10 个，编译进二进制 | `crates/miniq-skills/src/lib.rs:27` |
| CLI | 没有 plugin、skill、mcp 子命令。现有子命令：exec、resume、sessions、history、watch、cancel、configure、models、doctor、status、logout、rpc、bridge、completions、update。只能用 `miniq rpc` 手动调用 RPC | `crates/miniq-cli/src/args.rs:47-110`（`Rpc` 在 95-96 行） |

---

## 7. 文档一致性

| 文档 | 文档说法 | 代码事实 | 结论 |
|---|---|---|---|
| `docs/node-plugins.md:83` | 信任绑定 “ID, version, entry path, entry file SHA-256, permissions, **capabilities**, and Node engine” | 指纹中**不含** capabilities（`manager.rs:811-818`） | 不一致 |
| `docs/node-plugins.md:79` | 让用户 “Open Settings” 查看并确认 | 插件管理在独立页面，`Settings.tsx` 中没有插件项 | 不一致 |
| `docs/node-plugins.md:38` | 权限只作审查输入，不授予宿主 API | 代码中权限不映射到 flag，只参与指纹 | 一致 |
| `docs/node-plugins.md:85` | 进程异常退出、输出畸形或帧超限时，会取消调用、注销工具并报告失败状态 | 帧超限有测试 `rejects_oversized_frame_before_newline`（`node.rs:739`）；其余分支没有单独测试 | 部分可证 |
| `docs/node-plugins.md` / 协议 | 协议定义了 `tools.unregister`、`log`、`pong` | `node.rs` 只处理 Hello、ToolsRegister、Activated、Error（211-275 行）和 ToolResult（408 行）；**未发现**处理 `tools.unregister` 或 `log` 的代码 | 协议有定义但 daemon 端未处理 |
| `docs/wasm-plugins.md:10` | “does not expose WASI …” | 实际通过 `wasmtime_wasi::add_to_linker_async` 链接了 WASI（`host.rs:239`），只是 ctx 为空（248 行） | 措辞不准确 |
| `docs/wasm-plugins.md:30` | 插件工具走相同的风险、审批和 hook 管线 | WASM 风险固定为 Low，**永不审批**（`host.rs:375-377`）；hooks 只处理内置工具（`executor/hooks.rs`） | 有误导性 |
| `docs/wasm-plugins.md:34` | 限制数值 | 与 `error.rs:116-133` 一致 | 一致 |
| `docs/skill-pack-format.md:17` | frontmatter “必须有 … `version`” | `version` 可省略，默认为 1（`parse.rs:33-35,43-44`） | 不一致 |
| `docs/skill-pack-format.md:19` | `allowed_tools` 应只列出实际存在的工具 | 该字段没有执行逻辑（`parse.rs:49-51`，其他地方无引用） | 文档暗示有约束效果，实际不生效 |
| `docs/skill-pack-format.md:22` | 插件页更新时原子替换 | `update_from_directory` 确实原子替换，但技能副本是另外 import 到用户目录的（`gateway/plugin.rs:40-51`） | 部分一致 |
| `develop-miniq-plugin/SKILL.md:52` | 列出的权限枚举 | 与 `manifest.rs:19-26` 一致 | 一致 |
| `develop-miniq-plugin/SKILL.md` | 技能位置 | 位于 `crates/miniq-skills/assets/develop-miniq-plugin/SKILL.md`（内置技能，150 行）；仓库根目录没有 `.miniq/skills` | — |

---

## 8. 与 Codex 捆绑插件对应的 miniQ 内置能力

miniQ 把这些能力做成 **内置工具**，而不是插件。它们在 `crates/miniq-tools/src/lib.rs:98-156` 由 `default_router` 注册，注册方式是 `register_builtin`（`router.rs:330`）。

| 能力 | miniQ 内置实现 | 证据 |
|---|---|---|
| 浏览器自动化 | `browser_automation`，操作内嵌 webview；未发现 CDP 或接管用户 Chrome 的代码 | `crates/miniq-tools/src/browser.rs:206,262`；`lib.rs:137` |
| Computer use | `computer_use`，仅限 desktop feature | `crates/miniq-tools/src/computer.rs:214`；`lib.rs:138-139`；权限 RPC 在 `gateway.rs:82-83` |
| 原生 App 自动化 | `app_automation`，仅限 desktop feature | `crates/miniq-tools/src/app.rs:273`；`lib.rs:140-141` |
| 文档、表格、PDF、Notebook | `DocReadTool`、`DocWriteTool`、`ViewPdfTool`、`NotebookEditTool`，另有 document、pdf、spreadsheet、presentation 等 workflow 技能 | `lib.rs:103,116-117,123`；`crates/miniq-skills/src/lib.rs:27` |
| 图像、视频、语音、音乐 | `GenerateImage`、`EditImage`、`GenerateVideo`、`SynthesizeSpeech`、`TranscribeAudio`、`GenerateMusic` | `lib.rs:142-147` |
| 网页搜索与抓取 | `WebSearchTool`、`WebFetchTool`、`HttpRequestTool`；搜索提供方在 `web_search/providers.rs` | `lib.rs:113-114,120` |
| Git | 只有 `GitStatusTool` 和 `GitDiffTool`（只读） | `lib.rs:111-112` |
| 子代理 | `AgentRunTool`、`AgentMessageTool` | `lib.rs:124-125` |
| 任务和计划 | `PlanMode`、`TaskCreate`、`TaskGet`、`TaskList`、`TaskItemUpdate`、`TaskUpdate` | `lib.rs:118,126-130` |
| 定时自动化 | `schedule.*` RPC 共 7 个；工具侧有 `ScheduledTaskMemoryWriteTool` | `gateway.rs:92-98`；`lib.rs:135` |
| 记忆 | `MemorySearchTool`、`MemoryWriteTool`；RPC 有 `memory.list` 和 `memory.delete` | `lib.rs:133-134`；`gateway.rs:89-90` |
| 外部会话导入 | `miniq-session-connectors` 支持 claude、codex、opencode 会话的发现和解析；RPC 为 `externalSession.*` | `crates/miniq-session-connectors/src/lib.rs:1`；`gateway.rs:147-149` |
| SaaS 连接器（Gmail、日历、Slack、GitHub、Drive 等） | **未发现**。在 crates 和前端 grep gmail、calendar、slack 都没有命中；`session-connectors` 只负责导入会话，不是 SaaS 连接器 | — |
| 工具检索 | `tool_search`（`select:`、分页） | `crates/miniq-tools/src/catalog.rs`；`lib.rs:156` |

---

## 9. 缺陷、TODO 与测试

### 9.1 TODO / FIXME

在 `crates/miniq-plugins`、`crates/miniq-skills`、`daemon/src/mcp.rs`、`gateway/{plugin,mcp,skill}.rs`、`tools/src/mcp.rs`、`packages/*/src` 中检索 `TODO`、`FIXME`、`unimplemented!`、`todo!`，**零命中**。

### 9.2 基于代码的缺陷或风险

| # | 问题 | 证据 |
|---|---|---|
| 1 | WASM 插件工具固定为 Low，执行前不经用户审批 | `host.rs:375-377` |
| 2 | Node 信任指纹只覆盖 entry 单个文件，其他模块和 `node_modules` 变化后仍然受信 | `manager.rs:809,823` |
| 3 | Node 插件的 `permissions` 声明不影响运行时；网络和子进程没有被代码层 flag 限制 | `node.rs:124-128` |
| 4 | 插件技能在卸载或禁用插件后仍残留在用户技能目录；技能导入失败时插件不回滚 | `gateway/plugin.rs:40-72` |
| 5 | 技能的 `allowed_tools` 不生效 | `parse.rs:49-51` |
| 6 | Node 宿主的 `tools.unregister` 和 `log` 通知在 daemon 端没有处理代码 | `node.rs:211-275,408` |
| 7 | MCP 子进程继承 daemon 全部环境变量，stderr 被丢弃，排障信息不足 | `mcp.rs:98-105` |
| 8 | MCP 工具列表不告知模型，模型需要猜测 server 名和 tool 名 | `tools/src/mcp.rs:37-40`；`turn.rs:550` |
| 9 | `plugin.getDiagnostics` 在前端没有使用；插件的 tools、description、author 没有展示 | `src/components/Plugins.tsx`；`src/types.ts:318-328` |

### 9.3 测试清单

| 位置 | 测试 |
|---|---|
| `crates/miniq-plugins/src/manifest.rs:224-310` | 共 5 个：manifest 契约、semver、Node 契约、技能包契约、Node 默认禁用 |
| `crates/miniq-plugins/src/manager.rs:897-1164` | 共 11 个：发现、内部目录、id 与目录不一致、重扫、安装卸载、技能包安装更新、Node 不能自授权、信任随输入变化、信任存储、entry 越界、符号链接逃逸 |
| `crates/miniq-plugins/src/host.rs:435-446` | 共 2 个：畸形字节、缺少 guest 导出。**没有**成功执行 WASM 工具的端到端测试 |
| `crates/miniq-plugins/src/node.rs:734,739` | 共 2 个：Medium 风险、超大帧 |
| `crates/miniq-plugins/tests/` | 目录不存在 |
| `crates/miniq-daemon/tests/rpc_integration.rs:88` | `plugin_list_is_available_without_installed_plugins`，是唯一的插件 RPC 集成测试 |
| `crates/miniq-daemon/tests/skill_integration.rs:85,144,181,221` | 技能 RPC、导入、提示注入、禁用后移出 |
| `crates/miniq-daemon/tests/m4_skill_learning.rs` | 3 个 distill/refine 相关测试 |
| `crates/miniq-daemon/tests/m6_mcp.rs:70,157` | MCP 配置、列出、调用；未知 server |
| `packages/node-plugin-host/test/host.test.mjs`、`packages/plugin-sdk/test/sdk.test.mjs` | 各 2 个 |
| 前端 | `Plugins.tsx`、`Mcp.tsx`、`Skills.tsx`、`Distill.tsx` **都没有测试**；只有斜杠命令和侧栏测试间接涉及（`src/components/ComposerSlash.test.tsx`、`src/composerCommands.test.ts`）；没有 e2e |

---

## 10. 与主流插件体系相比的明显短板（仅基于事实）

1. **没有分发渠道：** 没有市场、远程索引、URL 或包文件安装，也没有更新检查（`plugin.rs(protocol):78-83`；第 6 节）。
2. **没有签名和来源校验：** 只有本地的 Node 信任指纹，而且只覆盖 entry 单个文件（`manager.rs:808-825`）。
3. **扩展面窄：** 插件只能提供 tool 和 skills；不能提供 slash 命令、UI、设置 schema、hooks、MCP 服务器，也不能调用宿主 API（`manifest.rs:12-15`；`plugin.wit:3-13`）。
4. **权限模型基本是声明性的：**
   - WASM 只允许 `log`，其余权限值在 WASM 和 Node 两种运行时里都不会转换成实际授权。
   - Node 没有网络或子进程的代码级限制（`manifest.rs:136-141`；`node.rs:124-128`）。
5. **WASM 工具不审批**（`host.rs:375-377`），这与文档所说“同一审批管线”的说法有出入。
6. **MCP 功能不完整：**
   - 只有 stdio，协议版本为 2024-11-05。
   - 没有 HTTP、SSE、OAuth、env，没有 resources 和 prompts。
   - 工具不会以独立工具的形式暴露，也不会告知模型（`mcp.rs:15-30,159-182`；`tools/src/mcp.rs:34-50`）。
7. **插件与技能的生命周期脱节：** 卸载或禁用插件不会清理对应技能（`gateway/plugin.rs:26-72`）。
8. **技能的 `allowed_tools` 不生效**（`parse.rs:49-51`）。
9. **没有 SaaS 连接器**（Gmail、日历、Slack、GitHub、Drive 均未发现），也没有 CLI 插件管理子命令（`args.rs:47-110`）。
10. **测试薄弱：**
    - 没有 WASM 工具成功执行的测试。
    - 插件 RPC 只有一个 list 测试。
    - 前端插件、MCP、技能面板没有测试（第 9.3 节）。
11. **文档与代码有出入：**
    - 信任指纹是否包含 capabilities。
    - WASI 是否暴露。
    - 技能 `version` 是否必填。
    - 插件入口是否在“Settings”里（第 7 节）。
