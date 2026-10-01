# OpenAI Codex CLI 功能、用法与交互调研（miniQ 终端对标 · 01）

- 调研基准：`/Applications/ChatGPT.app/Contents/Resources/codex`，**codex-cli 0.153.4**（Mach-O arm64，约 220MB）
- 对照版本：`/opt/homebrew/bin/codex`，codex-cli 0.144.1（差异见 §6）
- 调研方式：只读。没有裸跑 TUI；需要执行的 `--help` 均用 `perl -e 'alarm 10; exec @ARGV'` 限时 10 秒。`~/.codex` 只看了目录结构和键名，没有读取任何密钥或 token。
- **证据来源标记**
  - **[H]**：0.153.4 的 `--help` 输出，存档在 `/tmp/cli-cmp/codex-help.txt`、`codex-sub.txt`
  - **[S]**：二进制 strings，存档在 `/tmp/cli-cmp/codex-strings.txt`
  - **[D:xxx]**：官方文档 `https://learn.chatgpt.com/docs/xxx.md`，本地存档在 `/tmp/cli-cmp/docs/`
  - **[G:path]**：GitHub `openai/codex` main 分支源码 `codex-rs/<path>`。**main 比 0.153.4 新**：凡是 [S] 查不到的条目，都标注"main 新增"。
  - **[L]**：本机 `~/.codex` 的结构和键名

---

## 1. 顶层命令、子命令与全局参数

### 1.1 子命令

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| （无子命令） | `codex [PROMPT]` | 进入交互式 TUI；如果给了 PROMPT，就作为首条消息 | [H] |
| `exec`（别名 `e`） | `codex exec [PROMPT\|-]` | 非交互执行。`-` 表示从 stdin 读 prompt；也可以写 prompt 再用管道追加 stdin。子命令有 `exec resume [--last\|ID]` 和 `exec review` | [H] [D:noninteractive] |
| `review` | `codex review [PROMPT\|-] --uncommitted \| --base <BR> \| --commit <SHA> [--title]` | 非交互代码审查。`--uncommitted` 覆盖 staged、unstaged 和 untracked | [H] |
| `resume` | `codex resume [SESSION_ID] [PROMPT] [--last] [--all] [--include-non-interactive]` | 默认弹出会话 picker。`--last` 直接接上最近一次会话；`--all` 不按 cwd 过滤；`--include-non-interactive` 把 exec 会话也列进来 | [H] |
| `fork` | `codex fork [ID] [--last]` | 从历史会话分叉出新会话，默认弹 picker | [H] |
| `archive` / `unarchive` / `delete` | `codex archive <ID\|名称>` | 按 id 或会话名归档、恢复或删除 | [H] |
| `queue` | `codex queue --thread <UUID\|名称> --message <TEXT> [-i IMG]` | 往一个已存在的会话**排队追加消息**，适合外部脚本投递任务（0.153 新增） | [H] |
| `agents` | `codex agents [--remote ...] [-C DIR]` | 浏览共享本地 app-server daemon 上的所有 agent 会话（0.153 新增） | [H] |
| `migrate-rollouts` | `codex migrate-rollouts [--apply] [--thread ID] [--json] [--max-mib-per-second N]` | 把旧版会话迁移到分页 thread history。不加 `--apply` 时只出报告 | [H] |
| `login` / `logout` | `codex login` | 支持 ChatGPT 账号登录和 API key 登录 | [H] |
| `mcp` | `codex mcp list\|get\|add\|remove\|login\|logout` | 管理 MCP server，`login` 用于 OAuth 登录 | [H] |
| `mcp-server` | `codex mcp-server` | 把 Codex 自身作为 stdio MCP server 暴露出去 | [H] |
| `plugin` | `codex plugin marketplace add\|list\|upgrade\|remove` | marketplace 可以是本地目录或 Git 仓库。`upgrade` 刷新 Git 快照 | [H] |
| `app-server` / `remote-control` | `codex app-server`，`codex remote-control` | 两者均为 experimental。app-server 是 TUI、IDE 和桌面 app 共用的后端；remote-control 管理支持远程控制的 daemon | [H] |
| `app` | `codex app` | 启动桌面 app | [H] |
| `cloud` | `codex cloud` | EXPERIMENTAL，云端任务 | [H] |
| `exec-server` | — | EXPERIMENTAL | [H] |
| `apply` | `codex apply <TASK>` | 把最新一次 diff 以 `git apply` 的方式应用到本地 | [H] |
| `completion` | `codex completion bash\|zsh\|fish\|elvish\|powershell` | zsh 需要先执行 `compinit`，否则报 `command not found: compdef` | [H] [D:cli-customization] |
| `update` | `codex update` | 自更新 | [H] |
| `doctor` | `codex doctor` | 诊断安装、配置、认证和运行时 | [H] |
| `sandbox` | `codex sandbox macos\|linux\|windows -- CMD` | 在 Codex 沙箱（seatbelt / Landlock / Windows）中运行任意命令，便于调试策略 | [H] |
| `debug` | `codex debug models\|app-server\|prompt-input` | `models` 输出原始模型目录 JSON；`prompt-input` 输出模型实际看到的 prompt 输入 JSON | [H] |
| `features` | `codex features list` | 列出 feature flag 及其阶段（stable、experimental、removed）和默认值 | [H] |
| `execpolicy` | `codex execpolicy check ...` | 校验 `.rules` 命令策略 | [D:developer-commands] |

### 1.2 全局参数（TUI 与多数子命令共用）

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| `-c/--config` | `-c key=value`（可重复） | 用点路径覆盖嵌套值；值按 TOML 解析，解析失败就当字符串 | [H] |
| `--enable/--disable` | `--enable <FEATURE>` | 等价于 `-c features.<name>=true/false` | [H] |
| `-p/--profile` | `-p work` | 在基础配置上叠加 `$CODEX_HOME/work.config.toml` | [H] [D:config-advanced] |
| `-m/--model`、`--oss`、`--local-provider lmstudio\|ollama` | — | 切换模型，或改用本地开源模型 | [H] |
| `-s/--sandbox` | `read-only\|workspace-write\|danger-full-access` | — | [H] |
| `-a/--ask-for-approval` | `on-request\|never` | `untrusted` 已不再支持 | [H] [D:developer-commands] |
| `--approve-for-me` | — | 审批交给 auto-review 处理，同时使用 workspace-write（0.153 新增） | [H] |
| `--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`） | — | 既不走沙箱也不审批 | [H] [D:agent-approvals-security] |
| `--dangerously-bypass-hook-trust` | — | 本次运行跳过 hook 信任校验 | [H] [D:hooks] |
| `-C/--cd`、`--add-dir` | `--add-dir ../lib` | 追加可写目录。在 read-only 下会提示 "Ignoring --add-dir … Switch to workspace-write or danger-full-access" | [H] [S] |
| `-i/--image` | `-i a.png b.png` | 给首条 prompt 附图 | [H] |
| `--search` | — | 启用原生 web_search，调用时不再逐次审批 | [H] |
| `--no-alt-screen` | — | inline 模式，保留终端 scrollback；对应 `tui.alternate_screen = "never"` | [H] [D:config-advanced] |
| `--remote`、`--remote-auth-token-env` | `--remote ws://h:p\|wss://\|unix://PATH` | TUI 连接远端 app-server；token 从环境变量读取 | [H] |
| `--strict-config` | — | 配置里有未知字段时直接报错 | [H] |

---

## 2. 交互式 TUI

### 2.1 布局

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| 主体 | 默认启动 | 使用 alt-screen 全屏。上方是 transcript（消息、工具调用、diff），下方是 composer 输入框，底部是 footer/status line | [S] [D:config-advanced] |
| Composer 占位 | — | 空闲时显示 "Ask Codex to do anything"，有上下文时显示 "Ask a follow-up question" | [S] |
| Footer 提示 | 按 `?` 展开快捷键面板 | 常驻 "for shortcuts"，另有 "% context left"、"tokens used"、"Worked for …"（本轮耗时） | [S] [G:tui/src/keymap.rs] |
| 状态行 | `/statusline` | 可交互挑选并排序 footer 字段（model、context、limits、git、tokens、session），写入 `tui.status_line` | [D:developer-commands] |
| 终端标题 | `/title` | 可选 project、status、thread、branch、model、task progress，写入 `tui.terminal_title` | [D:developer-commands] |
| 主题 | `/theme` | 代码块和 diff 语法高亮，支持实时预览，写入 `tui.theme`。自定义主题放到 `$CODEX_HOME/themes/*.tmTheme` | [D:cli-customization] |
| 宠物 | `/pets`（别名 `/pet`） | 终端里的 ambient pet，纯装饰 | [D:developer-commands] |
| Raw 模式 | `/raw` 或 Alt+R | 切换为 raw scrollback，方便在终端里直接选中复制；对应 `tui.raw_output_mode` | [S] [G:keymap.rs] |
| 动画与提示 | `tui.animations`、`tui.show_tooltips` | 控制 shimmer 动画和欢迎页 tips | [D:config-advanced] |

### 2.2 斜杠命令

输入 `/` 弹出过滤列表，列表顺序即枚举顺序，常用命令排在前面。任务运行中输入斜杠命令后按 **Tab** 可排队到下一轮执行，命令在真正执行时才解析 [D:developer-commands]。下表中"运行中可用"一列取自源码 `available_during_task`，"内联参数"一列取自 `supports_inline_args` [G:tui/src/slash_command.rs]。

| 命令 | 功能（原文或意译） | 运行中可用 | 内联参数 | 证据 |
|---|---|---|---|---|
| `/model` | choose what model and reasoning effort to use | ✓ | | [S] |
| `/fast` | 切换 Fast 服务档位并持久化 | — | | [D] |
| `/personality` | choose a communication style | — | | [S] [D] |
| `/ide` | include current selection, open files… from your IDE | ✓ | ✓ | [S] |
| `/permissions` | choose what Codex is allowed to do（例如 Auto 与 Read Only 之间切换） | ✓ | | [S] [D] |
| `/approve` | approve one retry of a recent auto-review denial | ✓ | | [S] |
| `/keymap` | remap TUI shortcuts | ✗ | ✓ | [S] |
| `/vim` | toggle Vim mode for the composer | ✗ | | [S] |
| `/setup-default-sandbox`、`/sandbox-add-read-dir <abs>` | Windows 提权沙箱；给沙箱追加可读目录 | ✗ | | [S] [D] |
| `/experimental` | 切换实验特性，例如 Network proxy、Prevent sleep | ✗ | | [S] [D] |
| `/memories` | 配置记忆的使用与生成 | ✗ | | [D] |
| `/skills` | 浏览并使用 skills | ✓ | | [D] |
| `/import` | import setup, this project, and recent chats from Claude Code（文档还写了 Cursor） | ✗ | | [S] [D] |
| `/hooks` | 查看并管理生命周期 hook，包括信任新增或改动过的 hook | ✓ | | [S] [D:hooks] |
| `/review` | review my current changes and find issues | ✗ | ✓ | [S] |
| `/rename` | rename the current thread | ✓ | ✓ | [S] |
| `/new`、`/clear` | 新建对话；清屏并新建对话 | ✗ | ✓ | [S] |
| `/resume`、`/fork` | 恢复已保存的对话；分叉当前对话 | resume ✓ / fork ✗ | ✓ | [S] |
| `/archive`、`/delete` | 归档或永久删除当前会话，然后退出 | ✗ | | [S] |
| `/app` | continue this session in the Desktop app | ✓ | | [S] |
| `/init` | 生成 AGENTS.md 骨架 | ✗ | | [S] |
| `/compact` | 压缩上下文，避免触顶 | ✗ | | [S] |
| `/recap` | summarize the current conversation now | ✗ | | [S] |
| `/plan [prompt]` | 切换到 Plan 模式，可以顺带发送 prompt | ✗ | ✓ | [S] [D] |
| `/goal` | 为长任务设置、编辑、暂停、恢复、查看或清除目标（"Goal paused (/goal resume)"） | ✓ | ✓ | [S] [D] |
| `/agent`（别名 `/subagents`） | 在本会话的子 agent 线程之间切换 | ✓ | | [S] [D] |
| `/side`、`/btw` | 在临时 fork 中开一段旁路对话，Ctrl+C 返回主线 | ✓ | ✓ | [S] |
| `/copy` | 复制最新回复、代码块或引用（等同 Ctrl+O） | ✓ | | [S] |
| `/export` | 把对话导出为 Markdown | ✗ | ✓ | [S] |
| `/raw` | 切换 raw scrollback | ✓ | ✓ | [S] |
| `/diff` | 显示 git diff，包含 untracked 文件 | ✓ | | [S] |
| `/mention` | 附加文件或目录 | ✓ | | [S] [D] |
| `/status` | 显示当前会话配置（模型、审批、可写根）和 token 用量 | ✓ | | [S] [D] |
| `/usage` | 查看账户用量，或使用一次限额重置 | ✓ | ✓ | [S] |
| `/debug-config` | 显示配置层与 requirements 来源 | ✓ | | [S] |
| `/cd`、`/pwd`（别名 `/cwd`） | 切换或显示工作目录 | cd ✗ / pwd ✓ | ✓ | [S] [G] |
| `/statusline`、`/title`、`/theme`、`/pets` | 界面个性化 | ✓ / ✓ / ✗ / ✗ | pets ✓ | [S] |
| `/mcp [verbose\|login <name>]` | 列出 MCP 工具 | ✓ | ✓ | [S] [D] |
| `/apps` | 浏览 apps（connector），以 `$app-slug` 形式插入 prompt | ✓ | | [D] |
| `/plugins` | 浏览插件 | ✓ | | [D] |
| `/ps`、`/stop`（别名 `/clean`） | 列出或停止后台终端（长驻命令） | ✓ | | [S] [G] |
| `/feedback` | 上传日志 | ✓ | | [D] |
| `/logout`、`/quit`、`/exit` | 登出、退出 | quit ✓ | | [S] |
| `/rollout` | 打印 rollout 文件路径 | ✓ | | [S] [G] |
| `/test-approval` | 调试用：触发一次审批弹层 | ✓ | | [S] |

main 分支新增、0.153.4 二进制里还没有的命令：`/worktree`（在新 worktree 中开始或继续对话）、`/voice`、`/daemon`、`/warnings`、`/tui`（下次启动的 TUI 模式），以及 `/agents`（agent command center）[G:slash_command.rs]。

### 2.3 快捷键

主表是 0.153.4 的默认键位。来源为 `built_in_defaults` [G:tui/src/keymap.rs]，并已用 [S] 核对相应 action 名存在；[S] 中缺失的会注明"main 新增"。所有键位都可以在 `tui.keymap.<context>.<action>` 下重映射，写空列表 `[]` 表示解绑；`ctrl-z` 保留给挂起。

| 上下文 | 动作 | 默认键 | 交互细节 |
|---|---|---|---|
| composer | 提交 / 排队 | Enter / Tab | 空闲时 Tab 与 Enter 等价，运行中 Tab 排队（"Tab to queue a message when a task is running"）[S] |
| composer | 换行 | Shift+Enter、Ctrl+J（部分终端下 Enter 也会被识别为换行） | 多行输入 |
| composer | 快捷键面板 | `?` | |
| composer | 历史搜索 | Ctrl+R（上一个）/ Ctrl+S（下一个） | 按 Enter 采用，Esc 取消 [D] |
| composer | 草稿历史 | ↑ / ↓ | [D] |
| composer | 外部编辑器 | Ctrl+G | 优先 `$VISUAL`，其次 `$EDITOR`，保存后回填 [D:cli-customization] |
| editor | Emacs 风格编辑 | Ctrl+A/E/B/F/P/N、Ctrl+U/K 删到行首/行尾、Ctrl+Y yank、Alt+B/F 或 Ctrl/Alt+←→ 按词移动、Alt/Ctrl+Backspace 删词 | |
| chat | 中断当前轮 | Esc（Ctrl+C 也可以） | 运行中按 Enter = steer，把新指令注入当前轮；"to interrupt and send immediately" [S] [D] |
| chat | 回溯编辑 | 空 composer 时连按两次 Esc | 编辑上一条用户消息并从该点 fork："Esc to step back and edit your last message; Enter confirms." [S] [D] |
| chat | 推理强度 | Alt+, / Shift+↓ 降低，Alt+. / Shift+↑ 提高 | footer 显示 "reasoning down/up" [S] |
| chat | 切换模式 | Shift+Tab | 在 Default 与 Plan 之间循环（"shift+tab to cycle"）[S] |
| chat | 编辑已排队消息 | Shift+← / Alt+↑ | "Messages to be submitted after next tool call" [S] |
| app | Transcript 全屏 | Ctrl+T | pager 内：j/k、Ctrl+U/D 半页、Home/End、`/` 或 F3 搜索、q 退出 [S] |
| app | 复制最新回复 | Ctrl+O | 以 Markdown 形式复制。tmux 下依赖 `Ms` capability 转发剪贴板 [S] |
| app | 清屏 | Ctrl+L | 任务进行中禁用（"Ctrl+L is disabled while a task is in progress."）[S] |
| app | Raw 模式 | Alt+R | [G] |
| app | 旁路对话 | Ctrl+/（Ctrl+7 为同一键的别名） | [G] [S] |
| approval | 审批热键 | y 同意，a 本会话同意，p 同前缀命令同意，d 拒绝，n/Esc 放弃，c 取消，o 打开线程 | [G] [S] |
| list/picker | 导航 | ↑↓、PgUp/PgDn、Ctrl+B/F、Home/End、Enter 确认、Esc 取消 | |
| 表单/问卷 | 切换问题 | Ctrl+P / Ctrl+N | "ctrl + p / ctrl + n change question" [S] |
| vim 模式 | `/vim` 开启，或设 `tui.vim_mode_default` | 支持 normal、insert、operator（d/y/c）、文本对象（iw、a"…）、u/Ctrl+R、`.` 重复 | [G] |
| 退出 | Ctrl+C（composer 为空时）或 `/exit` | — | [D] |

main 新增、[S] 中找不到的动作：F3 `find_transcript`、F4 `focus_activity`、F2 `open_warnings`、F8 语音，以及 `skip_question`（Ctrl+]）。

### 2.4 输入增强

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| `@` 文件搜索 | 输入 `@foo` | 在工作区内模糊搜索，选中后把路径插入 prompt（footer 提示 "for file paths"） | [D] [S] |
| `!` shell 命令 | `!ls -la` | 本地执行，受当前审批和沙箱约束，输出进入 transcript（"for shell commands"） | [D] [S] |
| `$` 引用 app/skill | `$app-slug` | 由 `/apps`、skills 插入 | [D] |
| 图片 | 直接粘贴，或 `-i` | 剪贴板里有图片时提示 "Ctrl+V to attach it"，显示 "paste image:"；支持拖入路径 | [S] [D:image-inputs] |
| 多行 | Shift+Enter / Ctrl+J / Ctrl+G | 长粘贴会被折叠为占位符 | [G] |
| 排队与 steer | 运行中 Tab 或 Enter | Tab 进入队列，本轮结束后发送；Enter 注入当前轮。review/compact 轮不允许 steer（"cannot steer a review turn"） | [S] [D] |
| 历史 | `~/.codex/history.jsonl` | Ctrl+R 反向搜索。`history.persistence`、`history.max_bytes` 可调 | [L] [D] |

### 2.5 输出渲染与审批

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| Markdown 渲染 | 自动 | 标题、列表、代码块语法高亮（主题可选）。`/copy` 取回 Markdown 原文 | [D] |
| Diff 渲染 | 文件修改项和 `/diff` | 彩色统一 diff，带语法高亮 | [D:cli-customization] |
| 推理显示 | `hide_agent_reasoning`、`show_raw_agent_reasoning` | 可隐藏推理或显示原始推理 | [D:config-reference] |
| 命令审批弹层 | 命令需要越权时 | "Would you like to run the following command?" 选项：Yes, proceed / Yes, and don't ask again for commands that start with `…` / …this command in this session / No, and tell Codex what to do differently | [S] |
| 文件与网络审批 | — | "Yes, and don't ask again for these files"、"Yes, and allow this host in…"（会持久化成网络规则） | [S] |
| 权限申请弹层 | 模型请求额外权限 | "Would you like to grant these permissions?" 选项：本轮 / 本轮并启用严格 auto review / 本会话 / No, continue without permissions | [S] |
| MCP elicitation | MCP 请求信息 | Yes, provide the requested info / No, but continue without it / Cancel this request | [S] |
| Auto-review | `approvals_reviewer = "auto_review"` 或 `--approve-for-me` | 由审查 agent 自动裁决，被拒绝的操作可以用 `/approve` 重试一次，超时有提示 | [D:sandboxing_auto-review] [S] |
| 计划 / todo | 模型调用计划工具 | transcript 中显示步骤清单（Pending、In progress、Completed）；exec 下对应 `todo_list` item | [S] [G:exec_events.rs] |
| Plan 模式 | `/plan` 或 Shift+Tab | 结束时询问 "Implement this plan?"，可选 "Yes, implement this plan"（切回 Default 并开始编码）或 "No, stay in Plan mode" | [S] |
| Token 用量 | footer 和 `/status` | 显示 "% context left" 和 "tokens used"；`/usage` 显示账户额度 | [S] [D] |
| 通知 | `tui.notifications`、`tui.notification_method`、`tui.notification_condition` | `auto` 时优先 OSC 9 桌面通知；`notify = ["prog", ...]` 在 `agent-turn-complete` 时执行外部程序，JSON 作为 argv[1] 传入 | [D:config-advanced] |
| 后台终端 | 长驻命令 | 由 unified_exec 管理，`/ps` 查看、`/stop` 停止 | [S] [D] |

---

## 3. 配置体系

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| config.toml | `~/.codex/config.toml`（`CODEX_HOME` 可改位置） | 加载优先级：CLI flag 与 `-c` > 项目 `.codex/config.toml`（仅受信任项目）> profile > 用户配置 | [D:config-basic] |
| 项目配置限制 | — | 项目层不能覆盖 `openai_base_url`、`chatgpt_base_url`、`model_provider(s)`、`notify`、`profile(s)`、`otel` 等 | [D:config-advanced] |
| profile | `-p name` | 读取独立文件 `$CODEX_HOME/name.config.toml`（顶层键，不再用 `[profiles.x]`） | [H] [D] |
| `/debug-config` | — | 查看各配置层和 requirements（MDM、云端托管）来源 | [S] |
| AGENTS.md | 全局 `~/.codex/AGENTS.md`，项目中从 git root 到 cwd 逐层查找 | 同一目录内 `AGENTS.override.md` 优先，只取第一个非空文件；从根往下拼接，越近的越后，覆盖力越强；总量上限 `project_doc_max_bytes`（默认 32 KiB）；可用 `project_doc_fallback_filenames` 添加备用文件名；每次运行只构建一次；`/init` 生成骨架 | [D:agent-configuration_agents-md] |
| Rules（命令策略） | `~/.codex/rules/*.rules` | Starlark 风格，例如 `prefix_rule(pattern=[...], decision="allow")`。审批时选 "don't ask again for commands that start with…" 会自动写入；`codex execpolicy check` 可校验；exec 下 `--ignore-rules` 可跳过 | [L] [D:agent-configuration_rules] |
| Skills | `~/.codex/skills/<name>/SKILL.md`（可带 references、agents） | 系统内置 skill 位于 `skills/.system/`（review-agent、skill-creator、plugin-creator）；支持 `/skills` 和 `$` 引用；`skill_search` 默认开启 | [L] [D:skills] |
| 自定义 prompts | — | 本机没有 `~/.codex/prompts/`，当前文档也没有提到，可以视为已被 skills 取代 | [L] |
| Hooks | `hooks.json`，或在 config.toml 中写 `[hooks]`（用户、项目、插件、托管各一层） | 事件：SessionStart、SessionEnd、SubagentStart、SubagentStop、PreToolUse、PostToolUse、PermissionRequest、PreCompact、PostCompact、UserPromptSubmit、Stop、Interrupt。层级关系为"事件 → matcher → handler（`command`、`timeout`、`statusMessage`）"。各层叠加而不是互相替换；非托管 hook 需要在 `/hooks` 中按 hash 信任，内容变更后要重新信任 | [D:hooks] |
| MCP | `[mcp_servers.<id>]`，可配 `command`、`args`、`env`、`url`、`bearer_token_env_var`、`http_headers`、`enabled_tools`、`disabled_tools`、`startup_timeout_sec`、`tool_timeout_sec`、`required`、`tools.<t>.approval_mode`，以及 OAuth 相关项 | 支持 stdio 和 HTTP；`codex mcp add`、`codex mcp login` 管理；`/mcp verbose` 查看；设了 `required = true` 的 server 初始化失败时 exec 退出 | [D:config-reference] [D:noninteractive] |
| Plugins / Apps | `codex plugin marketplace …`、`/plugins`、`/apps` | 插件可以打包 skills、hooks、MCP | [H] [D] |
| Features | `[features]`、`--enable`、`/experimental` | stable 且默认开启：hooks、goals、fast_mode、guardian_approval、multi_agent、plugins、personality、shell_snapshot、unified_exec、view_image、image_generation、skill_search、tool_suggest、mentions_v2。memories 为 stable 但默认关闭。network_proxy 为 experimental。steer 已合入主干 | [H] |
| Keymap | `[tui.keymap.<context>]`，`action = ["ctrl-a","shift-enter"]` | 支持两段和弦（如 `ctrl-x ctrl-s`）。上下文包括 global、app、chat、composer、editor、vim_*、pager、list、approval；同一上下文内有冲突时报错并给出配置路径 | [S] [G] |
| Shell 环境 | `shell_environment_policy.{inherit,include_only,exclude,set,ignore_default_excludes}` | 控制子进程继承的环境变量（有一组默认排除规则，可用 `ignore_default_excludes` 关闭；具体规则本次没有核实） | [D:config-reference] |
| 沙箱 × 审批 | `-s`，`-a`，或 `/permissions` | 见下表 | [D:agent-approvals-security] |
| 权限 profile | `default_permissions`、`[permissions.<name>]` | `extends` 可以继承 `:read-only` 或 `:workspace`；`filesystem."<path>" = read\|write\|deny`，deny 优先；`network.enabled` 与 `network.domains` 白名单需要开启 network_proxy | [D:permissions] |

**沙箱 × 审批预设**（摘自 [D:agent-approvals-security] 中的表）

| 意图 | Flags | 效果 |
|---|---|---|
| Auto（默认预设） | 不加参数，等同 `-s workspace-write -a on-request` | 可读写工作区并运行命令；越界操作或联网时询问 |
| 只读浏览 | `-s read-only -a on-request` | 只读，需要写入时询问 |
| 只读 CI | `-s read-only -a never` | 只读，从不询问 |
| Auto-review | `-s workspace-write -a on-request -c approvals_reviewer=auto_review`，或 `--approve-for-me` | 边界与 Auto 相同，审批交给审查 agent |
| 完全放开 | `--dangerously-bypass-approvals-and-sandbox`（`--yolo`） | 无沙箱、无审批，只建议在隔离 VM 中使用 |

---

## 4. 会话管理

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| 存储 | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | 每行包含 `timestamp`、`ordinal`、`type`、`payload`。type 取值：`session_meta`（含 cwd、git、cli_version、model_provider、source 等）、`turn_context`、`response_item`、`event_msg`、`token_usage_record`、`world_state` | [L] |
| 索引 | `session_index.jsonl`（id、thread_name、updated_at） | 用于会话名查找和 picker 展示 | [L] |
| 恢复 | `codex resume` / `--last` / `<ID>`，`/resume` | picker 默认只显示当前 cwd 下的交互会话；`--all` 显示全部，`--include-non-interactive` 包含 exec 会话；可用 `tui.resume_cwd` 配置 | [H] [D] |
| 分叉 | `codex fork`、`/fork`，或空 composer 下连按两次 Esc 回溯 | 回溯会从选中的历史消息处分叉 | [H] [D] |
| 旁路 | `/side`、`/btw` | ephemeral fork，不污染主线，Ctrl+C 返回 | [S] |
| 命名 | `/rename`，或命令行 `archive <名称>` 等 | 会话名可以代替 id 使用 | [H] |
| 归档与删除 | `codex archive/unarchive/delete`、`/archive`、`/delete` | 归档后移到 `archived_sessions/`；删除会连同后代会话一起删掉 | [H] [L] [D] |
| 外部投递 | `codex queue --thread X --message ...` | 给正在运行或已存在的会话排队消息 | [H] |
| 多 agent | `/agent`，`codex agents` | 子 agent 线程可切换；daemon 模式下可浏览所有会话 | [H] [S] |
| 导出 | `/export`、`/copy`、`/rollout` | 导出 Markdown，或打印 rollout 路径 | [S] |
| 压缩 | `/compact`，自动 compact | 触发 PreCompact/PostCompact hook | [S] [D:hooks] |
| 迁移 | `codex migrate-rollouts [--apply]` | 迁移旧格式会话 | [H] |
| 不落盘 | `exec --ephemeral` | 不写 rollout | [H] |
| 切到桌面 app | `/app`，`codex app` | 在桌面 app 中继续同一会话 | [S] [H] |

---

## 5. exec 自动化

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| 基本用法 | `codex exec "fix lint"`，`cat x \| codex exec -` | 默认要求在 git 仓库内，`--skip-git-repo-check` 可跳过；进度输出到 stderr，最终消息输出到 stdout | [H] [D:noninteractive] |
| JSONL 事件流 | `--json` | 顶层事件：`thread.started{thread_id}`、`turn.started`、`turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`、`turn.failed{error}`、`item.started`、`item.updated`、`item.completed`、`error` | [G:exec/src/exec_events.rs] [D] |
| item 类型 | — | `agent_message`、`reasoning`、`command_execution`（command、aggregated_output、exit_code、status）、`file_change`（changes、status）、`mcp_tool_call`、`web_search`、`todo_list`（items[{text,completed}]）、`error` | [G] [D] |
| 最终消息 | `-o/--output-last-message FILE` | 与 `--json` 搭配最适合 CI | [H] [D] |
| 结构化输出 | `--output-schema schema.json` | 最终回复会符合给定的 JSON Schema | [H] [D] |
| 续跑 | `codex exec resume --last "..."`，或 `exec resume <ID>` | 在自动化流水线中多步接力 | [D:noninteractive] |
| 审查 | `codex exec review`，`codex review --base main` | CI 代码审查 | [H] |
| 隔离 | `--ephemeral`、`--ignore-user-config`、`--ignore-rules` | 让运行结果可复现 | [H] |
| 权限 | exec 默认 read-only，可加 `-s workspace-write` 或 `--approve-for-me` | 非交互时无法人工审批 | [D:noninteractive] |
| 退出码 | — | 文档没有给出退出码表。可以确认的只有：MCP `required` server 初始化失败时报错退出；失败信息通过 `turn.failed` / `error` 事件给出。其余行为需要实测 | [D:noninteractive] |
| 其他 | `--color auto\|always\|never`、`-i` 附图、`--thread-source` | — | [H] |

---

## 6. 版本差异：0.144.1 → 0.153.4

对比两版 `--help` 的结果：

- 新增子命令：`agents`、`queue`、`migrate-rollouts`
- 新增全局参数：`--approve-for-me`
- 其他子命令和参数一致

与 GitHub main 相比，0.153.4 还没有这些斜杠命令：`/worktree`、`/voice`、`/daemon`、`/warnings`、`/tui`、`/agents`。

演进方向：多会话/daemon 化（agents、queue、remote），审批自动化（auto-review），以及会话存储分页化。

---

## 7. 对终端用户最有价值的前 25 项（供 miniQ 对标排序）

| # | 功能 | 价值理由 | miniQ 对标建议 |
|---|---|---|---|
| 1 | 沙箱 × 审批预设（Auto、Read Only、Full）加 `/permissions` 运行中切换 | 安全和效率的核心平衡点 | 必备 |
| 2 | 审批弹层分级选项（仅本次、本会话、同前缀命令）并持久化到 rules | 显著减少重复打断 | 必备 |
| 3 | 运行中按 Enter steer、按 Tab 排队，Esc 中断 | 不用等当前轮结束就能纠偏 | 必备 |
| 4 | `codex resume --last` 和 picker、`/resume` | 跨终端会话延续 | 必备 |
| 5 | `@` 文件模糊搜索 | 精确喂上下文，成本低 | 必备 |
| 6 | `exec --json` JSONL 事件流 | 脚本和 CI 集成的基础 | 必备 |
| 7 | AGENTS.md 分层加载、override、`/init` | 项目级长期指令 | 必备 |
| 8 | 空 composer 连按两次 Esc 回溯编辑并 fork | 改错 prompt 不必重开 | 高 |
| 9 | `/compact` 和 footer 的 "% context left" | 长会话不爆上下文 | 高 |
| 10 | `/diff` 与彩色语法高亮 diff | 审阅改动 | 高 |
| 11 | `!` 前缀执行 shell | 不离开会话就能跑命令 | 高 |
| 12 | Ctrl+T transcript pager，支持搜索 | 回看长输出 | 高 |
| 13 | Ctrl+O / `/copy` 复制 Markdown，`/raw` 便于选中 | 解决 TUI 复制难的问题 | 高 |
| 14 | `--output-schema` 与 `-o` | 自动化中的结构化结果 | 高 |
| 15 | MCP 管理：`codex mcp add/login`、`/mcp` | 扩展工具生态 | 高 |
| 16 | Hooks：12 个生命周期事件，带信任机制 | 团队策略和自动化 | 高 |
| 17 | `/plan` 与 Shift+Tab 模式切换，"Implement this plan?" 确认 | 先规划后执行 | 高 |
| 18 | Ctrl+R 历史搜索，↑↓ 草稿历史 | 输入效率 | 中高 |
| 19 | 图片粘贴（Ctrl+V）和 `-i` | 截图报错、UI 还原 | 中高 |
| 20 | `codex review --base/--uncommitted`、`/review` | 自带代码审查 | 中高 |
| 21 | `-c key=value` 覆盖、profile 文件、`/debug-config` | 配置可调试 | 中 |
| 22 | Skills（SKILL.md）与 `$` 引用 | 可复用能力包 | 中 |
| 23 | `tui.keymap` 全量重映射加 `/vim` 模式 | 满足重度用户习惯 | 中 |
| 24 | 通知：OSC 9 与 `notify` 外部程序 | 长任务完成提醒 | 中 |
| 25 | `/side`、`/btw` 旁路对话，`/fork` | 临时提问不污染主线 | 中 |

次一档候选：`/statusline`、`/title` 可配置状态栏，Ctrl+G 外部编辑器，`/goal` 长任务目标，`/ps`、`/stop` 后台终端，`codex queue` 外部投递，`--no-alt-screen` inline 模式。
