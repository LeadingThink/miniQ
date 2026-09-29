# miniQ 终端 CLI 对标总报告（Codex 0.153.4 / Claude Code 2.1.234 / miniQ 0.1.72）

详细素材：
- [01-codex-cli.md](01-codex-cli.md)：Codex 逐项清单，前 25 项
- [02-claude-code.md](02-claude-code.md)：Claude Code 逐项清单（约 115 条斜杠命令），前 25 项
- [03-miniq-terminal.md](03-miniq-terminal.md)：miniQ 终端现状、daemon 已有但终端未暴露的能力

## 1. 总体判断

miniQ 的 daemon 能力（排队 / steer、审批分级、diff、fork、rewrite、goal、上下文压缩、模型调用记录、MCP / skills / plugins）已接近桌面端，但终端只是“读一行 → 发送 → 阻塞等待”的 REPL：
- 任务运行时不能输入；
- 审批只能 y/N；
- 问题卡不能选选项；
- 输出为纯文本，没有 Markdown 或 diff 渲染；
- 没有状态栏和上下文用量；
- 斜杠命令只有 8 个。

Codex 和 Claude Code 的共同核心是：运行中可继续输入（排队或打断）、分级权限、`@` 文件引用、`!` shell、会话恢复与分叉、`/diff`、`/compact`、状态栏、headless JSON 输出与 schema 输出。

结论：终端的差距主要在交互层，而不是能力层。本轮不改 daemon 协议，只在 CLI 层暴露已有能力。

## 2. 逐项差距矩阵（✓ 已有，△ 部分，✗ 缺失 → 本轮目标）

| # | 功能 | Codex | Claude Code | miniQ 0.1.72 | 本轮 |
|---|---|---|---|---|---|
| 1 | 运行中继续输入：Enter 排队，Tab/steer 打断并插入，Esc 中断 | ✓ | ✓ | ✗（阻塞） | P0 |
| 2 | 审批分级：一次 / 本会话 / 总是允许该工具 / 拒绝，并显示风险和参数 | ✓ | ✓ | △ y/N | P0 |
| 3 | 权限模式切换：`/permissions`、Shift+Tab、`--approval`/`--permission-mode` 参数 | ✓ | ✓ | ✗ | P0 |
| 4 | 问题卡选项选择 | ✓ | ✓ | △ 只能自由输入 | P0 |
| 5 | 多行输入（Shift/Alt+Enter、`\`+Enter、粘贴） | ✓ | ✓ | ✗ | P0 |
| 6 | Markdown / 代码块 / diff 着色渲染 | ✓ | ✓ | ✗ | P0 |
| 7 | 状态栏：模型、effort、上下文用量、token、队列、审批模式 | ✓ | ✓ | ✗ | P0 |
| 8 | 工具调用显示参数摘要和结果摘要 | ✓ | ✓ | △ 只显示 id/name | P0 |
| 9 | `/diff` 本会话改动 | ✓ | △ | ✗（daemon 有 session.diff） | P1 |
| 10 | `/resume` `/new` `/fork` `/rename` | ✓ | ✓ | △ 只能在 shell 中 resume | P1 |
| 11 | `/compact` 与上下文百分比 | ✓ | ✓ | ✗ | P1 |
| 12 | `/copy` 复制上条回复 | ✓ | ✓ | ✗ | P1 |
| 13 | `/init` 生成 AGENTS.md | ✓ | ✓（CLAUDE.md） | ✗ | P1 |
| 14 | `@` 文件模糊补全 | ✓ | ✓ | ✗ | P1 |
| 15 | `!` 直接执行 shell | ✓ | ✓ | ✗ | P1 |
| 16 | 斜杠命令 Tab 补全与菜单 | ✓ | ✓ | ✗ | P1 |
| 17 | 历史持久化与 Ctrl+R | ✓ | ✓ | △ 进程内 | P1（可关闭） |
| 18 | `/goal` `/plan` `/cost` `/usage` `/agents` `/mcp` `/skills` `/status` | ✓ | ✓ | △ /status | P1 |
| 19 | `/undo` / rewind（checkpoint 回滚） | △ | ✓ | ✗ | P2（daemon 有 rewrite） |
| 20 | headless：`--output-schema`/`--json-schema`、stream JSON、`--max-turns` | ✓ | ✓ | △ `--json`/`-o` | P1 |
| 21 | `-c/--continue`、`exec resume --last` | ✓ | ✓ | △ | P1 |
| 22 | `mcp` / `plugins` / `skills` / `config` / `doctor` 一等子命令 | ✓ | ✓ | ✗（仅 rpc） | P2 |
| 23 | Ctrl+G 外部编辑器 | ✓ | ✓ | ✗ | P1 |
| 24 | 完成通知（响铃 / OSC 9） | ✓ | ✓ | ✗ | P2 |
| 25 | Hooks、keymap、vim、statusline 自定义、IDE 集成 | ✓ | ✓ | ✗ | 后续（需 daemon 设计） |

## 3. 实施方案

分两条互不冲突的线：

- **A. 交互层（`crates/miniq-cli/src/repl/*`）**：用 crossterm 实现行编辑器和事件单循环，按 inline 方式运行，不占用 alt screen，保留终端滚动历史，对应 Codex `--no-alt-screen` 和 Claude Code 的默认形态。覆盖矩阵第 1–18、23、24 项。
- **B. 非交互层（args / exec / 子命令）**：覆盖第 3 项的启动参数和第 20–22 项。

约束（沿用 0.1.72）：
- exec 和非 TTY 行为及退出码（0 / 1 / 3 / 130）不变；
- 模型和文件文本在进入终端前过滤控制字符；
- 历史文件只存用户输入（不存模型输出和密钥），可用 `MINIQ_NO_HISTORY=1` 关闭。

## 4. 实施结果

集成分支 `cli-parity`：`38eab0e`（B 线）、`c3d710f`（daemon mcp 修复）、`a0e0b46` + `f294ecf`（A 线）、`97adf48`（合并与 RPC 字段对齐）。**daemon 协议未新增任何方法**。

### 4.1 逐项落地

| # | 结果 | 说明 |
|---|---|---|
| 1 | ✓ | 运行中按 Enter 排队（`rejectIfBusy:false`），Tab 或 `/steer` 调 `session.queueSteer`，Esc/Ctrl+C 调 `session.cancel`；`/queue`、`/queue rm ID` |
| 2 | ✓ | 审批卡可按 1 一次 / 2 本会话 / 3 总是允许该工具 / 4 拒绝，y/n 为快捷键；显示工具名和参数摘要 |
| 3 | ✓ | `/permissions`（别名 `/approvals`）、Shift+Tab 循环 alwaysAsk → auto → fullAccess；启动参数 `--approval`（别名 `--permission-mode`）、`--full-auto`、`--dangerously-bypass-approvals` |
| 4 | ✓ | 问题卡可输入序号或自由文本 |
| 5 | ✓ | Shift+Enter / Alt+Enter / 行尾 `\` 换行，Ctrl+J 提交，bracketed paste |
| 6 | ✓ | 流式 Markdown、代码块、diff 着色 |
| 7 | △ | 状态栏显示模型、effort、审批模式、附件、队列；**上下文百分比未做**（daemon 未提供窗口占用） |
| 8 | ✓ | 工具卡片显示参数摘要和结果摘要 |
| 9–10 | ✓ | `/diff` `/new` `/resume` `/fork`（从最后一条助手回复分叉）`/rename`；CLI 子命令 `diff` `fork` `rename` |
| 11 | ✗ | `/compact` 未做：daemon 没有手动压缩 RPC |
| 12–16 | ✓ | `/copy`（OSC52 / pbcopy / wl-copy / xclip）、`/init`、`@` 路径补全（已存在的文件作为附件）、`!cmd` 本地执行（输出不发给模型）、斜杠命令 Tab 补全 |
| 17 | ✓ | 历史持久化在 `<数据目录>/cli_history`，Ctrl+R 搜索，`MINIQ_NO_HISTORY=1` 关闭，疑似密钥的输入不写入 |
| 18 | ✓ | `/goal [文本\|pause\|resume\|done\|clear]`（保留 token 预算）、`/usage`（别名 `/cost`，按供应商原始 usage 字段汇总，缺失时单独计数，不当作 0）、`/mcp`、`/skills`（包含项目技能）、`/agents`、`/status` |
| 19 | ✗ | `/undo` 未做：没有按回合回滚的 RPC |
| 20 | △ | `--output-format text\|json\|stream-json`、`--output-schema`（别名 `--json-schema`，不符合时退出码 1，报告字段路径）；**`--max-turns` 未做**（sendMessage 不支持） |
| 21 | ✓ | `-c/--continue`、`-p/--print`、`exec --resume-last`、`exec resume [ID\|--last] [prompt]` |
| 22 | ✓ | `mcp list/get/add/remove`、`skills`、`plugins`、`config get/set`（密钥显示为 `****`，set 不能改 key）、`doctor`；列表默认输出表格，`--json` 输出 JSON |
| 23–24 | ✓ | Ctrl+G 打开 `$EDITOR`；回合超过 10 秒时响铃并发送 OSC 9 |
| 25 | ✗ | Hooks、keymap、vim 模式、statusline 自定义、IDE 集成留到后续 |

附带修复：`mcp.update` 以前会清空未回传 env 的其他服务器的 env（`mcp.list` 不返回 env）。现在未携带 env 的条目会保留原有 env，并补充了测试。

### 4.2 验证

- `cargo test -p miniq-cli -p miniq-daemon -p miniq-local` 全部通过；`cargo clippy -p miniq-cli --all-targets --no-deps -D warnings` 通过；`cargo fmt` 通过。
- 真实 PTY 冒烟测试 [pty_smoke.py](pty_smoke.py)，使用隔离数据目录，17/17 通过：启动、`/he` Tab 补全、`/help`、`/permissions`、Shift+Tab、`/goal` 设置/暂停/查看、`@` 补全、`!cmd`、Alt+Enter 多行、历史回溯、`/skills`、`/usage`、双击 Ctrl+C 退出、历史落盘。
- 真实模型 PTY 测试 [pty_live.py](pty_live.py)（隔离数据目录，只复制 provider，关闭远程访问，审批模式 alwaysAsk）：
  - 第一轮：Enter 排队并在当前回合后执行、Tab steer 生效、Esc 中断，全部通过。
  - 第二轮：审批卡（风险等级、参数、四个选项）→ 按 1 → 文件实际写入；问题卡 `1. Apple / 2. Banana` → 输入 2 → 模型收到 Banana；`/usage` 显示真实调用（5 次，60692 输入 / 44800 cached / 83 输出）。7/7 通过。
  - 发现并修复：审批卡原本在批准前就显示过去时的 “Edited file_write”，现改为 “file_write: 路径”。
  - 说明：低风险命令（如 `echo`）在 alwaysAsk 下也不弹审批，这是 daemon 的既有策略，不是 CLI 问题。
- REPL 用到的 20 个 RPC 已逐个对照 daemon 的参数和返回结构：approval / question / queue / goal / fork / skill / modelCalls。

### 4.3 未做与风险

- **未做**：上下文百分比、`/compact`、`/undo`、`--max-turns`、Hooks/keymap/vim。前三项需要 daemon 新增能力。
- **未端到端验证**：审批的 2/3/4 选项（本会话 / 总是允许 / 拒绝）只核对了 RPC 取值，没有逐一实跑；问题卡处于等待状态时，输入的 `/命令` 会被当作答案提交。
- `--full-auto` 在 miniQ 中等于 full-access，比 Codex 同名参数（workspace-write + on-request）更激进，help 中已标注 RISK。
- `config set` 会整组提交 provider 设置，桌面端同时修改时可能互相覆盖。
- 终端宽度变化时，状态栏重绘可能有残留。
- 首次运行（未配置）时，`miniq -m MODEL` 仍会弹出模型选择；需要改用 `miniq configure --model MODEL`（沿用 0.1.72 的行为）。
