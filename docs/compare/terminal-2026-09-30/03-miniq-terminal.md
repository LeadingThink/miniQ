# 03 · miniQ 终端客户端现状与未暴露能力盘点

- 仓库：`/private/tmp/miniq-apple`，main @ `aa8ae29`（release 0.1.72）；本机已安装 `~/.local/bin/miniq` 0.1.68（仅运行了 help/status/sessions，未调用模型）。
- 下文路径默认相对 `crates/miniq-cli/src/`，行号以 aa8ae29 为准。
- 一句话结论：**终端是“逐行 REPL + 事件打印器”**（rustyline 读一行、stderr 打印纯文本事件）。没有 TUI、没有 Markdown/diff 渲染、没有运行中排队或 steer，审批只能“批准一次/拒绝”，斜杠命令只有 8 个。daemon 已经提供约 112 个 RPC 和完整事件流，终端实际用到的不到 20 个。

---

## 1. 终端现状清单

### 1.1 crate 结构与依赖
| 文件 | 行数 | 职责 |
|---|---|---|
| main.rs | 224 | 入口、子命令分发、exec、doctor |
| args.rs | 293 | clap 定义 |
| monitor.rs | 354 | 交互循环、事件等待、审批/问题、斜杠命令 |
| client.rs | 302 | WebSocket JSON-RPC 客户端、自动拉起 daemon、重连 |
| output.rs | 165 | 事件到文本/JSONL 的渲染 |
| sessions.rs | 246 | 会话列表/创建/恢复/发送/附件 |
| selection.rs | 183 | 编号/关键词逐行选择器 |
| listing.rs | 124 | 会话列表文本格式 |
| onboarding.rs | 137 | Key/Provider 引导 |
| bridge.rs | 173 | stdin JSONL ↔ daemon WS 桥 |
| updater.rs | 220 | 自更新 |
| launcher.rs | 119 | Windows 控制台启动器（bin `miniq-launcher`） |

- 依赖：clap 4 + clap_complete、rustyline 15、rpassword 7、tokio、tokio-tungstenite、reqwest、semver、time、tempfile，以及 miniq-local 和 miniq-protocol。
- **没有** ratatui、crossterm、termimad/pulldown-cmark、syntect、similar 等库。

### 1.2 全局参数（args.rs:55–100）
- `--data-dir`（env MINIQ_DATA_DIR）、`--daemon-path`（env MINIQ_DAEMON_PATH）、`--no-start`（args.rs:64–71）。
- ChatOptions 标了 `global = true`，所有子命令都可用（args.rs:83–99）：
  - `-C/--directory`、`--add-dir`（可多次）、`-m/--model`
  - `--effort` none|minimal|low|medium|high|xhigh|max|ultra|default
  - `--protocol` auto|responses|chat_completions|anthropic_messages
  - `-a/--attach`（最多 10 个，只接受常规文件，sessions.rs:181–189）
- 位置参数 `[PROMPT]` 作为交互模式的首条消息（args.rs:77）。

### 1.3 子命令（args.rs:105–233，分发逻辑在 main.rs:44–124）
| 子命令 | 参数 | 实现与 RPC |
|---|---|---|
| （无） | `[PROMPT]` | 要求 TTY（main.rs:126）→ onboarding → `sessions::prepare` → `monitor::interactive`（main.rs:115–118） |
| exec | `[PROMPT or -]` `--session` `--json` `-o FILE` `--use-configured-permissions`（args.rs:221–233） | main.rs:149–196 |
| resume | `SESSION_ID` / `--last` / `[message]` | 用选择器挑会话（selection.rs:127），然后进入 interactive（main.rs:63–74） |
| sessions | `--all` `--json` | workspace.list / session.list（sessions.rs:28–43）；文本输出由 listing.rs:32 生成 |
| history | `SESSION_ID --limit 1..=100(40) --before CURSOR` | session.history，打印原始 JSON（main.rs:84） |
| watch | `SESSION_ID --json` | session.open，然后 `monitor::wait(owner=false)`（main.rs:86–93） |
| cancel | `SESSION_ID` | session.cancel（main.rs:94） |
| configure | `--base-url --model` | 隐藏输入 Key，或读 MINIQ_API_KEY；调用 settings.models/get/update（onboarding.rs） |
| models | `[MODEL]` | model.list / model.describe（main.rs:98–100） |
| doctor | — | daemon.health + settings.get + computer.permissions（main.rs:198+） |
| status | — | settings.get（main.rs:103） |
| logout | — | settings.update clearApiKey（main.rs:104–110） |
| rpc | `METHOD [PARAMS or -]` | 任意 RPC 透传（main.rs:111–114），**这是目前唯一能用到其余 90 多个 RPC 的入口** |
| bridge（隐藏） | — | JSONL 桥：16 MiB 帧限制、只接受 jsonrpc 2.0、断线不重放请求（bridge.rs） |
| completions | `SHELL` | 离线生成补全（main.rs:45–48） |
| update | `--check` | updater.rs：稳定版 manifest，按平台下载预编译包；源码目录或签名 .app 内拒绝更新 |

`help/status/sessions --json` 的本机输出与上表一致。

### 1.4 交互聊天实现（monitor.rs）
| 维度 | 现状 | 证据 |
|---|---|---|
| 输入 | rustyline `DefaultEditor` 单行 readline，提示符 `miniq> `。历史只保存在内存里，不落盘 | monitor.rs:189–190, 217, 226 |
| 多行输入 | 不支持，help 里建议用 `miniq exec - < task.md` | monitor.rs:255 |
| 全屏 TUI / 状态栏 | 无。启动时打印一行 `Model: … · reasoning: …` | monitor.rs:191–202 |
| 流式输出 | `assistant_delta` 原样写到 stderr，并用 terminal_text 过滤控制字符 | output.rs:44–47, 10–15 |
| Markdown / 代码高亮 / diff | 无，只输出纯文本 | output.rs 全文 |
| 工具调用 | 只打印 `[tool id] name` 和 `[tool id] status`，不显示参数、输出和耗时 | output.rs:51–60 |
| 进度 | 显示 preparing/compacting/requesting/finalizing，以及 `[retry n/m]` 倒计时 | output.rs:61–65, 93–115 |
| 计划 | `[plan]` 加 `[x]/[>]/[ ]` 列表，每次更新都整段重印 | output.rs:66, 117–130 |
| 其他事件 | `[context compacted]`、`[artifact] {json}`、`assistant_replaced` 提示；其余事件被丢弃 | output.rs:48–50, 67–69 |
| 审批 | 打印 toolName 和原始 input JSON，然后问 `Approve once? [y/N]`，结果只有 approve 或 reject。不显示 riskLevel，也不支持 approve_for_session / always_allow_tool | monitor.rs:146–160 |
| 问题卡 | 打印 prompt 和选项，用户自由输入一行作为 answer；没有编号选择、多选或默认值 | monitor.rs:161–178 |
| 子 agent | 无专门展示。ToolCallStarted 带的 agentId 被忽略 | output.rs:51 |
| 中断 | 任务运行中 Ctrl+C：会话 owner 调 session.cancel，退出码 130；watch 模式只停止观察。空闲时 Ctrl+C/EOF 直接退出 | monitor.rs:36–44, 16 |
| 运行中排队 / steer | **不支持**。wait 期间不读取输入；发送时带 `rejectIfBusy:true`，daemon 若要求排队则直接 bail | sessions.rs:196–213 |
| 恢复进行中的会话 | 打开时如果会话非 idle，先 `wait` 到结束；按 snapshot 补处理挂起的审批和问题 | monitor.rs:203–213, 125–142 |
| 断线 | 30 秒无消息时发 health 探活；断开或 `remote_resync` 后重连并重新 open，不重发 prompt | client.rs:136–173, monitor.rs:47–56 |
| RPC 超时 | 60 秒，超时提示“outcome unknown” | client.rs:81, 106 |

### 1.5 斜杠命令（全部，monitor.rs:244–292）
| 命令 | 行为 |
|---|---|
| `/help` | 静态帮助（monitor.rs:254–256） |
| `/model [ID]` | 无参数时进入逐行搜索选择器；有参数时直接设置。调用 session.modelUpdate（monitor.rs:275, 296–323） |
| `/effort [LEVEL]` | 从 model.describe 取 reasoningEfforts 供选择（monitor.rs:325–354） |
| `/attach PATH` | 追加到下一条消息的附件（monitor.rs:258–270） |
| `/clear-attachments` | 清空待发附件（monitor.rs:271） |
| `/status` | 打印 session.modelGet 的原始 JSON（monitor.rs:276–285） |
| `/history` | 打印 session.history 的原始 JSON |
| `/exit` `/quit` | 退出，会话保留（monitor.rs:253） |

没有 Tab 补全、斜杠菜单，也不能用 `@` 提及文件。

### 1.6 exec 输出、JSON 事件与退出码
- 纯文本模式：进度和流式内容写 stderr，stdout 只输出最终答复；非 TTY 时保留原文不过滤（output.rs:82–89）。stdin 会被追加为 `[stdin]` 段（main.rs:133–147）。`-o` 只在成功时 create_new，不会覆盖已有文件（main.rs:153–160, 180–190）。
- 无人值守保护：默认要求 approvalMode 为 alwaysAsk，否则必须显式传 `--use-configured-permissions`（sessions.rs:218–229, main.rs:161–166）。注意本机当前是 `fullAccess`。
- `--json`（exec/watch）输出 JSONL：
  - `cli_snapshot {sessionId, snapshot}`：watch 或重连时输出（monitor.rs:89–94）
  - daemon 原始事件，逐条透传（output.rs:30–32）
  - `cli_result {sessionId, exitCode, status: completed|incomplete, text, error}`（output.rs:74–81）
  - `cli_error {exitCode:1, error}`：预检失败时输出（main.rs:32–37）
- 退出码：

  | 码 | 含义 | 证据 |
  |---|---|---|
  | 0 | turn_completed，或 lastTurn=completed | monitor.rs:59, 114 |
  | 1 | turn_failed，session failed，或错误 | monitor.rs:60–70, 104–110 |
  | 3 | 非交互模式下需要审批或回答问题 | monitor.rs:71–75, 125–128 |
  | 130 | 取消或 Ctrl+C | monitor.rs:43, 66, 115 |

- 缺失能力：没有 `--output-schema`、`--max-turns`、`--sandbox/--approval` 这类单次覆盖参数，也没有 `--ephemeral`；exec 不支持 `--resume --last`（只有 `--session ID`）；JSON 事件没有 schema 版本号。

---

## 2. daemon 已有、终端未暴露的能力

gateway.rs 共路由 112 个方法（grep 结果）。终端直接用到的有：
- daemon.health
- settings.get/update/models
- workspace.open/list
- session.list/create/open/sendMessage/history/cancel/modelGet/modelUpdate
- model.list/describe
- approval.resolve（只用 approve 和 reject）、question.resolve
- computer.permissions
- workspace.updateRoots

下表列出其余能力，以及终端可以怎样利用：

| 能力 | RPC / 事件 | 终端可做的事 |
|---|---|---|
| 运行中排队 / 插话 | sendMessage 在 `rejectIfBusy:false` 时排队并发 `queue_changed`（gateway/session.rs:186–200）；session.queueList/Update/Remove/Move/Steer（steer 会 promote 并 cancel 当前 turn，session_queue.rs:117） | 任务运行中仍可输入：Enter 排队，Ctrl+Enter/Tab 立即 steer；在状态区显示队列，并提供 `/queue` 管理 |
| 暂停/恢复 | session.pause / session.resume | `/pause`、`/resume`，或 Esc 暂停 |
| 审批分级 | approval.resolve 取值 approve / approve_for_session / always_allow_tool / reject（interaction.rs:61–66）；ApprovalRequested 带 riskLevel；approval.rules.list/revoke；approval.inbox；session.approval.get/update（SessionApprovalChanged） | 四选一审批面板并按风险着色；`/permissions` 切换会话审批模式；`/approvals` 查看跨会话收件箱；管理或撤销始终允许规则 |
| 回退 / 检查点 | checkpoint.rollback(checkpointId)，session.rewriteMessage（SessionRewritten） | `/undo`、`/rewind`，以及 Esc Esc 编辑上一条消息（对标 Claude Code） |
| 分叉 | session.fork | `/fork` |
| 改动 diff | session.diff（返回 SessionDiff/FileDiff/DiffHunk） | `/diff` 着色统一 diff；turn 结束后打印变更摘要 |
| 目标 | session.goal.get/update，SessionGoalChanged | `/goal`，并在状态栏显示 |
| token / 上下文用量 | session.modelCalls（ModelCallRecord：estimated_input_tokens、advertised_context_tokens、usage input/output/cache，execution.rs:111），TurnTimingChanged（TurnSummary：tool_calls/failed/files_changed/duration_ms），ContextCompacted（before/after） | 状态栏显示上下文百分比、token 与费用；`/cost`、`/context`；turn 结束后打印摘要行 |
| 执行轨迹 | session.executionEvents，tool.detail | `/trace`；展开单个工具调用的完整输入输出（Ctrl+O） |
| 子 agent | agent.list/history/output/stop/message；ToolCallStarted.agentId；agent 事件中的 queuedMessages | `/agents` 面板，查看子 agent 输出，停止或发消息 |
| 会话管理 | session.rename/delete/setPinned/setArchived/search/sync/acknowledgeFailure | `/rename`、`/archive`、`miniq sessions --search`、`miniq rm`；失败会话可 acknowledge 后继续 |
| 分享 | session.shareCreate/List/Revoke | `/share` |
| 工作区 | workspace.create/rename/delete/modelGet/modelUpdate/updateRoots | `/add-dir`（目前只能在启动时用 `--add-dir`），项目级默认模型 |
| 设置 | settings.schema/status/restoreBackup，features.get/set，SettingsLoadFailed | `miniq config get/set`，由 schema 驱动的 `/settings` |
| 模型 | model.update | 模型别名/元数据 |
| 工具 / MCP / 插件 / 技能 | tool.list；mcp.list/update；plugin.list/install/uninstall/setEnabled/reload/getDiagnostics；skill.list/read/save/import/delete/setEnabled/distill/refine | `/mcp`、`/plugins`、`/skills`、`/tools`；技能作为斜杠命令（对标 Claude Code 的自定义命令） |
| 记忆 | memory.list/delete | `/memory` |
| 定时任务 | schedule.list/create/update/delete/toggle/runNow/runs | `miniq schedule …` |
| 导入外部会话 | externalSession.scan/scanStatus/import/importStatus | `miniq import`（导入 Codex/Claude Code 会话） |
| 文件 | file.list/read/describe | `@` 文件补全和预览 |
| 语音 | voice.capabilities/transcribe/speak | 可选 |
| 浏览器 / 电脑操作 | browser.resolve，BrowserDriverRequested，computer.requestPermission，observation.read | 终端提示“需要桌面端处理”，或降级处理 |
| SSH 主机 | host.list/save/remove/connect/disconnect/call，host_event / host_changed | `miniq host …`，远程工作区 |
| 远程 | remote.status | 在 status 中显示手机端连接数（settings.get 已部分包含） |
| 状态事件 | SessionStatusChanged、TurnProgressChanged、QueueChanged、SessionRenamed、PluginsChanged、Model/Workspace/GlobalModelSettingsChanged 等 | 这些都在推送，但 output.rs 只处理约 9 种；可用来驱动实时状态栏，并同步显示桌面端的改名、换模型等操作 |

---

## 3. 桌面端有、终端没有的交互
- 键盘体系（apps/desktop/src/shortcuts.ts:71–97）：命令面板 ⌘K、会话切换（⌘⇧[ ]、⌃Tab、⌘1–9）、“下一个需处理”⌘⌥A、⌘. 停止、会话内搜索 ⌘F、复制为 Markdown。终端只有 Ctrl+C。
- 斜杠命令：
  - composerCommands.ts：切换项目、置顶、归档、查看改动、提炼技能、重命名、新建、搜索、设置、技能、MCP、插件、定时任务、导入会话
  - useAppSlashCommands.tsx：浏览器、任务模板、分享、模型调用与用量
  - 另有 modelSlashCommands.ts、useSlashSkills.ts，以及 composerSlash.ts 定义的分组菜单
- 输入：Shift+Enter 换行、ArrowUp 历史（composerInput.ts:32）、`@` 文件提及（composerMention.ts）、附件拖放、语音。
- 运行中控制：pause/resume/queueSteer/queueMove（hooks/useMiniqApp.ts:453–491），以及队列 UI。
- 时间线交互（TimelineInteractions.tsx）：审批四选项、fork、rewrite、rollback，工具详情展开。
- 其他：目标栏（SessionGoalBar.tsx）、diff 面板（useSessionDiff.ts）、ApprovalInbox、会话导出 md/json（sessionExport.ts）、未读/已读状态、Markdown 与代码渲染、子 agent 展示。

---

## 4. 架构约束

### 4.1 连接与鉴权
- 读取 `<data-dir>/daemon.json` 中的 {port, token}（miniq-local/src/lib.rs:44），然后连接 `ws://127.0.0.1:{port}/ws?token=…`，握手超时 5 秒（client.rs:30–35）。daemon 只绑定 127.0.0.1（miniq-daemon/src/server.rs:26–27），token 由 query 参数校验（server.rs:48–56）。
- 握手后调用 daemon.health 校验 protocolVersion，并读取 `capabilities.rejectBusy`（client.rs:52–55）。
- 连接不上时自动拉起 daemon：unix 下 process_group(0)，Windows 下 DETACHED+NEW_PROCESS_GROUP，保证终端 Ctrl+C 不会波及 daemon（client.rs:187–240）。如果检测到存活但不兼容的 daemon，不会再启动第二个（client.rs:194–199）。
- **与桌面实时同步：可以。** 每个 WS 连接都订阅全量 live_events 广播（server.rs:66–67）。终端在客户端侧按 sessionId 过滤，并用 eventCursor 去重（client.rs:110–116, 175）。桌面、手机、终端操作的是同一 daemon、同一会话。目前终端只是“单会话视角”，没有利用全局事件（例如其他会话需要审批）。

### 4.2 引入 ratatui + crossterm 的可行性
- 可行，且风险可控：协议层（client.rs）与渲染层（output.rs/monitor.rs）已经基本分离，事件都是 serde_json::Value。
- 主要改动点：
  1. monitor.rs 的 `wait` 目前是“阻塞等事件、期间不读输入”的顺序模型。需要改成 `tokio::select!{ 键盘事件(crossterm EventStream), daemon 事件, tick }` 的单一事件循环，Client 需要拆成读写两半或放到独立任务里，用 channel 通信。
  2. output.rs 需要改成 state + view：维护消息、工具、计划、队列、审批等状态，可以直接复用 session.open 返回的 snapshot 结构。
  3. 审批和问题卡改为模态组件；selection.rs 改为可滚动列表。
  4. rustyline 可保留给 `--no-tui` 或非 TTY 降级；rpassword 保留。
  5. 新增 Markdown（pulldown-cmark）、高亮（syntect，体积较大，可选 feature）、diff 着色。
- 必须保留的不变量：
  - 非 TTY 和 exec 路径保持现有行为：stdout 只输出最终答复，JSONL 契约不变。
  - terminal_text 注入防护。
  - Ctrl+C 语义：owner 取消，watcher 不取消。
  - 断线不重发 prompt。
  - 退出码 0/1/3/130。

### 4.3 平台兼容
- Windows：已有 launcher.rs（SetConsoleCtrlHandler），CI 会构建 miniq.exe（.github/workflows/build.yml:58–72）。crossterm 原生支持 Windows Terminal/ConPTY，比 rustyline 更统一。
- Linux：只依赖 127.0.0.1 WS 和 data-dir，无额外依赖。CI 按 matrix target 运行 `cargo test -p miniq-cli -p miniq-local`（build.yml:60–62）。
- SSH：终端通过本机 daemon 工作，远程机器需要安装并运行它自己的 daemon。TUI 需要注意 TERM/颜色降级、窄终端和无鼠标环境。daemon 自带 host.*（SSH 主机）能力，但终端尚未暴露。

### 4.4 测试现状
- 集成测试：
  - tests/terminal.rs 共 10 个用例：非交互缺 Key、管道拒绝交互、JSON 管道、stdout 纯净、退出码不重发、拒绝隐式 fullAccess 与旧 daemon、恢复会话审批覆盖、JSONL 预检错误、`-o` 不覆盖等（terminal.rs:180–384）
  - tests/bridge.rs 共 4 个用例
  - tests/support/terminal_pty.rs 用 `/usr/bin/script` 伪造 PTY（第 5、16 行），**只能在 macOS/BSD 上跑**，Linux 版 `script` 参数不同
- 单元测试：listing.rs、selection.rs、sessions.rs、client.rs:274/287（进程组、snapshot 游标去重）。
- 缺口：
  - 没有渲染快照测试（引入 ratatui 后可以用 `TestBackend` 加 insta）
  - 没有斜杠命令和审批交互的 PTY 用例
  - 没有 Windows 交互测试

---

## 5. 对标优先级建议（供后续文档使用）
1. **P0**：事件循环重构（运行中可输入）→ 排队、steer、pause；审批四选项和 riskLevel；多行输入；Markdown 与 diff 渲染；状态栏（模型、上下文百分比、token、队列、审批模式）。
2. **P1**：`/diff`、`/undo`（checkpoint/rewrite）、`/fork`、`/rename`、`/permissions`、`/cost`、`/agents`、`@` 文件补全、斜杠菜单与 Tab 补全、工具详情展开、子 agent 视图、落盘历史（可选）。
3. **P2**：把 `rpc` 中的高频能力提升为一等子命令（mcp/plugins/skills/schedule/import/host/share/config）；exec 增加 `--resume-last`、`--output-schema`、JSON schema 版本；Linux PTY 测试。
