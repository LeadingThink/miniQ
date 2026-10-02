# R2 评审：安全与交付（05-plan-v2.md）

- 评审角色：安全架构 + 交付管理
- 评审对象：`05-plan-v2.md`（v2 方案）；对照 `review-r1-security-delivery.md`（R1）及附录 C.3
- 代码抽查：`crates/miniq-daemon/src/{remote.rs,gateway.rs,state.rs,gateway/session_approval.rs}`、`crates/miniq-protocol/src/session_approval.rs`
- 分级：**阻断(B)** = 不改则不能开工或会留下可利用的越权路径；**重要(I)** = 必须在对应里程碑开工前修正；**建议(S)** = 可以在实现中顺手处理

## 0. 总体评价

v2 相对 v1 改进很大，R1 提出的主要结构性问题都有了对应设计：
- 远程白名单（默认拒绝）；
- 审批收口到 `decide_approval`；
- 风险"只升不降"；
- NonPreapprovable；
- 签名 + 防回滚 + 撤回；
- 第三方 hook 不能 allow；
- 数据目录与迁移；
- 契约表。

剩下的问题集中在三类：
1. **远程白名单没有覆盖"审批控制面"本身**：`session.approval.update`、`approval.resolve`、定时任务授权、连接器只读集合确认，这些都是在远程端改变授权状态的入口。
2. **`plugin.install` 的两段式契约（preview → install{txid}）与"单枚举远程等级"的 MethodRegistry 对不上**，存在远程安装第三方插件的绕过路径。
3. 若干规则**写了原则，但缺少判定细节**，同事无法照着实现和验收：
   - `trusted_readonly` 与"只升不降"相互矛盾；
   - hooks 超时失败时放行还是拦截；
   - `<untrusted>` 包裹可以被内容闭合；
   - OAuth 元数据校验；
   - 密钥轮换的约束。

统计：**B 2 项，I 17 项，S 10 项**。结论：**修改后可交付**（见 §6）。

---

## 1. 阻断（B）

### B1 远程端可以改写审批状态："审批控制面"不在 §4.1 白名单设计内

- **位置**：§4.1 远程等级表（`session.*` 整体 Allow）；§4.3 记忆层级与"按任务授权"；§12.2"持久化放行仅限主机"；§13.1 方法表；D3。
- **问题**
  1. **远程可以切 FullAccess**。§4.1 把 `session.*` 整体划为 Allow。现有代码中 `session.approval.update` 就在这个命名空间里（`gateway.rs:108` → `gateway/session_approval.rs:31` `set_session_approval_mode`），可以把会话切到 `FullAccess`（`miniq-protocol/src/session_approval.rs:6-10`）。按 §4.3 矩阵，FullAccess 下 High 风险直接放行。远程端一次调用就能把"每次询问"变成"全放行"，这与 D3"远程只能装官方、启停、连接器授权、只读诊断"直接冲突。
  2. **"总是允许"只在 UI 上禁止**。§12.2 / §4.1 写的是"远程审批卡只提供本次 / 本会话"，但这只是 UI 约束。`approval.resolve`（`gateway.rs:150`；现有测试 `remote.rs:454` 明确允许远程调用）将来会接受新增的 `ApprovalDecision::AlwaysAllowTool`（§4.3）。服务端没有规定远程调用方不能提交这个决定，所以远程端直接发 RPC 就能写入持久化放行。
  3. **两类持久化授权的远程等级未定义**：
     - 定时任务"按任务授权"：创建时一次确认所需工具，本质是持久化预批准；
     - 连接器"一次确认只读集合"：写入 `approval_mode="approve"`，而 `connector.connect` 是 ConnectorAuth，远程可调。
  4. **契约表缺这些方法**。§13.1 只列了插件 / MCP / 连接器方法，`session.*`、`approval.*`、定时任务相关方法都没有逐一给出等级。CI 规则"缺远程声明即失败"只能保证有声明，保证不了声明正确。
- **依据**
  - §2.1"只有用户层 / 托管层能授权"；
  - §12.2"持久化放行仅主机"；
  - D3；
  - R1 B6（远程授权面）。
  - 威胁模型中的"远程控制面"资产也没有把"审批模式 / 放行规则"列为被保护对象。
- **改法**
  1. 取消 `session.*` 通配。§13.1 补一张"现有方法远程等级表"，逐一列出 `gateway.rs:99-150` 的全部方法。
  2. `session.approval.update`：远程端只能**降低**权限（FullAccess→Auto→AlwaysAsk）；升到 FullAccess 必须 HostOnly，或者在主机上二次确认。
  3. `approval.resolve`：服务端按 actor 限定可接受的决定集合，远程只收 `Approve / ApproveForSession / Reject`；收到 `AlwaysAllowTool` 返回 `REMOTE_FORBIDDEN`。
  4. 定时任务授权的创建 / 修改、连接器只读集合确认（写 approve）都设为 HostOnly。远程发起连接时只完成 OAuth，不写 approve，回到主机后再补确认。
  5. 在 §16.1 红队用例和 M0 退出标准中加入以下测试：
     - "远程切 FullAccess"；
     - "远程提交 AlwaysAllowTool"；
     - "远程创建带授权的定时任务"。
  6. 新增决策 D16："远程端能否提升会话审批模式"，推荐"否"。

### B2 远程安装链可绕过 OfficialOnly：txid 两段式 + 单枚举注册表 + 旧别名 + host.call 嵌套

- **位置**：§3.5 `method!("plugin.install", …, Remote::OfficialOnly, …)`；§4.1（`plugin.install` 同时写了 OfficialOnly 和"非官方 HostOnly"）；§13.1（`plugin.previewInstall` Allow，参数 `{source|key}`；`plugin.install {txid, confirm}` OfficialOnly；旧 `plugin.install` / `mcp.update` "保留兼容别名，内部转发"）；现有 `remote.rs:287-299`。
- **问题**
  1. **`plugin.install` 的参数里没有 source**，只有 txid。
     - OfficialOnly 只能在查询 txid 对应的事务之后才能判定，而 §3.5 的宏把等级设计成与参数无关的枚举，表达不了这种判定。
     - 实现者很可能只检查"方法名 = OfficialOnly = 远程可调"。一旦这样实现，远程端就可以先 `previewInstall{source: 第三方 git}`（Allow），再 `install{txid}`，第三方插件因此被装上。
  2. **`previewInstall` 在远程是 Allow，而且接受任意 source**。这等于远程端可以让主机对任意 URL 执行 git clone 或下载，带来 SSRF、内网探测、磁盘 / 带宽消耗等问题，也违反 D3。
  3. **txid 没有绑定发起者**。远程端可以确认一个主机端生成的 txid，反过来也一样。
  4. **旧别名继承等级不明**：
     - 旧 `plugin.install` 是本地路径安装，`mcp.update` 目前在远程黑名单里（`remote.rs:268-284`）。
     - "别名内部转发到新实现"没有说别名本身的远程等级。如果别名继承了新方法的 OfficialOnly，远程端就能装本地路径插件或改 MCP 配置。
  5. **`host.call` 嵌套未处理**：
     - 现有 `host.call` 用内层 `params.method` 查黑名单（`remote.rs:291-299`）；
     - 迁到 MethodRegistry 后，内层方法怎么解析、按什么参数判定等级，§4.1 / §3.5 都没有提到；
     - 到了目标主机的 daemon 那一侧，请求是否仍然标记为远程来源，也没有定义。
- **依据**：D3；§4.1 默认拒绝；R1 B6、B7；§2.1"远程默认拒"。
- **改法**
  1. 远程等级改为 `Remote::Policy(fn(&Params, &Ctx) -> RemoteDecision)`，枚举只是它的常用简写。`plugin.install` / `update` 的策略先查 txid → source，再判定是否官方。
  2. 远程调用 `plugin.previewInstall` 时，只允许官方源的 `key`，禁止任意 `source`，远程等级改为 OfficialOnly。
  3. txid 绑定 `{actor, connection_id, source, content_hash}`，只能由同一 actor 确认，10 分钟过期。
  4. 旧别名注册成独立的方法，一律 HostOnly，并写入 §13.1。
  5. `host.call` 的内层方法必须经过同一个注册表的完整策略判定（含参数）；目标 daemon 收到的请求要携带 `origin=remote`；补测试。
  6. 在 §16.1 加红队用例："远程 preview 第三方 → install txid"、"远程调用旧 `plugin.install` 别名"、"`host.call` 包装 `plugin.install`"。

---

## 2. 重要（I）

### I1 `trusted_readonly` 与"只升不降"矛盾，且只读身份靠名字判定

- **位置**：§4.3 第 3 条（官方签名 / 连接器目录 `trusted_readonly` → Low）；§8.1 `trusted_readonly_tools`；§4.3"只有第 6 条可以降"。
- **问题**
  - 连接器目录里的只读工具清单是**按工具名**签名的，但工具的实际行为由厂商服务器决定。服务器把 `list_issues` 改成有副作用的实现后，名字不变，风险仍然是 Low。
  - §7.5 的"描述 / schema 哈希变化使总是允许失效"只覆盖第 6 条，没有说也会让 `trusted_readonly` 的 Low 失效。
- **改法**
  1. 把第 3 条改写为"风险基线由 miniQ 签名目录给出"，并在原则里明确它是除第 6 条之外唯一的降级来源。
  2. 目录条目同时签入描述 / schema 哈希；运行时哈希不一致就回到 Medium 并提示。

### I2 `mcp__*` 未知名回退到 `mcp_call` 可能绕过 EffectiveSet 检查

- **位置**：§3.3（未知 `mcp__*` 改写为 `mcp_call`）；§3.2（执行前检查 EffectiveSet 成员）。
- **问题**：`mcp_call` 本身在 EffectiveSet 中。模型拿一个已禁用或已撤回 server 的 `mcp__x__y` 名字调用时，改写成 `mcp_call` 后可能通过成员检查。
- **改法**
  - 执行器对 `mcp_call` 按内层 `(server, tool)` 再做一次 EffectiveSet 检查和 `mcp:<server>:<tool>` 审批，失败返回 `TOOL_NOT_IN_EFFECTIVE_SET`。
  - 补单测："禁用 server 后通过回退名调用"。

### I3 命名冲突 `_2` 取决于注册顺序，放行规则可能"串号"

- **位置**：§3.3。
- **问题**：重装或加载顺序变化后，`foo__search` 和 `foo__search_2` 可能对调。凡是按暴露名存储的规则（原生工具"总是允许"、技能 `allowed_tools`、定时任务授权），都会落到另一个工具上。
- **改法**
  - 所有放行规则和授权都按稳定的 `ToolOrigin{source, plugin_key, server_key, tool}` 存储，暴露名只用于展示和模型调用。
  - 冲突时用确定性规则（例如按 plugin_key 字典序）生成后缀，并给出诊断。

### I4 "总是允许"的失效条件不完整

- **位置**：§4.3 记忆层级；§7.5。
- **问题**：失效条件只列了卸载、描述 / schema 哈希、URL 变化和用户撤销，漏了以下情况：
  - stdio 的 `command / args / env / cwd` 变化；
  - 插件来源（marketplace）或签名密钥变化；
  - 插件大版本更新；
  - 同名插件从另一个源重装。
- **改法**：规则绑定 `{ToolOrigin, source_id, signer?, transport_fingerprint(url 或 command+args+env键), desc_hash}`，任一项变化即失效；补矩阵测试。

### I5 FullAccess "grep CI" 作为 M0 验收标准不可靠，调用点清单不全

- **位置**：§4.2；§15.1 M0 退出标准"FullAccess grep 检查通过"；§16.4。
- **问题**
  - grep 拦不住 `use ApprovalMode::*`、`matches!`、`==` 比较、类型别名和重导出。
  - 清单漏了 `gateway/session_approval.rs` 和 `miniq-protocol/src/session_approval.rs`（实际引用点共 7 个文件）。
- **改法**
  - 用类型约束代替 grep：`ApprovalCtx` 放进私有模块，只暴露 `decide_approval()`；执行器只接收 `ApprovalVerdict`（不可在模块外构造）。
  - grep 降为辅助检查；清单补全后写入附录 B。

### I6 威胁模型缺少远程设备 / relay 失陷、本机 IPC、SSH 转发主体

- **位置**：§2.2；附录 C.3 I8（同机同用户攻击者不在范围内）。
- **问题**
  - 远程等级设计的前提是"手机端可信但能力受限"，但没有写"手机失陷或会话被劫持"时的影响上限。
  - 没有写 daemon 本地 socket 的权限（其他本机用户）。
  - 没有写 `host.call` 把请求转发到另一台主机时的信任传递。
  - I8 的排除条件没有写进 §2.2 正文，同事看不到。
- **改法**：§2.2 补这三类主体和对应控制，把"同机同用户不在范围"写成显式假设，并列出由此放弃的防护（比如审计防篡改）。

### I7 定时任务与 NonPreapprovable 首次调用冲突，任务级授权范围不清

- **位置**：§4.3 矩阵（定时任务遇到 NonPreapprovable 拒绝并通知）；§6.5 官方源默认自动更新；§15.2 M5。
- **问题**：官方插件自动更新后，每个工具都会重新变成"首次调用"，于是所有依赖它的定时任务在下一次运行时失败。此外，任务级授权绑定的是工具名还是版本、是否跨版本有效，都没有写。
- **改法**
  - 定时任务引用的插件在自动更新时暂停，等待主机确认，并在确认时一并确认首次调用；或者更新推迟到用户下次打开时。
  - 任务授权绑定 I4 中的 ToolOrigin 元组；授权创建为 HostOnly（见 B1）。

### I8 签名：密钥轮换可被当前密钥单方面改写；索引过期和撤回的行为不闭环

- **位置**：§6.3、§6.5；M1 退出标准"撤回生效 ≤ 24 小时"。
- **问题**
  1. **轮换**："索引可以携带由当前密钥签名的轮换声明"。当前密钥一旦泄露，攻击者可以把信任轮换到自己的密钥，内置的"下一把"就失去了意义。
  2. **过期**：索引 7 天过期后（离线，或 CDN 被屏蔽），已安装的官方插件继续运行还是禁用？自动更新停不停？这些都没有定义。攻击者屏蔽刷新就能把撤回延后到 7 天以上。
  3. **撤回文件**：`revocations.json` 有没有自己的 `sequence / expires_at`，是否与索引原子绑定，都没有写。如果可以单独回放旧的撤回文件，就能"取消撤回"。
  4. **撤回与拒绝更新的组合**：旧版本被撤回时，用户"拒绝更新继续用旧版"的逻辑必须让位给撤回。
- **改法**
  1. 轮换只允许切到二进制内置的下一把公钥；再往后轮换必须发新二进制，或者要求双签（当前 + 下一把）。
  2. 定义过期状态机：7 天过期后显示"无法验证撤回状态"，停止自动更新和新安装，已安装的继续运行（可配置为禁用）；超过 30 天可以由托管策略设为禁用。
  3. 撤回列表内嵌进签名索引，或与索引共享 `sequence`。
  4. 在 §6.5 写明"撤回优先于拒绝更新"。

### I9 自动更新的暂停条件与重新确认条件不一致

- **位置**：§6.5。
- **问题**：重新确认的条件是"新增权限，**或**技能 / 工具描述变化"，但官方自动更新只在"权限扩大"时暂停。技能文本和工具描述正是注入面，官方插件被投毒后可以不经确认直接进入上下文。
- **改法**：自动更新的暂停条件与重新确认条件保持一致；技能 / 描述变化至少需要主机端确认，或在差异较小时通知并允许一键回退。

### I10 Hooks：信任哈希范围、失败语义、改参能力未定义

- **位置**：§10.1–10.2。
- **问题**
  1. **哈希范围不可判定**。"command 引用多个文件时用 `content_hash`"需要解析 shell 命令，做不到。`command` 字符串本身，以及它调用的解释器和外部脚本，也不在哈希范围内（例如 `bash -c "curl … | sh"`）。
  2. **超时 / 崩溃 / 输出非法时的行为没有定义**，不知道是 fail-open 还是 fail-closed。托管 hooks（F9）必须 fail-closed；第三方 hooks fail-open 时也要可见。
  3. **能否改写工具输入没有说**。输出 schema"本轮未核实"，而 Claude Code 类的 hook 可以改写工具输入。如果改写发生在审批之后，或者改写的内容没有展示在审批卡上，就等于绕过审批。
  4. **"用户自己写的 hooks"如何认定没有说**（按路径？按来源？）。
  5. **PreToolUse 会拿到工具参数**，其中可能含敏感数据，信任卡片没有提示这一点。
- **改法**
  - 信任哈希 = `sha256(command 字符串 + 插件 content_hash)`，项目层 hooks 用整个 `.miniq/hooks/` 目录的哈希。
  - 定义失败矩阵：托管 hooks fail-closed，其他 hooks fail-open，并写审计。
  - 明确禁止第三方 hooks 改写输入；如果允许，改写必须发生在 `decide_approval` 之前，并展示在卡片上。
  - "用户层"按 `ToolOrigin.source=user` 认定。
  - 以上作为 M4 开工门槛。

### I11 `<untrusted>` 包裹可被内容闭合，工具描述不在包裹范围内

- **位置**：§9.6。
- **问题**
  1. 内容里如果出现 `</untrusted>`，就能跳出包裹。
  2. MCP 的 `tools/list` 描述和参数 schema（工具投毒的主要载体）直接进入 tools 数组，不在列表中。首次连接时的投毒不受 rug-pull 哈希保护。
- **改法**
  - 用每次请求随机生成的边界标记（例如 `<untrusted-7f3a…>`），并对内容中的同名标记转义。
  - 第三方工具描述限长（例如 1k 字符），剥离控制字符和隐藏 Unicode，首连卡片中展示描述全文。
  - 在 §16.1 加入"闭合标签逃逸"和"描述投毒"红队用例。

### I12 OAuth 元数据校验和 SSRF 未规定

- **位置**：§7.6。
- **问题**：发现流程依赖不可信 server 给出的 PRM / AS 地址，但没有规定以下校验：
  - PRM 的 `resource` 必须等于 server URL（RFC 9728 §3.3）；
  - AS 元数据的 `issuer` 必须等于请求地址（RFC 8414 §3.3）；
  - 回调要校验 `iss`（RFC 9207），防止 mix-up；
  - 元数据 URL 禁止指向内网 / 回环 / 链路本地地址（SSRF，daemon 可能跑在云服务器上）；
  - 必须 HTTPS。

  另外，scope 回退到 `scopes_supported` 会申请过多权限。
- **改法**：补一节"发现与校验"清单，并做成 mock server 集成测试（§16.1 已有 mock，只需补用例）。连接器目录固定 scopes；第三方 server 没有配置 scopes 时，不传 scope，也不回退到 `scopes_supported`。

### I13 stdio / 项目层 MCP 的启动即执行缺少独立确认

- **位置**：§7.9、§4.4、§4.5（M4 开放项目层 MCP）。
- **问题**：stdio server 一启动就是任意代码，而且拿到 `HOME` 和用户权限，比任何工具审批都早。对插件内的 server，安装确认卡算是一个确认点。但项目层 `.mcp.json` 只要求"工作区信任"：仓库一更新就会新增或修改命令，§4.5 虽然有"hash 变化需重新确认"，但粒度是整个配置文件，确认卡上不一定展示命令。
- **改法**
  - 每个 stdio server 首次启动，以及 `command/args/env` 变化时，都在主机端逐个确认（HostOnly），卡片展示完整命令。
  - 远程端 `mcp.setEnabled` 只能启用已确认过的 server。

### I14 受信任工作区的判定细节不足

- **位置**：§4.5；§13.3 `workspace-trust.json`。
- **问题**：以下几点都没有定义：
  - 符号链接 / 大小写 / 挂载点如何规范化；
  - 父目录信任是否覆盖子目录；子目录里的嵌套仓库怎么处理；
  - `git_remote` 的用途（记录还是校验？remote 变化是否失效）；
  - `config_hash` 覆盖哪些文件（是否包括 hooks 脚本、`.mcp.json` 引用的本地脚本）。
- **改法**
  - 默认只信任精确路径（realpath），子目录不继承。
  - hash 覆盖 `.miniq/`、`.codex/`、`.agents/plugins/` 下的全部文件；`git_remote` 只作展示。
  - 以上写进 §13.3，作为 M0 数据结构的约束。

### I15 安全底座与特性开关的关系没有写明

- **位置**：§4.7（off 即走旧路径）；§16.2（kill switch、降级安装包）；§14"FullAccess 无开关"。
- **问题**：`mcp_v2=off` 会回到旧的 `mcp_call` 路径，但不清楚旧路径是否也经过 `decide_approval`、远程白名单和 NonPreapprovable。如果没有，关掉开关（或者服务端 kill switch）就等于关掉了安全修复。降级安装包会让远程重新回到黑名单模型，这一点也没有写进回滚风险。
- **改法**
  - 明确 §4.1–4.4 不受任何 feature flag 控制，旧路径同样收口。
  - 在 M0 退出标准中加入"所有 flag 组合下的审批矩阵测试"。
  - §16.2 写明降级后的安全退化和建议的最低版本。

### I16 §13 契约缺少安全核心类型签名，同事无法并行实现

- **位置**：§13；§15.3（五条线只通过 §13 耦合）。
- **问题**：M0 的核心类型只有文字描述，没有 Rust 签名或 JSON schema：
  - `ApprovalCtx`、`EffectiveRisk`、`decide_approval`；
  - `EffectiveSet`、`ToolOrigin`；
  - `RemotePolicy`、`ApprovalDecision` 新变体。

  `index.json`、`revocations.json`、`connectors.json` 也没有进 §13.3。缺了这些，"安全底座"线和"MCP"、"包"两条线会各自发明自己的类型。
- **改法**：在 §13 增加"13.6 核心类型"（Rust 签名 + 不变量）和"13.7 签名文件 schema"，并在 M0 第 1 周评审，而不是 M1 第 4 周。现在 §13 标注的是"M1 第一周评审产出"，但 M0 已经在实现这些类型，时序颠倒了。

### I17 M0 排期过满，退出标准缺远程红队

- **位置**：§15.1 M0（3 周）。
- **问题**
  - M0 要在 3 周内完成：4 个 spike、全量方法注册表（`gateway.rs` 全部现有方法逐一定级，见 B1）、审批收口（跨 7 个文件）、EffectiveSet、迁移框架、features、工作区信任数据结构。第 1–2 周还被 spike 占用。
  - 退出标准里没有 B1 / B2 的红队用例，而 §16.1 的红队用例也没有挂到任何里程碑的退出标准上。
- **改法**
  - M0 改为 4 周，或把"迁移框架 / 工作区信任数据结构"移到 M1。
  - 每条红队用例标注所属里程碑，并写进对应的退出标准。
  - 安全评审签字的检查单作为附录。

---

## 3. 建议（S）

- **S1 token 绑定**（§7.7）："resource 与目标 URL 同源"太宽，同一个网关域名下的多个租户会共用一个 token。改为按规范化后的 resource URI 精确匹配。
- **S2 口令变量泄漏**（§7.7）：`MINIQ_CREDENTIALS_PASSPHRASE` 会留在 daemon 的环境变量里。hooks、Node、LSP 等所有子进程都要用白名单环境变量，并加测试确认不泄漏；启动读取后从环境中清除。
- **S3 远程 OAuth 钓鱼**（§7.6 / ConnectorAuth）：远程端打开授权 URL 前，展示 AS 域名和连接器目录中登记的预期域名，不一致时警告。
- **S4 Elicitation**（§7.8）："禁止 password 字段"只能识别 `format`。补充按字段名启发式识别（token / pin / secret），并禁止在远程端渲染第三方 form。
- **S5 推荐误触发评测**（§9.5）："误触发率 < 5%"需要写明评测集的规模、来源和负样本比例，并作为 M3 退出标准。
- **S6 审计完整性**：§13.4 没有防篡改，这在"同机同用户不在范围"的前提下可以接受，但要在文档中写明。可选做法是按天做哈希链。另外，审批决定的记录要包含 actor（local / remote:<device>）和决定类型，以便事后追查 B1 类行为。
- **S7 指标**（§16.3）：
  - 补安全类指标：NonPreapprovable 触发 / 拒绝数、撤回生效时间分位、`IGNORED_PACKAGE_APPROVAL` 次数、远程 `REMOTE_FORBIDDEN` 次数。
  - "审批弹卡数 / 回合"和"总是允许采用率"补上目标区间和告警阈值，不能只统计。
- **S8 远程 ToggleOnly 启用**（§4.1）：远程端启用"用户在主机上主动禁用过"的插件或 server，建议需要主机确认（记录禁用原因 = user_security）。
- **S9 回滚数据**（§16.2）：降级后，旧版本只读 `settings.mcp_servers`，迁移后在 `servers.toml` 新增的 server 会"消失"。在更新日志和 `doctor` 中提示。
- **S10 决策表**（§17）：新增以下决策，建议在 MVP 开工前拍板：
  - D16：远程能否提升审批模式（B1）；
  - D17：定时任务授权的范围与更新策略（I7）；
  - D18：hooks 失败语义（I10）；
  - D19：安全底座不受开关控制（I15）。

---

## 4. §17 决策建议评估

| # | 评估 | 说明 |
|---|---|---|
| D1 | 同意 | 连接器"一次确认只读集合"需要满足 I1 的哈希绑定和 B1 的 HostOnly |
| D2 | 同意 | 核心安全底线；实现上用 I5 的类型约束代替 grep |
| D3 | 同意，但不完整 | 需要补上审批控制面（B1）和按参数判定（B2） |
| D4 | 有条件同意 | 暂停条件要与重新确认一致（I9）；要考虑定时任务（I7） |
| D5 | 同意 | 明文回退可以接受；补 S2 |
| D6 | 同意 | 中继看不到 verifier 的论证成立；CIMD 域名需纳入密钥 / 证书运维 |
| D7 | 同意 | — |
| D8 | 同意 | — |
| D9 | 同意 | 前提是 M0 按 I17 调整 |
| D10 | 同意 | — |
| D11 | 同意 | 需要补 I14 的判定细节 |
| D12 | 同意 | — |
| D13 | 同意 | GitHub PAT 属于 `credentials`，按 §13.1 是 HostOnly，手机端连不了 GitHub；需要在 UX 中说明 |
| D14 | 同意 | 仅限官方源 + NonPreapprovable + 限频，风险可控 |
| D15 | 同意 | — |
| 缺失 | — | D16–D19，见 S10 |

## 5. R1 安全项落实核验（附录 C.3）

| R1 项 | C.3 标记 | 核验结果 | 说明 |
|---|---|---|---|
| B1 annotations 可信 | ✅ | 部分 | `trusted_readonly` 例外与"只升不降"冲突 → I1 |
| B2 插件自授权 | ✅ | 已落实 | 包内审批字段剥离 + `IGNORED_PACKAGE_APPROVAL` |
| B3 FullAccess 矛盾 | ✅ | 已落实（实现待改） | 矩阵清楚；grep 验收不可靠 → I5 |
| B4 allowed_tools 反转 | ✅ | 已落实 | 只收窄 |
| B5 可信工作区 | ✅ | 部分 | 判定细节 → I14 |
| B6 远程授权面 | ✅ | **未闭合** | 审批控制面、install 链 → B1、B2 |
| B7 推荐安装注入链 | ✅ | 已落实 | 仅官方 + NonPreapprovable + 限频 |
| B8 签名 / 可变 ref / 撤回 | ✅ | 部分 | 轮换、过期、撤回回放 → I8 |
| B9 hooks 信任与能力 | ✅ | 部分 | 哈希范围、失败语义、改参 → I10 |
| B10 凭据 | ✅ | 已落实 | 附 S1、S2 |
| B11 数据目录与迁移 | ✅ | 已落实 | 附 S9 |
| B12 工程契约 | ✅ | 部分 | 核心类型缺失、评审时序颠倒 → I16 |
| I1 远程 / CLI OAuth | ✅ | 部分 | paste-back 有 state；元数据校验 → I12 |
| I2 命名遮蔽 | ✅ | 部分 | 顺序相关后缀 → I3 |
| I3 总是允许范围 | ✅ | 部分 | 失效条件 → I4 |
| I4 注入面 | ✅ | 部分 | 标签逃逸、工具描述 → I11 |
| I5 iframe | ⏳ M6 | 可接受 | 设计方向正确（独立 origin + NonPreapprovable） |
| I6 子进程隔离 | ✅ | 可接受 | 明确"不宣称沙箱"；项目层 stdio → I13 |
| I7 elicitation 钓鱼 | ✅ | 已落实 | 附 S4 |
| I8 完整性边界 | ✅（声明排除） | 可接受 | 需要写进 §2.2 正文 → I6 |
| I9 里程碑顺序 | ✅ | 已落实 | M0 安全先行 |
| I10 排期 | ✅ | 部分 | M0 过满 → I17 |
| I11 验收标准 | ✅ | 部分 | 红队用例未挂到退出标准 → I17 |
| I12 灰度 | ✅ | 部分 | 开关与安全底座 → I15 |
| I13 指标 | ✅ | 部分 | 缺安全指标和阈值 → S7 |
| I14 用户旅程 | ✅ | 已落实 | `needs_auth`、推送 |
| I15 连接器前提 | ⏳ M2a spike | 可接受 | 有 PAT 兜底 |
| I16 CLI 绕过 daemon | ✅ | 已落实 | 写操作走 RPC，`--yes` 仅限本机 + 官方 |
| S1–S10 | ✅ | 基本落实 | 未逐项复核，没有发现回退 |

## 6. 结论

**修改后可交付。**

- **架构方向正确**，R1 的 12 个 B 项中有 6 项已完全落实，5 项部分落实。唯一**未闭合**的是 R1 B6（远程授权面），在本轮拆成 B1、B2 两个阻断项。
- **两个阻断项的修改量都不大**，都集中在 §4.1 / §3.5 / §13.1：
  - 补齐审批控制面方法的远程等级，服务端按 actor 限定审批决定；
  - 远程等级支持按参数判定，txid 绑定发起者，旧别名和 `host.call` 纳入注册表。
- **开工门槛**：
  - 这两项必须在 M0 开工前改进文档，并进入 M0 退出标准。
  - I5、I15、I16、I17 必须在 M0 开工前修正。
  - I1–I4、I8、I9、I11、I12 在 M1 / M2a 开工前修正。
  - I7、I10、I13、I14 在 M4 / M5 开工前修正。
- **交接可行性**：按上述修改后，§13 / §14 / §16 可以直接用于分工交接和验收。
