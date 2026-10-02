# 评审 R1：安全 / 体验 / 交付可执行性（针对 04-plan-draft-v1）

> 评审人角色：安全架构师 + 技术项目经理；只读评审，未改方案与代码。证据格式 `路径:行号`。
> 结论：**方向正确，但 v1 不能直接交给研发开工**。有 12 项阻断问题，集中在三类：审批语义与现有执行器冲突；插件自带配置可以给自己授权；缺少接口、迁移和发布方面的工程契约。预计补一轮 v2（约 1 周）后可以开工。

## 0. 评审依据的代码事实（方案未考虑到）

- 默认审批模式是 `Auto`（`crates/miniq-protocol/src/session_approval.rs:8`）。在 Auto 下，**Medium 风险不询问、直接执行**；在 FullAccess 下，Medium 和 High 都直接执行（`crates/miniq-daemon/src/executor.rs:519-551`）。子代理的 `dontAsk` 策略会直接拒绝需要审批的调用（`executor.rs:553-560`）。
- 远程通道采用**黑名单**：只拦截 `mcp.update`、`settings.update`、`skill.delete` 等 12 个方法（`crates/miniq-daemon/src/remote.rs:268-284`）。`plugin.install` 和 `plugin.setEnabled(confirmTrustedCode)` 目前**手机上都能调用**。方案新增的所有 RPC 默认也会被远程放行。持有 API Key 就等于拿到远程控制权（`docs/remote-access.md:13-36`）。
- 仓库**没有“受信任工作区”概念**，检索 `trusted_workspace`/`workspace_trust` 均无结果。但方案 §2.3、§3.2、§5.4 多处把它当作安全边界。
- 旧插件扫描会把 `<data_dir>/plugins/` 下**所有子目录**都当成插件，只跳过 `.install-*`、`.backup-*` 和 Node 宿主目录（`crates/miniq-plugins/src/manager.rs:294-306`）。方案 §2.3 在同一目录下新建了 `cache/`、`marketplaces/`、`data/`，旧逻辑会把它们报成失败插件。
- 仓库没有 Feature flag 和埋点基础设施（检索 `feature_flag`/`telemetry` 无结果）。审计日志已有，可以复用（`executor.rs:67-75` 的 `append_audit_event`）。
- 现有插件工具的公开名是 `<plugin-id>.<tool>`（`crates/miniq-plugins/src/host.rs:350`），方案 §3.4 改成 `plugin__tool`，但没有给迁移说明。

---

## 1. 阻断（开工前必须在 v2 中解决）

**B1. MCP 注解被当作可信输入，默认模式下安全性倒退**（§4.5、§8）
- 问题：`readOnlyHint`/`destructiveHint` 由 server 自己声明，MCP 规范要求不可信 server 的注解一律视为不可信。方案规定“有 readOnly 注解 → Low”，于是恶意 server 只要把自己标成只读，就能免审批外传数据。同时“无注解 → Medium”，在默认的 Auto 模式下会**直接执行**；而现状是 `mcp_call` 固定 High、按 server 审批，新方案比现状更宽松。
- 改法：注解只用于**提高**风险、不用于降低。只有“官方签名源 + 用户显式信任的 server”才允许注解把风险降到 Low。第三方或手动添加的 MCP 工具默认 High，也就是在 Auto 模式下按 server 或工具询问一次。给出一张“来源 × 注解 × 审批模式”的完整判定表，写成单元测试矩阵。

**B2. 插件包可以通过配置给自己授权**（§4.2、§4.5 优先级链、§3.1 `permissions`）
- 问题：`mcp.json` 和 `[servers.x]` 支持 `default_tools_approval_mode = "never_ask"` 和工具级 `approval_mode`。如果插件包自带的 MCP 配置里写上这些字段，插件就能跳过审批。方案没有区分“包内声明”和“用户配置”两个层级。
- 改法：审批相关字段（`approval_mode`、`default_tools_approval_mode`、`enabled_tools`）**只从用户层和托管层读取**，包内出现时忽略并给出 validate 警告。沿用现有测试“Node 不能自授权”的思路，新增“插件不能自降审批”的测试。

**B3. FullAccess、Auto、dontAsk 与“始终询问”互相矛盾**（§4.5、§5.3、§5.2）
- 问题：
  - §4.5 写“破坏性工具在 FullAccess 下也提示一次/会话”，但执行器里 FullAccess 对 High 直接放行，没有“FullAccess 仍询问”的通路。
  - 子代理 `dontAsk` 和定时任务（`schedule.rs:2`，走同一审批管线，无人值守）遇到“始终询问”会直接失败或卡住。
  - §5.3 `allowed_tools` 规定“名单外需要审批”，但在 FullAccess、Auto 下是否生效没有说明。
- 改法：在 `Risk` 中新增“不可预批准”标记（例如 `RiskLevel::Critical` 或 `requires_human: true`），executor 对这类调用忽略 FullAccess、Auto 和 session 放行；明确这类调用在 dontAsk 子代理或定时任务中的行为：拒绝并返回可读原因，或让定时任务进入 awaiting approval；给出 `allowed_tools` 在三种模式下的行为表。

**B4. `allowed_tools` 的语义可能被反向理解为授权**（§5.3、§3.1 Claude 兼容）
- 问题：在 Claude Code 中，skill 的 `allowed-tools` 表示“**预批准**这些工具”。方案同时兼容 `.claude-plugin`，如果实现者照 Claude 语义去做，恶意技能就能借此提权。
- 改法：在文档和代码中写死“`allowed_tools` 只做**收窄**，绝不授予、绝不跳过审批”，并加一条反向测试。

**B5. “受信任工作区”没有定义，却被当作安全边界**（§2.3、§3.2、§3.4、§5.4）
- 问题：项目级插件、项目 hooks、仓库 marketplace 都靠“受信任工作区”来防护，但这个概念在仓库里不存在。用户克隆恶意仓库后，`.miniq/hooks.json` 或 `.agents/plugins/marketplace.json` 就可能生效。
- 改法：在 M1 前补一份《工作区信任》小设计，覆盖：信任的粒度（路径 + git remote？）、存储位置、首次打开时的提示 UI、手机/CLI 上如何信任、信任被撤销时的行为。在它落地之前，项目级 hooks、插件、marketplace **默认关闭**。

**B6. 远程通道的授权面失控**（§3.5、§7.5，现状 `remote.rs:268-284`）
- 问题：黑名单模型下，新增的 `plugin.*`、`marketplace.add`、`hooks.trust`、`connector.*`、`mcp.add`，以及“总是允许此工具”的写回，都会自动对手机开放。在手机上安装第三方 Git 插件或信任 hook，等于在主机上执行任意代码。另外，`mcp.update` 远程被禁，但通过“安装一个带 mcp.json 的插件”可以绕过这条限制，形成自相矛盾。§7.5 的“hooks 信任允许在移动端完成”与此相冲突。
- 改法：本项目涉及的新 RPC 一律改为**白名单**，并在 RPC 清单中给每个方法标注“远程：允许 / 二次确认 / 禁止”；建议默认：远程只能安装**官方签名源**的插件；Git、本地来源、hook 信任、原生代码（WASM/Node）启用、marketplace 增删一律在主机端完成（桌面 UI 或 CLI TTY 确认）；把现有的 `plugin.install` 和 `plugin.setEnabled` 也纳入同一张表。

**B7. `request_plugin_install` 缺少注入防护链**（§5.2、§7.4）
- 问题：网页内容、MCP 结果或技能文本都可能诱导模型调用这个工具。方案 §5.2 写“安装后在同一回合继续”，新装的工具在 FullAccess 或 Auto 下可能被立即调用，形成“注入 → 安装 → 执行”链。参数 `name` 没有限定来源，hooks 待信任时的行为也没有说明。
- 改法：参数只接受 `name@marketplace`，并且仅限官方或管理员允许的源，不能是 URL 或 Git 地址；这个调用不可预批准（套用 B3 的标记），在子代理和定时任务中禁用；同一会话限频（例如最多 3 次）；安装后首回合，新插件的工具强制询问一次；卡片上注明“此请求由模型发起”，并展示触发它的上下文来源。

**B8. 更新与供应链：签名晚于使用、可变引用、无撤回机制**（§3.2、§3.3、§8、§9）
- 问题：
  - M1 的安装步骤 3 已经要求“官方源校验签名”，但签名到 M4 才做。M1 的“来源信任分级”依赖签名，时序颠倒。
  - Git 源可以跟随分支，被劫持后通过“每 24h 刷新 + 自动更新”静默下发。
  - “只有权限、hooks、命令变化才重新确认”这条规则漏掉了技能文本、工具描述（提示注入面）、MCP URL、WASM/Node 代码变化。
  - `npx -y pkg` 这类 stdio MCP 在运行时拉取最新版，整包哈希覆盖不到。
  - 没有防回滚/冻结攻击（旧的签名索引被重放），没有密钥轮换，没有紧急下架（kill switch）。
- 改法：签名和索引校验挪到 M1（官方源上线的前提）。索引加入 `version` 单调递增、`expires`，客户端拒绝更旧或过期的索引。预埋 2 把公钥以支持轮换，增加 `revoked` 列表，命中后强制禁用并提示；私钥不要只放普通 GitHub secret，使用受保护的 environment、人工审批，或离线签名；第三方 Git 源安装时记录解析出的 sha，更新时展示 diff 摘要，**禁止自动更新**；重新确认的触发条件改为“任何可执行面或提示面变化”，并按差异分级展示；对未钉版本的 `npx`/`uvx` 命令给出高风险警告，官方插件要求钉版本。

**B9. Hooks 的信任范围和能力边界不清**（§5.4）
- 问题：
  - 信任绑定的是“内容哈希”，但 hook 命令通常只是 `node ./hooks/x.js`。只哈希命令字符串的话，脚本被改后仍然受信。
  - `PermissionRequest` 和 `PreToolUse` hook 能返回 allow，等于第三方插件可以**替用户审批**。
  - `UserPromptSubmit` 能读到全部用户输入，并可以用 `additionalContext` 注入提示。
  - hooks 的环境变量没有定义（会不会继承 daemon 的全部环境，含 API Key？）。
- 改法：信任哈希覆盖 hook 定义加上所引用的整个插件树（或整包哈希）；非托管 hooks **只能 deny 或补充上下文，不能 allow**；hook 进程使用 `env_clear` 加白名单，在沙箱中以 daemon 用户身份运行，并留审计记录；按插件显示它订阅的事件，并对读取用户输入的 hook 做单独标注。

**B10. 凭据存储的“加密文件”回退方案不成立，也没有防 token 滥用**（§2.3、§4.6）
- 问题：
  - 无钥匙串的服务器“回退为 0600 加密文件”，但密钥放在哪里没有说。如果和密文放在同一台机器、同一个用户下，实际等同明文。
  - OAuth token 没有绑定 resource（RFC 8707），插件更新时 MCP URL 一旦变化，token 可能被发往新地址。
  - 卸载时是否撤销 token 没有说明。
- 改法：明确“0600 明文 + 显式告知”，或“由用户口令派生密钥”，二者选一（产品决策）；token 按 `(server 身份, canonical URL, resource)` 绑定，URL 或授权服务器变化时强制重新授权；卸载或登出时调用 revocation 端点；统一日志脱敏，并补一个自动化测试：在日志和工具结果中 grep token。

**B11. 数据目录和迁移会破坏现有安装**（§2.3、§3.4、§10 回归）
- 问题：
  - 新旧目录冲突（见 §0）。
  - 旧逻辑通过改写 manifest 的 `enabled` 实现启停（`manager.rs:347-407`），与“缓存只读 + 状态写 config.toml”矛盾。
  - 工具改名 `<id>.<tool>` → `plugin__tool` 后，历史会话、session 放行模式、技能 `allowed_tools` 都会失效。
  - `settings.mcp_servers` 迁到 `mcp/servers.toml` 没有说明失败回退和降级兼容。
- 改法：新增一节《迁移方案》，写明：
  - 新布局放在 `plugins/v2/`，或旧插件先迁入 `plugins/legacy/`。
  - 迁移幂等，迁移前备份，保留回滚开关。
  - 旧工具名保留别名一个大版本。
  - 降级到旧版本时的行为（至少不崩溃、不丢配置）。
  - 为以上每一条写迁移测试。

**B12. 缺少工程契约：RPC、事件、数据 schema、错误码**（全文）
- 问题：只有架构图上的 `plugin.* / marketplace.* / mcp.* / hooks.* / connector.*` 和一个事件名，没有方法清单、参数和返回值、错误码、事件载荷，也没有 `config.toml`、`state.json`、`servers.toml`、`hooks.json`、`trust.json` 的 schema 和版本号。前后端、CLI 三方无法并行开工。
- 改法：v2 附录给出：
  - 完整的 RPC 表：方法、参数、返回、错误码、远程策略（B6）、是否写审计、所属里程碑。
  - 事件表。
  - 各持久化文件的 schema，加 `schema_version`，在 `miniq-protocol` 中定义 JsonSchema 类型。
  - 这些内容作为 M1 第一周的评审产出。

---

## 2. 重要（v2 应修订，可与开工并行）

**I1. OAuth 在远程和 CLI-only 服务器上的主路径没有打通**（§4.6、§9 M2/M5）
- 问题：只装 CLI 的服务器配合手机，是方案自己点名的关键场景，但 P1 只有“粘贴回调 URL”，中继放到 M5。M2 的验收也没有覆盖远程。CIMD 需要 miniQ 托管一个 metadata URL（新的线上依赖，没有排期和负责人）。
- 改法：M2 就支持 **Device Authorization Grant**（RFC 8628，GitHub 等支持），并把粘贴回调作为兜底；中继直接复用现有的端到端加密 relay 通道（`docs/remote-access.md`），不另建服务。中继页只做 `code+state` 转发，严格校验 `state`，禁止开放重定向；PKCE verifier 只保存在 daemon；把 CIMD 托管列为基础设施任务（域名、HTTPS、变更流程）。

**I2. 工具命名存在冲突和影子风险**（§4.4、§3.4）
- 问题：`mcp__<server>__<tool>` 中的 server 名由插件自定，两个插件都叫 `github` 时会冲突，也能冒充官方连接器。McpHub 的 key 是 `plugin/server`，但工具名里没有插件信息。哈希截断后的名字可读性差。
- 改法：工具名包含插件短 id，冲突时由系统分配后缀；禁止与内置工具同名或前缀相同；审批卡始终显示“插件@市场”的真实来源；审批模式 key 使用稳定 id，而不是展示名。

**I3. “总是允许此工具”缺少作用域和失效条件**（§4.5、§7.4）
- 改法：永久放行绑定 `(插件@市场, server, tool, schema/描述哈希)`，`tools/list_changed` 导致描述或 schema 变化时自动失效（防 rug-pull）；High 或不可预批准的工具不提供“总是允许”；远程端是否可以设置永久放行，交由产品决策；设置页提供集中撤销入口，并写审计。

**I4. 提示注入面没有统一处理**（§4.4 摘要、§5.1 能力块、§4.7 resources、§5.3 技能）
- 问题：工具描述、能力块、MCP resource、技能正文都会进入系统提示或上下文，恶意描述可以直接指挥模型。
- 改法：第三方文本放在带标记的 untrusted 区块中，并设长度上限；能力块只列名称和简短描述；更新时对描述变化做 diff 提示（与 B8 联动）；安全测试集加入“投毒工具描述”用例。

**I5. MCP Apps iframe 的隔离细节不够**（§7.4，M5）
- 改法：使用 `srcdoc` 加 `sandbox="allow-scripts"`，**禁止** `allow-same-origin`、`allow-top-navigation`、`allow-popups-to-escape-sandbox`；在 Tauri v2 的 capabilities 中确认 iframe 拿不到 `__TAURI__`/IPC，并补测试；CSP `connect-src` 默认为 none，按 app 声明放行；postMessage 校验 `event.source`，消息使用 schema 校验；UI 发起的 `callTool` 一律视为模型外输入，走审批，并且不能使用“总是允许”；`sendFollowUpMessage` 需要用户可见确认，防止 UI 代替用户发言；iframe 不得覆盖审批卡区域，防点击劫持；移动端 WebView 单独验收。

**I6. stdio MCP 子进程和插件原生代码的隔离**（§4.2、§8）
- 问题：方案只做了环境变量白名单。stdio server 以用户身份运行，拥有完整的文件和网络能力；在 CLI-only 服务器上，影响面是整台服务器。
- 改法：安装确认中明确写出“等同于在本机运行该程序”；把 OS 级沙箱（landlock/seatbelt）作为 P1 调研项列入风险，不写成“不在本期”后就不再跟进；服务器场景建议给出“以低权限用户运行 daemon”的文档。

**I7. Elicitation 可被用来钓鱼**（§4.7）
- 改法：表单卡片显示 server 身份和“不要在此输入密码”的提示；字段名命中 password/token/secret 时给出警告；URL 模式先展示完整域名，由用户确认后再打开；在远程端打开的是手机浏览器，需要单独说明。

**I8. 完整性抽检的威胁边界没有写清**（§8“mtime 变化则重算”）
- 改法：明确“同用户下的本地攻击者不在威胁模型内”，抽检只用来发现损坏和误改。另外把整包哈希纳入 Node 信任和 hooks 信任，形成同一个信任根。

**I9. 里程碑之间的依赖顺序错位**（§9）
- M3 的验收用例“`@GitHub`”依赖 M4 才交付的 GitHub 连接器。应改用 M2 验收过的 Linear/Notion，或者把 GitHub 连接器提前到 M2 作为样板。
- M1 的验收用例安装 Codex 本机的 `latex`/`visualize` 捆绑插件，涉及 OpenAI 内容的许可。应改用自制的 fixture 插件。
- M4 的自动更新依赖签名，而签名应提前到 M1（见 B8）。
- M2 的“导入器”依赖 M1 的数据模型，但两者并行推进，需要先冻结 schema（B12）。

**I10. 工期与人力明显偏乐观**（§9）
- 问题：
  - M2 要求一人在 4 周内完成 rmcp 接入、HTTP、OAuth 三种注册方式、钥匙串、一等工具注册、tool_search、审批改造、resources/prompts/elicitation、日志和导入器，按经验至少需要 7–8 周。
  - M1 要求一人完成 4 种格式 loader、gix、https-archive、事务安装、回滚、resolver 和迁移，同样超载。
  - 计划中没有 QA、安全评审、设计师、运维（CDN、CIMD、中继、签名）的人力，也没有缓冲。
- 改法：按全部范围重估为 **24–28 周**，或者切出 MVP（见 §4），MVP 约 12–14 周。每个里程碑预留 15–20% 缓冲，并设安全评审闸门（M1、M2、M3 结束时各一次）。

**I11. 验收标准不可测，或缺少前置条件**（§9）
- “WASM 工具调用出现审批卡”：在默认 Auto 模式下 Medium 不询问，所以要写明审批模式。
- “模型通过 tool_search 找到工具”：要写明模型列表、成功率阈值和固定评测集（≥N 条）。
- “优先使用 GitHub 工具”：需要量化。
- 每条验收都应拆成“自动化测试名 + 手测脚本”，并列出性能指标：冷启动增加 ≤X ms、`tools/list` 预热耗时、提示词 token 增量 ≤ 2%。

**I12. 缺少发布、灰度和回滚策略**（全文）
- 改法：新增 Feature flag：`plugins_v2`、`mcp_v2`、`hooks`、`connectors`、`recommend_install`、`mcp_apps`，默认关闭，可通过设置或环境变量打开；旧 `mcp.rs` 在 flag 后保留一个版本；发布节奏：内部 → beta 渠道 → 全量；官方索引支持服务端下架，客户端提供“一键禁用所有第三方插件”的安全模式；每个里程碑写明回滚步骤。

**I13. 没有埋点或指标，无法判断成败**（全文）
- 改法：先由产品决定是否引入埋点（可以只做本地统计加用户主动上报）。最小指标集：安装漏斗（查看 → 安装 → 认证成功 → 首次调用）、OAuth 失败原因分布、MCP 连接错误率、审批拒绝率、tool_search 命中率、推荐卡接受率、hook 超时率。

**I14. 关键用户旅程存在断点**（§7、§3.5）
- CLI-only 服务器配合手机时，§7.5 的“在桌面端完成”提示是死路（没有桌面），应改为“在主机上运行 `miniq plugin trust ...`”，并给出可复制的命令。
- CLI 缺少交互式安装确认（TTY 下展示与 UI 相同的清单），`--yes` 只能在非远程、官方源时使用。缺少 `miniq hooks show`、`miniq mcp logs`、`miniq plugin doctor`，建议把这些检查并入现有的 `miniq doctor`。
- 排障：`needs_auth` 状态、token 过期、定时任务中认证失效时，如何通知用户（手机推送？）；手机上能否查看 MCP stderr。
- 更新：需要更新日志和权限差异视图，还要说明拒绝新权限时的状态（继续使用旧版本，而不是被禁用）。
- 卸载：同步清理“总是允许”规则、项目级启用记录、技能引用和 token；对正在运行的会话，下一回合生效，并给出提示。
- 首次使用：离线或国内网络下官方源的降级（七牛优先），以及官方源失败时的空状态文案。

**I15. 连接器范围存在未核实的前提**（§6.1）
- GitHub 远程 MCP 端点和授权方式没有核实，不应作为 M4 的承诺。
- 飞书是 stdio 加应用凭证，不是 OAuth，UX 上属于另一条旅程（填写凭证）。
- 改法：M2 结束前完成连接器可行性 spike，产出“可用 / 授权方式 / 是否需要 miniQ 注册 client”表，再锁定 M4 范围。

**I16. CLI 在 daemon 未运行时“直接调用库”，会绕过审计和单写者约束**（§3.5）
- 改法：写操作一律要求 daemon（自动拉起）。只读命令可以直接读文件，但必须能兼容并发写入（文件锁或原子写）。

---

## 3. 建议

- **S1** 威胁模型应单独成节，写明资产、信任边界（模型 / 插件 / MCP / relay / 手机 / 同机用户）和不在范围内的威胁，作为每次安全评审的基线。
- **S2** `~/.agents/plugins/marketplace.json` 与 Codex 共用：任何其他工具都能往里写条目。建议只读导入并按“个人源”标记，不自动信任。
- **S3** 安装大小上限 200MB 偏大，建议 50MB 并可配置；同时补充解压炸弹、文件数、路径长度、大小写不敏感文件系统冲突、Windows 保留名的测试。
- **S4** “推荐插件”默认只在用户显式询问能力时出现，并提供全局关闭开关，减少打扰和注入面。
- **S5** 审计事件需要统一 schema（安装、更新、放行、hook 执行、OAuth 授权和撤销、远程发起标记），便于用户在“安全中心”查看。
- **S6** 系统插件禁用后，应在执行器层面也拒绝调用（防止旧会话缓存的工具列表继续被调用），并补测试。
- **S7** openWorld 类工具（几乎所有 SaaS 连接器）如果一律“始终询问”，会导致审批疲劳，建议区分读和写。
- **S8** `develop-miniq-plugin` 技能、`docs/*plugins*.md`、`docs/skill-pack-format.md` 的重写应列入各里程碑的交付物，附“安全编写指南”（审批、注解、钉版本）。
- **S9** 连接器的隐私说明：数据经过哪些地方（本机直连 SaaS，miniQ 不经手），在详情页固定展示。
- **S10** 企业托管（M5）应提前预留策略评估接口，避免后期改造 executor。

---

## 4. 建议的 MVP 切分（供产品参考）

- **MVP（约 12–14 周）**：M0 修复；Agent Plugins 1.0 + `.codex-plugin` 两种格式（Claude 格式推后）；local / Git（钉 sha）/ 官方签名 https 三种来源 + 事务安装与回滚；流式 HTTP MCP + OAuth（PKCE + DCR + device flow）+ 钥匙串；一等工具注册与延迟加载；修正后的审批矩阵（B1–B3）；插件页、详情页与 `@` 提及；2–3 个核实过的连接器；从 Codex / Claude 导入 MCP。
- **后续**：hooks（先完成 B5 工作区信任）、推荐安装、resources/prompts/elicitation、系统插件化、MCP Apps、OAuth 中继、企业策略。

---

## 5. 需要产品负责人拍板的决策清单

| # | 决策 | 评审建议 |
|---|---|---|
| D1 | 第三方和未注解的 MCP 工具，在默认 Auto 模式下是否询问 | 询问（按 server 或工具各一次） |
| D2 | 是否存在任何模式都跳过不了的“不可预批准”类（破坏性、推荐安装、MCP App 发起） | 需要；FullAccess 也要询问 |
| D3 | 手机或远程端允许哪些插件操作（安装来源、hook 信任、原生代码启用、永久放行） | 远程仅限官方源安装和启停，其余在主机完成 |
| D4 | 自动更新默认值和范围 | 仅官方签名源，默认开启；第三方默认关闭且禁止自动更新 |
| D5 | 无钥匙串服务器的凭据存储 | 0600 明文 + 显式告知，或口令加密，二选一 |
| D6 | 是否建设和运维 CIMD 托管页与 OAuth 中继（域名、合规、值班） | CIMD 要建；中继复用现有 relay |
| D7 | 官方市场的上架审核流程、负责人、下架 SLA，以及是否接收第三方投稿 | 首期只上自研和白名单插件 |
| D8 | 是否引入埋点，以及采集范围和隐私告知 | 本地统计 + 可选匿名上报 |
| D9 | MVP 范围与上线时间（全量 24–28 周，或 MVP 12–14 周） | MVP |
| D10 | 是否兼容 Claude 插件格式；`allowed_tools` 采用“只收窄”语义 | 推后兼容；只收窄 |
| D11 | 项目级 hooks、插件、marketplace 是否首期开放（依赖工作区信任设计） | 首期关闭 |
| D12 | 与 Codex 共用 `~/.agents` 路径，以及是否复用对方的插件内容 | 只读导入；不复制 OpenAI 插件内容 |
| D13 | 首批连接器名单（以可行性 spike 结果为准），以及是否做 Google | 先做 Linear、Notion、GitHub（待核实）；Google 推后 |
| D14 | “推荐安装”是否默认开启 | 默认开启但保守触发，可关闭 |
| D15 | 系统插件是否允许禁用浏览器、电脑操作等能力，以及是否受企业策略控制 | 允许 |
