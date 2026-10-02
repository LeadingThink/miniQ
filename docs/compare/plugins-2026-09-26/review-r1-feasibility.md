# 评审 R1：代码可行性与架构正确性

> 评审对象：`04-plan-draft-v1.md`（v1，581 行）。背景：`01-miniq-plugin-inventory.md`。
> 视角：逐条对照真实代码，检查现状描述、集成点、遗漏项、工期依赖和选型风险。只读代码，未改方案。
> 标注说明：**已核实**表示有 path:line 证据；**未核实**表示时间不够没查到的点，需要实施前补查。
> 行号以评审时的工作区为准（版本 0.1.56）。

---

## 一、阻断（不改则方案无法按描述落地）

### B1. 回合内工具列表是固定的，"延迟加载 + tool_search 后调用"和"安装后同回合继续"都不成立
- **原文位置**：§4.4 延迟加载；§5.2 `request_plugin_install`"安装并在同一回合继续"；§7.4 认证卡"完成后自动继续该工具调用"；M2、M3 验收。
- **问题**：`run_turn_inner` 在循环开始前只取一次 `executor.specs()`，之后每次请求模型都复用同一个列表。tool_search 找到的工具、回合中新注册的插件或 MCP 工具，在本回合的 tools 参数里都不会出现，所以模型拿不到它们的 schema，无法按一等工具调用。
- **证据**：
  - `crates/miniq-agent/src/lib.rs:332`：`let tools = executor.specs();`
  - 同文件 358、388（`tools: tools.clone()`）、410、505 行复用这份列表。
  - `crates/miniq-daemon/src/executor.rs:318-319`：`specs()` 直接返回 `router.specs()`，也就是全量工具。
  - 仓库里没有任何 deferred、visible 或 core_tools 概念（grep 无命中）。
- **建议**：
  1. 在 M0 增加"工具可见性层"工作项：`ToolExecutor` 新增按回合和会话计算的 `visible_specs(turn_state)`，每次循环迭代重新计算。
  2. tool_search 命中后，把工具加入本回合的可见集。
  3. 所有全量使用点统一改走可见性层：`gateway/system.rs:50`、`executor/adaptation.rs:5-11`（unknown_tool 输出列出全部 specs）、`image_history_tool.rs:78,224`。
  4. 修改后要评估 provider 的 prompt cache 命中率（tools 变化会让缓存失效），这一点需要实测。

### B2. `mcp__<server>__<tool>` 这个名字已被 native 适配层占用，会被改写成 `mcp_call`
- **原文位置**：§4.4 "每个 MCP 工具注册为 `mcp__<server>__<tool>`"，"保留 `mcp_call` 一个版本作为兼容"。
- **问题**：现在模型输出的 `mcp__server__tool` 会被 native 适配层解析并改写成 `mcp_call` 调用。如果直接按这个名字注册一等工具，要么被适配层提前拦截，永远到不了新注册的工具；要么两条路径并存，审批模式（pattern）和审计记录都会分叉。
- **证据**：
  - `crates/miniq-daemon/src/native.rs:85,124`
  - `crates/miniq-daemon/src/native/structured.rs:129-139`（`parse_mcp_name` / `adapt_mcp`）
  - `crates/miniq-daemon/src/native/names.rs:28`
  - 调用点：`executor.rs:337/363/374`、`plan_review.rs:258`
- **建议**：
  1. 方案里补一个工作项："先查 router 注册，未命中再回落到 `mcp_call` 适配"。
  2. 修改 `resolve_registered_call`（`executor.rs:58`）的顺序，并补 native 测试（`native/tests.rs`）。
  3. 明确兼容期内审批 pattern 统一为 `mcp:<server>:<tool>`，避免"本会话允许"在两条路径之间失效。

### B3. 新目录布局与现有插件扫描器冲突
- **原文位置**：§2.3，在 `<data_dir>/plugins/` 下新增 `config.toml`、`marketplaces/`、`cache/`、`data/`、`state.json`。
- **问题**：现有 `PluginManager` 的根目录就是 `<data_dir>/plugins`。`scan_and_load` 把每个子目录都当作一个插件目录加载，只排除 node host、`.install-*` 和 `.backup-*`。新布局落地后，`marketplaces`、`cache`、`data` 都会被当成插件加载，报 InvalidEntry 或误加载。同一目录里还有 `.trusted-node.json` 信任存储。
- **证据**：
  - `crates/miniq-daemon/src/state.rs:172`：`data_dir.join("plugins")`
  - `crates/miniq-plugins/src/manager.rs:294-324`：scan 过滤逻辑
  - `manager.rs:18`：`TRUST_STORE_FILE = ".trusted-node.json"`
- **建议**：新体系改用独立根目录（例如 `<data_dir>/plugins2/` 或 `<data_dir>/ext/`），旧目录只读兼容，再由迁移器搬迁；或者在 M1 第一步就改造 scanner。无论哪种，都要在方案中写明迁移顺序和回滚方式。

### B4. 远程（手机）RPC 用的是黑名单，新增的高危方法默认对远端开放
- **原文位置**：§2.1 新增 `plugin.* / marketplace.* / mcp.* / hooks.* / connector.*`；§7.5 移动端"本地路径安装……只读 + 在桌面端完成"；§5.4 hooks 信任"允许在移动端完成但需二次确认"。
- **问题**：`remote_method_allowed` 只禁止固定列表（`settings.update`、`mcp.update`、`skill.delete`、`host.save` 等），其余方法一律放行。方案新增的 `plugin.install`（本地路径或 Git）、`marketplace.add`、`mcp.add`（任意命令行）、`hooks.trust` 等方法，如果不同步加入，手机或中继一端就能直接让 daemon 执行任意命令。§7.5 的"只读提示"只是前端限制，拦不住。
- **证据**：
  - `crates/miniq-daemon/src/remote.rs:268`：`!matches!(...)` 黑名单
  - `remote.rs:287`：`remote_request_allowed`
  - `remote/connection.rs:208`：调用点
  - `remote.rs:453-462`：测试
- **建议**：
  1. M0 就把远程策略改为**白名单**，或者按方法声明 `remote: deny|confirm|allow` 属性。
  2. 新 RPC 默认 deny；hooks.trust、mcp 新增或修改、插件安装这几类定为 deny，或要求桌面端确认。
  3. 补测试，确保新方法不会被默认放行。

### B5. 全局单例 ToolRouter 无法表达"项目级 / 受信任工作区"启用
- **原文位置**：§2.3 项目级 `.miniq/plugins.toml`；§3.4 有效集包含"（受信任工作区）项目启用插件"；§6.2 禁用系统插件后移除工具。
- **问题**：router 是进程级单例，注册表是一张全局 `BTreeMap`。同名注册直接返回 `AlreadyRegistered`，也没有会话或工作区维度。工作区 A 启用的插件工具，会对所有会话可见；两个工作区启用同一插件的不同版本时会冲突。
- **证据**：
  - `crates/miniq-daemon/src/state.rs:170`：`Arc::new(miniq_tools::default_router())`
  - `crates/miniq-tools/src/router.rs:277-280`：`RwLock<BTreeMap>`
  - `router.rs:349-370`：重名报错
- **建议**：与 B1 合并设计。router 只负责"注册"（全量、带 origin 和 scope 标签），"可见和可调用"由会话级有效集过滤；`resolve_registered_call` 也要校验可见性，防止模型绕过过滤直接调用。

---

## 二、重要（影响正确性、安全或工期）

### I1. 审批模型扩展被低估
- **原文位置**：§4.5，"FullAccess 下也提示一次/会话"，"总是允许此工具"写回配置，优先级链。
- **问题**：
  - 现有决策只有 `Approve / ApproveForSession / Reject` 三种，状态只有 `Pending / Approved / ApprovedForSession / Rejected`。
  - FullAccess 在预批准逻辑里直接放行，另有 4 处以上直接判断 FullAccess。
  - 方案需要的"持久化总是允许"和"FullAccess 下仍需询问"都要新增枚举值、协议 schema、前端卡片和撤销入口。
- **证据**：
  - `state.rs:64-68`：`ApprovalDecision`
  - `crates/miniq-protocol/src/types.rs:368`：`ApprovalStatus`
  - `crates/miniq-protocol/src/session_approval.rs`：`ApprovalMode`
  - `executor.rs:531-549`：pre_approved
  - 其他 FullAccess 判断：`turn.rs:392`、`executor/interaction.rs:71`、`agent_tasks.rs:218,318,470`
  - `executor.rs:81-101`：`approval_pattern`
- **建议**：
  1. 新增 `ApprovalDecision::AlwaysAllowTool` 与 `Risk::requires_prompt_even_in_full_access`（或 `force_ask`）。
  2. 列出所有 FullAccess 判断点并统一收口到一个函数。
  3. 这部分放进 M2 的独立子任务，预估 1 周。

### I2. WASM 修复只改 `evaluate_risk` 不够
- **原文位置**：§8 "WASM 免审批 → 风险默认 Medium"（M0）。
- **问题**：
  - 现状描述正确：`host.rs:374-379` 固定返回 Low。
  - 但 Auto 模式下 Medium 是否会弹卡，取决于 `executor.rs:531-549` 的分级规则（这部分细节**未核实**）。
  - "按工具声明的 readOnly 降为 Low"需要 manifest 新字段，而旧 manifest 使用了 `deny_unknown_fields`。
- **证据**：`crates/miniq-plugins/src/host.rs:360-390`
- **建议**：M0 验收标准应写成"Auto 模式下 WASM 调用出现审批卡"，并确认 Auto 模式对 Medium 的处理；readOnly 声明放进新格式 `extensions."dev.miniq"`，不要改动旧 manifest。

### I3. settings 解析失败会静默回落到默认值，迁移有丢配置风险
- **原文位置**：§2.3 `mcp/servers.toml`"替代现有配置，自动迁移"；§10 回归测试。
- **问题**：现有 MCP 配置存在 `settings.json` 的 `DaemonSettings.mcp_servers` 字段里，解析失败时静默返回 default。迁移器一旦写坏字段，或新旧版本来回切换，用户的 MCP、provider 和审批配置都可能被清空。
- **证据**：
  - `state.rs:23-38`：字段定义
  - `state.rs:49-54`：静默 default
  - `crates/miniq-daemon/src/main.rs:67`：`settings.json`
- **建议**：
  1. 迁移前备份为 `settings.json.bak-<ver>`。
  2. 解析失败时改为报错，并在 UI 提示，不再静默回落。
  3. 迁移完成后在旧字段保留只读副本一个版本，保证降级可用。
  4. 方案"回归"一节写明降级路径。

### I4. mcp.rs 的改造量不是"替换客户端"这么简单
- **原文位置**：§4.1 "整体替换"；§4.3。
- **问题**：
  - 现状描述基本准确：仅支持 stdio，协议版本 2024-11-05，配置只有 name/command/args/enabled，读响应时跳过通知。
  - 但 `ManagerBridge::call` 是 `mcp_call` 工具的唯一入口，`AppState.mcp` 和 `mcp_bridge()` 也被多处引用。替换时要同步改 ToolContext 注入、gateway/mcp 的 RPC 与前端 `Mcp.tsx`。
  - "子进程继承全部环境变量"与代码一致（配置中没有 env 字段），但 `connect` 的实现没有逐行核实。
- **证据**：
  - `crates/miniq-daemon/src/mcp.rs:15`（协议版本）、`19-26`（配置）、`46-70`（跳过通知）、`97`（connect）、`200`（Bridge）
  - `state.rs:127,225-231`
  - `crates/miniq-tools/src/mcp.rs:52`（恒为 High）
- **建议**：在 M2 列出接口迁移清单：McpManager 到 McpHub 的适配层、RPC 兼容、前端页面、`mcp_call` 兼容期的风险等级（注解缺失时维持 High，不要降到 Medium）。

### I5. 事件命名与远程可见性
- **原文位置**：§3.4 事件 `plugin.contributionsChanged`；§4.3 MCP 状态推送。
- **问题**：
  - 协议 `Event` 使用 `tag="type"` 加 snake_case 命名，已有 `PluginsChanged`。方案的点分驼峰命名与此不符。
  - 远程订阅只放行 `sidebar_event` 白名单中的全局事件（其中已包含 `plugins_changed`）。新增的 MCP 状态、贡献变更事件如果不加入白名单，手机端收不到。
- **证据**：
  - `crates/miniq-protocol/src/event.rs`（`PluginsChanged`）
  - `crates/miniq-daemon/src/event_journal.rs:101`
  - `crates/miniq-daemon/src/remote/subscriptions.rs:106`
- **建议**：新事件命名为 `plugin_contributions_changed` 和 `mcp_server_status_changed`，同步加入 `sidebar_event`，并执行 `gen-schemas` 与 serde roundtrip 测试。

### I6. 每个新 RPC 都有固定的手工接线成本，方案未计入
- **原文位置**：§2.1、§3.5、§9 各里程碑。
- **问题**：gateway 用一个大型字符串 match 手工分发方法。每新增一个方法都要改 match、子模块、protocol 类型、`schemas/protocol.schema.json`、前端 `types.ts` 和 `rpc.ts`，还要改远程策略（B4）。方案新增约 30 个以上方法，这部分工作量没有体现。
- **证据**：`crates/miniq-daemon/src/gateway.rs:62,75`，子模块在 9-35 行。
- **建议**：M0 先做一个"方法注册表"（方法名 → handler + remote 策略 + schema），后续各里程碑按表增量添加；或者在每个里程碑里显式列出接线工作项。

### I7. 插件技能层与 prompt 注入点
- **原文位置**：§3.4 技能从缓存加载，命名 `plugin:skill`；§5.1 插件能力块；§5.3。
- **问题**：
  - 注入点可以落地：`turn.rs:375-376` 每回合执行 `discover` 并生成 `available_skills_block`，`system_message` 在 `turn.rs:81-89` 拼接。
  - 但 `SkillStore::discover` 只有 bundled、user、workspace 三层（`store.rs:117-142`），需要新增 plugin 层和 `SkillSource::Plugin`。
  - 当前的预算是固定字符数（`prompt.rs:13-17`，`DEFAULT_BUDGET_CHARS`），而方案要求"上下文窗口 2%"，需要把模型窗口信息传到这里。
  - 冒号命名空间与现有技能名校验是否兼容，**未核实**。
- **建议**：M3 列出 `discover` 签名变更（传入有效贡献集）、预算函数改为接收窗口参数，并验证冒号命名的解析与斜杠菜单兼容性。

### I8. 工期与依赖不合理
- **原文位置**：§9。
- **问题**：
  - M2 的 4 周同时包含 rmcp 替换、HTTP、完整 OAuth（发现、CIMD、DCR、PKCE、刷新）、钥匙串、一等注册与延迟加载、注解审批、按工具策略、resources/prompts/elicitation、日志、导入器，明显超载。
  - B1、B2、B5（可见性层、router 语义）是 M1（插件原生工具加前缀）和 M2（MCP 一等工具）的共同前置，却没有放进 M0。
  - M1 和 M2 并行时，两名后端工程师会同时修改 router、executor 和审批路径，冲突风险高。
- **建议**：
  1. M0 延长到 2.5–3 周，纳入可见性层、名称解析顺序、远程白名单、RPC 注册表和 settings 迁移保护。
  2. M2 拆为 M2a（rmcp、HTTP、一等工具、审批）和 M2b（OAuth、钥匙串、resources/prompts/elicitation、导入）。
  3. 总工期按 20–22 周估算。

---

## 三、建议（选型与细节）

### S1. 依赖选型：rmcp / gix / keyring
- **现状**：workspace 依赖中三者都没有。已有 reqwest 0.12（rustls-tls）、wasmtime 31、rusqlite 0.33（bundled）、windows-sys 0.61。
- **Android/iOS**：移动端是 `apps/desktop` 通过 Capacitor 构建，经 relay 远程连接 daemon（`apps/desktop/src/remoteAccess.ts`），daemon 不在移动端运行。因此 keyring、gix 对 Android 的兼容性不是约束，前提是它们不进入 src-tauri 的移动端构建。src-tauri 的 target 与依赖**未核实**，需要确认 Tauri 移动构建是否会链接 daemon crate。
- **风险（均未核实，需在 M0 做一次 spike）**：
  1. rmcp 的 reqwest、tokio 版本和 TLS feature 能否与现有 reqwest 0.12 + rustls 统一，避免同时引入 native-tls 或 openssl，以及两份 reqwest。
  2. gix 的编译体积和时间较大，需要只启用浅克隆和 HTTPS（rustls）feature，并确认 Windows 与 musl 目标能构建。官方源已经走 https-archive，可以考虑 M1 只做 https-archive 和 local，把 Git 源推迟。
  3. keyring 在 Linux 无桌面环境需要 dbus/secret-service，headless 服务器上正是"只装 CLI + 手机远程"场景。方案里的"0600 加密文件回退"需要明确密钥从哪里来，否则只是混淆，并没有加密效果。
- **建议**：M0 增加 1 周依赖 spike：`cargo tree -d` 检查重复依赖，并在 CI 中覆盖三大平台 + musl。

### S2. 数据目录描述不完整
- **原文位置**：§2.3。
- **现状**：`data_dir()` 的优先级是 MINIQ_DATA_DIR → LOCALAPPDATA → `$HOME/.local/share`（`crates/miniq-local/src/lib.rs:33-42`）。macOS 上确实是 `~/.local/share/miniq`，与方案一致；Windows 上是 `%LOCALAPPDATA%\miniq`，方案没有写。
- **建议**：补上 Windows 路径；新配置写入沿用 `write_private_json` 同类的原子写（`miniq-local/src/lib.rs:53-61`），TOML 文件也同样处理。

### S3. `plugin__tool` 命名与现有名称归一化可能冲突
- **原文位置**：§3.4。
- **现状**：`resolve_registered_name` 会把 `.` 替换为 `_` 做模糊匹配，多个匹配时返回 None（`router.rs:412-421`）。
- **建议**：明确前缀字符集和长度上限（部分 provider 要求工具名不超过 64 字符，只允许 `[a-zA-Z0-9_-]`），并统一 MCP 与插件的截断哈希规则。

### S4. Hooks 集成点
- **原文位置**：§5.4。
- **现状**：执行流程先把工具调用以 Pending 持久化，再发送 audit 和 `ToolCallStarted/Finished`（`executor.rs:413-440`）；内部 hooks 在 `executor/hooks.rs`（106 行）。
- **问题**：PreToolUse、PermissionRequest 的精确插入点（审批前还是审批后、plan-mode 阻断 `executor.rs:497` 之前还是之后）以及被阻断时的持久化状态，**未核实**。
- **建议**：方案写明时序：PreToolUse 在风险评估之后、审批之前执行；deny 时写为 Rejected 并附带原因。补一张时序图。

### S5. CLI"daemon 未运行时直接调用库"
- **原文位置**：§3.5。
- **现状**：`crates/miniq-cli/src` 中有 `client.rs` 和 `launcher.rs`，推测已有自动拉起逻辑（**未核实**）。daemon 持有 `daemon.lock`（fs2）。
- **建议**：CLI 直接读写插件目录时，要么获取同一把锁，要么只允许只读操作，避免与运行中的 daemon 并发写 `state.json`。

### S6. 其他
- 前端没有 i18n 框架（grep 无命中）。§3.1 的 `displayName` 多语言、官方插件的中英文描述需要先定策略。
- `@` 文件提及是否已存在（§7.3"已有文件提及则并入"）**未核实**；现有 slash 相关实现在 `composerSlash.ts` 和 `hooks/useComposerSlash.tsx`。
- §1.2 "模型看不到 MCP 工具列表"：是否有 list 类辅助工具**未核实**，建议核对后再写。
- §7.6 "前端启用现有未用的 `plugin.getDiagnostics`"：RPC 是否存在**未核实**。

---

## 四、现状描述核对小结

| 方案表述 | 结论 |
|---|---|
| WASM 恒为 Low（host.rs:375-377） | 准确（host.rs:374-379） |
| MCP 仅 stdio，协议 2024-11-05，配置只有 name/command/args/enabled | 准确（mcp.rs:15,19-26） |
| 单一 `mcp_call`，High 风险 | 准确（tools/mcp.rs:52），但遗漏了 native 名称适配（B2） |
| 数据目录 `~/.local/share/miniq` | macOS/Linux 准确，Windows 未写（S2） |
| "tool_search 可直接扩展" | 部分成立：catalog 可扩展（router.rs:387-402），但调用依赖 B1 |
| 内部 hooks 仅 after_success | 与文件规模一致，细节未核实 |

---

## 必须修改清单（进入 v2 前）

1. **B1**：M0 新增"按回合重算的工具可见性层"，修改 `miniq-agent/src/lib.rs:332` 的固定 specs，并纳入所有全量 specs 使用点。
2. **B2**：明确 `mcp__*` 名称的解析顺序（router 优先，未命中再回落 `mcp_call`），统一审批 pattern。
3. **B3**：新插件体系改用独立根目录或先改造 scanner，写明迁移和回滚步骤。
4. **B4**：远程 RPC 从黑名单改为白名单或按方法声明策略，新方法默认拒绝，在 M0 完成。
5. **B5**：router 增加 scope/origin 标签，由会话级有效集过滤可见和可调用的工具，并在调用时校验。
6. **I1**：补齐审批枚举、协议和 UI 改动，统一 FullAccess 判断点，单列工期。
7. **I3**：settings 迁移加备份、失败报错、保留降级路径。
8. **I5/I6**：事件改为 snake_case 并加入 `sidebar_event`；计入 RPC 接线成本，或先做方法注册表。
9. **I8/S1**：M0 扩充到 2.5–3 周（含依赖 spike），M2 拆为 M2a/M2b，总工期重估为 20–22 周。
10. 所有标注"未核实"的点在 v2 定稿前补查并回填证据。
