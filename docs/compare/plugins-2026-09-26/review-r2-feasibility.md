# 插件方案 v2 第二轮工程可行性评审（R2）

- 评审对象：`docs/compare/plugins-2026-09-26/05-plan-v2.md`
- 对照：`review-r1-feasibility.md`、附录 B（代码锚点）、附录 C.1（R1 处置表）
- 方法：用 grep/sed 逐条抽查仓库代码（`crates/`、`apps/desktop/src`），只读，未改动任何现有文件
- 分级：**B = 阻断**（不改就无法按方案落地，或会引入安全回归）；**I = 重要**（会导致返工或延期）；**S = 建议**
- 覆盖范围说明：受评审步数所限，以下内容**未逐行核验**，见 S4：§15 人力表细节、R1 正文逐条原文、manager.rs/client.rs/miniq-local/hooks.rs/前端 Composer 的锚点。

---

## 一、锚点抽查汇总

| 附录 B 锚点 | 结果 | 证据 |
|---|---|---|
| gateway.rs:75（getDiagnostics :179） | ✅ | `match req.method` 在 gateway.rs:75，`plugin.getDiagnostics` 在 :179 |
| remote.rs:268-284 | ✅（数量有误） | `remote_method_allowed` 在 :268-284，黑名单实为 **11 项**，方案写 12 项 |
| state.rs:49-54 | ✅ | `load` 用 `.ok()…unwrap_or_default()` 静默回落 |
| state.rs:64-68「FullAccess 分支」 | ❌ | 此处是 daemon 侧 `enum ApprovalDecision { Approve, ApproveForSession, Reject }`（state.rs:62-68），不是 FullAccess 分支 |
| state.rs:170/172 | ✅ | Router 单例 `Arc::new(miniq_tools::default_router())` 在 :170，`data_dir.join("plugins")` 在 :172 |
| router.rs:277-370 | ✅ | `ToolRouter` 在 :277，register* 在 :309/313/330 |
| agent lib.rs:332 | ✅ | `let tools = executor.specs();` 在循环外只算一次 |
| executor.rs:531-549 | ✅ | pre_approved 逻辑在 :520-551 |
| turn.rs:392 / interaction.rs:71 / agent_tasks.rs:218,318,470 | ✅ | grep 结果一致 |
| host.rs:375 | ✅ | `WasmTool::evaluate_risk` 固定返回 Low（:375-380） |
| event.rs:240 PluginsChanged | ✅ | 在 :240，:280 映射的 session id 为 `""` |
| event_journal.rs:101 sidebar_event | ✅ | 用 `matches!` 匹配 type 字符串 |
| **漏列** gateway/session_approval.rs:73,81 | ❌ | 这两行也在匹配/写入 `ApprovalMode::FullAccess`，附录 B 与 §4.2 都没列 |
| **漏列** remote.rs:287-299 `remote_request_allowed` | ❌ | 对 `host.call` 的内层 method 做二次判定（:298），§4.1 没提 |
| **漏列** native/names.rs:28、native/structured.rs:130 | ❌ | 现有 `mcp__<server>__<tool>` 原生名适配逻辑，与 §3.3/§7.4 的命名直接冲突（见 B3） |

---

## 二、阻断（B）

### B1 §4.2 审批收口：改动点不全，CI 规则会误报，新枚举没有贯通
- **位置**：§4.2 `decide_approval`；§4.3 新增 `AlwaysAllowTool`/`ApprovedAlways`；附录 B state.rs:64-68。
- **问题**：
  1. 方案列出的 FullAccess 使用点漏了 `gateway/session_approval.rs:73,81`。
  2. 「CI 用 grep 禁止在别处匹配 `ApprovalMode::FullAccess`」会同时命中两类合法代码：session_approval.rs 的设置写入，以及 `miniq-protocol/src/session_approval.rs:10` 的枚举定义。按现在写法，这条 CI 规则上线当天就会失败。
  3. 新增的审批决策需要同时改 4 层，方案只写了协议层：
     - daemon 枚举 `state.rs:64`；
     - 字符串解析 `gateway/interaction.rs:36-38`（`"approve" | "approve_for_session" | "reject"`）；
     - 协议状态 `miniq-protocol/src/types.rs:368 ApprovalStatus`，其 `as_str` 也要同步；
     - 前端 `apps/desktop/src/components/TimelineInteractions.tsx`。
  4. 「永久允许」需要持久化。现有记忆只有会话级：`state.rs:471 allow_for_session`、`:490 is_allowed_for_session`。三档记忆的存储位置、schema、撤销 RPC（§13.1 的 `permission.revokeRule`）与这两个函数怎么对接，方案没有说明。
- **证据**：executor.rs:520-553；turn.rs:392；interaction.rs:71；agent_tasks.rs:218/318/470；session_approval.rs:73,81；state.rs:62-68,471,490；types.rs:368；interaction.rs:36-38。
- **改法**：
  - 把附录 B state.rs:64-68 改为「state.rs:62-68 ApprovalDecision 枚举」，并补上 session_approval.rs:73,81。
  - CI 规则改为「除 `decide_approval` 所在模块、protocol 定义、settings 写入路径外禁止匹配」，并用显式 allowlist 文件维护例外。
  - §4.3 增加一张「决策变体贯通表」：protocol → daemon 枚举 → interaction 解析 → ApprovalStatus → 前端，再加一段持久化规则存储设计（文件、schema_version、与 allow_for_session 的合并顺序）。

### B2 §4.1 远程白名单：host.call 嵌套判定缺失，plugin.install 等级冲突
- **位置**：§4.1 等级表；§13.1 RPC 表。
- **问题**：
  1. 现有远程判定分两层：方法名一层，`host.call` 内层 method 再一层（remote.rs:287-299，调用点在 remote/connection.rs:208，测试在 remote.rs:453-462、host_tests.rs:20-42）。方案只把外层改成白名单，没定义 host.call 内层按什么等级判定。这样远程端可能通过 `host.call` 绕开 HostOnly/OfficialOnly。
  2. `plugin.install` 在 §4.1 同时属于 OfficialOnly 和 HostOnly（非官方）。§13.1 又把旧的 `plugin.install`（本地路径）保留为兼容别名。一个方法名只能对应一个静态等级，按参数（source 类型）区分必须写成运行时判定，方案没写。
  3. 「CI 检测缺失声明」的前提是有方法注册表。现在 gateway.rs 是约 107 个手写 match 臂，没有注册表，所以必须等 §3.5 MethodRegistry（方案第 277 行，M0）完成迁移后才能生效。§15 没有体现这个先后依赖。
- **证据**：remote.rs:268-299；gateway.rs:61-190；方案第 277 行、§13.1。
- **改法**：
  - 等级表加一列「host.call 内层」，默认等级为 Deny，按内层方法重新查表判定，并保留、扩充 host_tests.rs 的用例。
  - `plugin.install` 拆成 `plugin.install`（txid，OfficialOnly）和 `plugin.installLocal`（HostOnly）；兼容别名固定映射到 HostOnly。
  - M0 内明确顺序：先做 MethodRegistry，再做白名单等级，最后上 CI 检查。

### B3 §3.3/§7.4 命名 `mcp__<server>__<tool>` 与现有原生名适配层冲突
- **位置**：§3.3 命名规则；§7.4「一等注册」。
- **问题**：仓库已经有一套原生工具名适配：
  - `native/names.rs:28` 把 `mcp_call` 的别名定义为 `mcp__<server>__<tool>`；
  - `native/structured.rs:130 parse_mcp_name` 会把这种名字拆成 `{server, tool, arguments}`，改写成对 `mcp_call` 的调用。
  
  执行链路在 executor.rs:337/363/374 和 plan_review.rs:258，都是先 `resolve_registered_call`、再对结果统一调用 `adapt_native_tool_call`。因此即使 `mcp__github__search_code` 已作为一等工具注册，调用仍会被改写成 `mcp_call`：
  - 风险评估走 McpTool 固定的 High（tools/src/mcp.rs:52-55）；
  - 按工具记忆的审批规则、EffectiveSet 过滤、`execution_mode` 和 fingerprint 都会失效。
  
  另外，`resolve_registered_name`（router.rs:406）采用「'.'→'_' 后唯一匹配」。插件工具名含 '.'（host.rs:350 `format!("{}.{}")`），方案没有定义它和双下划线名之间的冲突和唯一性规则。
- **证据**：names.rs:28；structured.rs:130-140；executor.rs:335-374；plan_review.rs:258；tools/tests.rs:180-183；router.rs:406；host.rs:350。
- **改法**：§3.3 增加「适配层迁移」一节：
  - 已注册名称优先，命中时跳过 `adapt_native_tool_call`；
  - `mcp_call` 退化为 fallback，只在 server 未一等注册时使用；
  - 更新 tests.rs:180 的断言；
  - 给出 '.'/'_'/'__' 三种分隔符的规范化和冲突检测规则，冲突时拒绝注册并写入诊断。

---

## 三、重要（I）

### I1 §3.2 `specs_for` 的改动面被低估
- **位置**：§3.2（方案第 204 行）。
- **问题**：方案只说「lib.rs:332 改为每次调用 provider 前执行 `executor.specs_for(session, turn_state)`」。实际上 `specs` 是 `ToolExecutor` trait 方法（agent lib.rs:145），实现和调用方分布在：
  - lib.rs:190/660/1085/1199（含测试实现）；
  - image_history_tool.rs:78/223（包装器，会追加 spec）；
  - executor.rs:318；
  - executor/plan_review.rs:214；
  - executor/adaptation.rs:11；
  - gateway/system.rs:50（直接调 `state.router.specs()`）。
  
  另外，把计算挪到循环内每轮执行，会改变工具列表稳定性，影响 prompt cache 命中，方案没评估。
- **改法**：列出全部 trait 实现和包装器的改动清单；给 `specs_for` 设缺省实现 `self.specs()` 以降低迁移成本；只在 EffectiveSet 版本号变化时重算，保持 cache 友好。

### I2 §7.4 deferred_tools 与全局 catalog 不兼容
- **问题**：`ToolSearchTool` 使用的 `router.catalog()` 是 Router 单例级别的全局目录（miniq-tools lib.rs:154，state.rs:170）。`select:` 解锁（catalog.rs:51-52）没有会话维度的状态。方案要求「按会话 select 解锁」，需要一份每会话的 unlocked 集合并接入 `specs_for`，方案没有设计。
- **改法**：在 turn_state 中加 `unlocked_tools: BTreeSet<String>`，由 tool_search 的输出回写，`specs_for` 负责合并；补充跨会话隔离测试。

### I3 unknown_tool 恢复信息会泄露 EffectiveSet 之外的工具
- **问题**：`executor/adaptation.rs:11 unknown_tool_output` 用 `router.specs()` 返回**全部**工具名。启用按会话/作用域过滤后，这里会把已禁用或未解锁的插件、MCP 工具暴露给模型，违背 §3.2 的隔离目标。
- **改法**：改为基于 `specs_for` 生成，并纳入 §3.2 的改动清单。

### I4 §4.3 EffectiveRisk 缺少数据来源
- **问题**：
  - `Risk { level, reason }`（miniq-sandbox/src/command.rs:11）没有 origin 和注解字段；
  - `ToolOrigin`（router.rs:46）只有 `Builtin`/`Plugin{id,runtime,version}`，没有 scope，也没有 MCP 变体；
  - 全仓有 32 个文件实现 `evaluate_risk`，`Risk {` 构造共 131 处。
  
  方案的「取最大值 + NonPreapprovable」需要在 executor 层结合 `router.origin()`（router.rs:418）和 MCP annotations 另算。方案没说明是在 executor 层计算，还是扩展 `Risk` 结构。后者会波及 131 处构造。
- **改法**：明确在 executor 层引入 `EffectiveRisk::compute(risk, origin, annotations, rules)`，不改 `Risk` 结构；`ToolOrigin` 增加 `Mcp{server}` 和 `scope` 字段，并列入 M1 改动点。

### I5 §7.1 rmcp 整体替换：配置迁移与调用点未列，决策早于 spike 结论
- **问题**：
  1. `DaemonSettings.mcp_servers: Vec<crate::mcp::McpServerConfig>`（state.rs:26-38）直接序列化进 settings.json。§13.3 改为 `mcp/servers.toml`，但没给迁移步骤、回滚方式和双读窗口。
  2. 调用点未列：`state.mcp_bridge()`（state.rs:225，每次克隆配置）、`with_mcp` 调用点（turn.rs:550、agent_tasks.rs:254）、gateway/mcp.rs:39 `list_tools`、`gateway/settings.rs` 的 update 路径。
  3. M0 第 2 周才出 rmcp spike 结论，方案却已写死「整体替换 daemon/src/mcp.rs、M2a 留 1 周」，缺少 spike 失败时的备选方案（例如只替换 transport、保留现有 client）。
- **改法**：补一节「配置迁移 ADR」：首次启动迁移、保留 settings.json 字段一个大版本、`settings_load_failed` 事件。列出全部调用点。把 M2a 的 1 周改成「spike 通过则 1 周，否则 2-3 周」的条件排期。

### I6 §13.2 事件契约漏了远程可见性和前端兼容
- **问题**：
  - 新事件除了注册 `event_journal.rs:101 sidebar_event`，还要在 `remote/subscriptions.rs:106 visible()` 声明远程可见性。方案只对 `hook_result` 写了「不远程可见」，没有逐条声明。
  - event.rs:280 对 session id 的映射需要逐个事件补充。
  - `plugins_changed` 的 payload 从 `PluginInfo[]` 改成 `PluginSummary[]`，属于破坏性变更，前端和远程客户端都没有兼容期。
- **改法**：§13.2 表格增加「remote visible」「session 映射」两列；`plugins_changed` 保持旧 payload，另发 `plugins_changed_v2`，或加 `version` 字段后再兼容一个大版本。

### I7 §15 排期：M0 负载过重，关键路径没有显式标出
- **问题**：M0 只有 3 周（方案第 1400 行），前 2 周要做 4 个 spike：rmcp、gix vs git、keyring headless、编译体积。同一阶段还要完成：
  - MethodRegistry 迁移约 107 个手写 match 臂；
  - 远程白名单（含 host.call）；
  - `decide_approval` 收口（B1 的 4 层贯通）；
  - `features.get`、workspace trust 占位。
  
  按 B1-B3 补齐的改动面，M0 很难在 3 周内闭合。而且白名单依赖 MethodRegistry、EffectiveSet 依赖 `specs_for` 和 ToolOrigin 扩展，这两条是串行关键路径，§15 没有标出。
- **改法**：M0 拆成 M0a（spike + ADR，2 周）和 M0b（MethodRegistry → 白名单 → 审批收口，2-3 周）；§15 增加关键路径图，给每条依赖标注负责人和缓冲。

### I8 附录 C.1「全部 ✅」与实际不符
- **问题**：以下 R1 条目在代码层面只是部分解决：
  - I6「RPC 手工接线成本」标为 ✅，依据是 §3.5 MethodRegistry，但 MethodRegistry 与白名单、CI 的顺序和 host.call 处理都没定（B2）；
  - 审批和远程相关的 B 类条目，漏列了 session_approval.rs 和 remote_request_allowed（B1/B2）；
  - EffectiveSet 相关条目漏了 trait 改动和原生名适配层（I1/B3）。
- **改法**：C.1 增加「部分解决 ◐」状态，逐条注明剩余工作并链接到本评审条目编号。

---

## 四、建议（S）

### S1 修正黑名单数量
- remote.rs:268-284 实际 11 项：browser.resolve、daemon.shutdown、daemon.shutdownIfIdle、computer.requestPermission、settings.update、workspace.open、workspace.updateRoots、externalSession.import、mcp.update、skill.delete、host.save、host.remove。§4.1 应把「12 个」改为 11 个，并在迁移测试中逐项断言新等级不比原来更宽松。

### S2 WASM 默认 Medium 的连带影响
- host.rs:375-380 从 Low 改为 Medium 后，现有插件工具会开始频繁请求审批。建议同时提供按工具的 manifest 声明（只能下调到 Low，并在审计中记录），并更新相关测试。

### S3 并行执行白名单写死
- executor.rs:353 的 `execution_mode` 把只读工具名写死在代码里，MCP 或插件的只读工具（`readOnlyHint`）无法并行。建议由 annotations 驱动，并在 §7.4 注明。

### S4 未核验锚点请作者自查
- 本轮未能核验：manager.rs:294-324/347-407、client.rs:194-212、miniq-local lib.rs:33、hooks.rs、plugin diagnostics 实现、前端 Composer/useComposerSlash（附录 B 称无 `@`）。建议作者提交前运行一个锚点校验脚本（grep 行号 + 摘要），避免再出现 state.rs:64-68 这类错位。

### S5 §13.1 兼容别名需要写明到期时间
- `plugin.install`（本地路径）、`plugin.reload`、`mcp.update` 保留一个大版本，但没写版本号和移除条件。另外，`mcp.update` 目前在远程黑名单中，别名在新体系下的等级也应显式声明为 HostOnly。

---

## 五、结论

| 级别 | 条数 |
|---|---|
| 阻断 B | 3（B1 审批收口不全、B2 远程白名单嵌套与等级冲突、B3 `mcp__` 命名与原生适配层冲突） |
| 重要 I | 8 |
| 建议 S | 5 |

**结论：修改后可交付。**

方案的整体架构方向和大部分锚点都与代码一致：抽查的主要锚点中，除 state.rs:64-68 外全部正确。但审批、远程、工具命名三处安全相关收口存在遗漏的改动点或冲突，必须在 M0 开工前补进方案（B1-B3）。同时 §15 需要按 I7 拆分 M0，并补上关键路径。附录 C.1 按 I8 把部分条目改为「部分解决」后，可以进入 M0。
