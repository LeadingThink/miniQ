# Claude Code CLI 2.1.234 功能盘点（miniQ 终端对标用）

- 盘点对象：`/Users/xuzhanwei/.local/bin/claude` → `~/.local/share/claude/versions/2.1.234`
- 调研日期：2026-09-30
- 调研方式：只读。没有裸跑 `claude`，也没有跑 `claude -p`；只跑了 `--help` 类命令，没有修改任何配置。
- 证据来源缩写：
  - **[help]**：`claude --help` / 子命令 `--help`，存于 `/tmp/cli-cmp/claude-help.txt`、`claude-sub.txt`
  - **[bin]**：二进制 `strings -n 6`，存于 `/tmp/cli-cmp/cc-strings.txt`（命令注册表、快捷键绑定表、settings schema、内置 "Recently changed surfaces" 文档）
  - **[doc:xxx]**：官方文档 `https://code.claude.com/docs/en/xxx.md`，已下载到 `/tmp/cli-cmp/cc-docs/`
  - **[local]**：本机 `~/.claude/` 目录结构和键名（未读取任何值或密钥）
- 注意：官方文档是在线最新版，部分条目标注的版本高于本机 2.1.234（如 v2.1.246、v2.1.257、v2.1.275）。凡是只有文档出处、没有 [bin] 或 [help] 旁证的项目，本机不一定可用。

---

## 1. 顶层命令与参数

### 1.1 子命令 [help]

| 名称 | 用法 | 交互细节 | 证据 |
|---|---|---|---|
| `agents` | `claude agents [options]` | 管理后台 agent（background agents / 后台会话） | [help] |
| `auth` | `claude auth …` | 认证管理（login/logout/status 等） | [help] |
| `auto-mode` | `claude auto-mode …` | 查看或重置 auto 模式分类器的配置 | [help] |
| `doctor` | `claude doctor` | 健康检查。会读取当前目录的 settings，不弹 trust 提示；完整检查和修复用会话内的 `/doctor` | [help] |
| `gateway` | `claude gateway` | 企业版认证/遥测网关 | [help] |
| `import` | `claude import [source]` | 从其他 AI 编码代理导入配置（codex / gemini / cursor），支持 `--dry-run`、`--yes` | [help][doc:commands] |
| `install` | `claude install [stable\|latest\|<ver>]` | 安装原生构建 | [help] |
| `mcp` | `claude mcp add/list/get/remove/serve…` | 配置 MCP；`mcp serve` 把 Claude Code 自身作为 MCP server 暴露 | [help] |
| `plugin` / `plugins` | `claude plugin install/marketplace …` | 插件与 marketplace 管理 | [help] |
| `project` | `claude project …` | 管理项目状态 | [help] |
| `setup-token` | `claude setup-token` | 生成长期认证 token（需要订阅） | [help] |
| `ultrareview` | `claude ultrareview [PR\|branch]` | 云端多代理代码评审，打印评审结果 | [help] |
| `update` / `upgrade` | `claude update` | 检查并安装更新 | [help] |

### 1.2 顶层参数 [help][doc:cli-reference]

完整列表：`--add-dir --agent --agents --allow-dangerously-skip-permissions --allowed(Tools) --append-system-prompt(-file) --autocompact --ax-screen-reader --bg --bare --betas --brief --chrome --cloud -c/--continue --dangerously-skip-permissions -d/--debug --debug-file --disable-slash-commands --disallowed(Tools) --effort --environment --exclude-dynamic-system-prompt-sections --fallback-model --file --fork-session --forward-subagent-text --from-pr --ide --include-hook-events --include-partial-messages --input-format --json-schema --max-budget-usd --mcp-config --model -n/--name --no-chrome --no-session-persistence --output-format --permission-mode --plugin-dir --plugin-url -p/--print --prompt-suggestions --remote-control/--rc --remote-control-session-name-prefix --replay-user-messages -r/--resume --safe-mode --session-id --setting-sources --settings --strict-mcp-config --system-prompt(-file) --teleport --tmux --tools --verbose -v/--version -w/--worktree`

下表按用途分组列出重点参数：

| 类别 | 参数 | 说明 |
|---|---|---|
| 会话 | `-c`、`-r [id\|name]`、`--fork-session`、`--session-id <uuid>`、`-n/--name`、`--no-session-persistence`、`--from-pr` | 继续最近会话、恢复指定会话、分叉会话；`--from-pr` 按 PR 过滤会话选择器 |
| 模型 | `--model`（别名如 opus、sonnet）、`--fallback-model`、`--effort low..max`、`--betas` | `--fallback-model` 在主模型过载时自动降级 |
| 权限 | `--permission-mode`（manual/default、acceptEdits、plan、auto、dontAsk、bypassPermissions）、`--allowedTools`、`--disallowedTools`、`--tools`、`--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`、`--permission-prompt-tool`、`--permission-prompts` | `--tools ""` 禁用全部内置工具 |
| 上下文 | `--add-dir`、`--system-prompt(-file)`、`--append-system-prompt(-file)`、`--system-prompt-snapshot off`、`--exclude-dynamic-system-prompt-sections`、`--autocompact` | 可替换或追加系统提示词 |
| 扩展 | `--agents <json>`、`--agent`、`--mcp-config`、`--strict-mcp-config`、`--plugin-dir`、`--plugin-url`、`--settings`、`--setting-sources user,project,local`、`--disable-slash-commands` | |
| 非交互 | `-p`、`--output-format text\|json\|stream-json`、`--input-format text\|stream-json`、`--json-schema`、`--include-partial-messages`、`--include-hook-events`、`--replay-user-messages`、`--max-turns`、`--max-budget-usd`、`--bare`、`--init`、`--init-only`、`--maintenance`、`--prompt-suggestions`、`--forward-subagent-text` | 见第 11 节 |
| 隔离/远程 | `-w/--worktree [name]`（位于 `<repo>/.claude/worktrees/<name>`）、`--tmux`（需配合 `-w`；iTerm2 下用原生分屏）、`--cloud`（旧名 `--remote`）、`--environment`、`--ref`、`--teleport`、`--remote-control`、`--bg` | worktree 与云端会话是一等公民 |
| 排障 | `-d/--debug [filter]`、`--debug-file`、`--verbose`、`--safe-mode`（禁用全部自定义项）、`--restricted`、`--ax-screen-reader` | |
| IDE/浏览器 | `--ide`、`--chrome`、`--no-chrome` | |
| 已移除 | `--enable-auto-mode`（v2.1.111 移除，改用 `--permission-mode auto`） | [bin][doc] |

---

## 2. 交互界面布局与全部斜杠命令

### 2.1 界面布局 [doc:interactive-mode][bin]

- **主区域**：对话流，工具调用会折叠显示。`Ctrl+O` 打开 transcript 全量视图。
- **提示输入框**：
  - 输入框下方显示模式指示：Manual / accept edits / plan / auto / bypass，vim 模式下还会显示 `-- INSERT --`。
  - 输入框颜色可用 `/color` 设置，会话名可用 `/rename` 设置。
- **footer 区域**：可选中的条目（subagent 面板、后台任务、PR 状态等），用 ↑↓ 选择，`Esc` 取消选择。
- **statusLine**：自定义状态行，位于输入框下方（见第 8 节）。
- **可切换面板**：
  - `Ctrl+T` 任务清单（todo）
  - `/diff` 差异面板或查看器
  - `/focus` 专注视图：只显示最后一条 prompt、工具一行摘要和最终回复
  - `/btw` 旁路提问：临时问一句，不进入主对话
  - brief 视图：`Ctrl+Shift+B`
- **渲染器**：`/tui default|fullscreen`，fullscreen 模式下 transcript 有更多操作。
- **其他**：
  - 等待时显示 spinner 和提示语（可用 `spinnerTipsEnabled` / `spinnerVerbs` 配置）。
  - 限流时可以等待重置后自动继续。
  - 会话 recap：离开后回来时自动生成一行摘要。
  - 输入时支持拼写检查、emoji 短码（`:`）和不可见字符提示。

### 2.2 斜杠命令全表 [doc:commands] 交叉验证 [bin]

交叉验证方法：[bin] 注册表中 type 为 local、local-jsx 或 prompt 的命令已逐一对照；标 **Skill** 的是内置 skill，也可以用 `/` 调用。

| 命令 | 用法 / 说明 |
|---|---|
| `/add-dir <path>` | 本会话新增可访问目录 |
| `/advisor [model\|off]` | 开启 advisor 工具，在关键节点咨询第二个模型 |
| `/agents` | v2.1.198 起只提示“让 Claude 创建或管理 subagent”（[bin] 标为 removed） |
| `/artifacts` | 列出、附加、打开 artifact |
| `/auto-mode-setup` | 根据项目和历史会话起草 `autoMode.environment` |
| `/autocompact [auto\|<tokens>]` | 设置自动压缩阈值 |
| `/autofix-pr [prompt]` | 云端会话盯住 PR，CI 失败或有评论时自动推送修复 |
| `/background [prompt]`、`/stop` | 把当前会话转为后台 agent，释放终端；`/stop` 停止后台会话 |
| `/batch <instruction>` | **Skill**：大规模并行改动，每个 worktree 代理各开一个 PR |
| `/branch [name]` | 在当前点分叉对话并切换过去，原会话不变 |
| `/btw [question]` | 旁路提问，不写入主对话 |
| `/bug`、`/feedback [report]` | 反馈 / 报 bug，可选择附带多少会话历史 |
| `/cd <path>` | 把会话迁到新的工作目录，保留对话 |
| `/chrome` | Claude in Chrome 设置 |
| `/claude-api [...]` | **Skill**：Claude API / Managed Agents 参考 |
| `/clear [name]`（别名 reset、new） | 用空上下文开新会话，旧会话留在磁盘上，可 `/resume` |
| `/code-review`、`/review [low..max\|ultra] [--fix]` | **Skill**：评审当前 diff、PR、分支或路径 |
| `/color [color\|default]` | 设置输入框颜色 |
| `/compact [instructions]` | 总结压缩上下文，可附加关注点 |
| `/config [key=value …]` | 设置界面：主题、模型、输出风格、Editor mode（vim）等 |
| `/context [all]` | 用彩色网格可视化上下文占用，并给出优化建议 |
| `/copy [N]` | 复制最近第 N 条回复 |
| `/cost`、`/stats` | `/usage` 的别名 |
| `/dataviz`、`/design`、`/design-sync`、`/design-login`、`/slides` | 设计 / 可视化类 skill |
| `/debug [description]` | **Skill**：开启 debug 日志并排查问题 |
| `/deep-research <q>` | **Workflow**：多路搜索后交叉验证 |
| `/desktop`（别名 app） | 在 Claude Desktop 中继续当前会话 |
| `/diff` | 工作区改动加逐轮 diff 查看器 |
| `/doctor [prompt-audit]`（别名 checkup） | 体检加修复：安装、冗余扩展、臃肿的 memory、慢 hook、权限等 |
| `/effort [level\|auto\|status\|ultracode]` | 设置思考强度 |
| `/exit`（别名 quit） | 退出；在后台会话中则为 detach |
| `/export [filename]` | 导出为纯文本文件或复制到剪贴板 |
| `/fast [on\|off]` | 快速模式 |
| `/fewer-permission-prompts` | **Skill**：扫描历史，为常用只读命令生成 allow 规则 |
| `/focus` | 专注视图 |
| `/fork [prompt]` | 把对话复制到新的后台会话，当前会话继续 |
| `/goal [condition\|clear]` | 设定目标，跨轮持续工作直到满足条件 |
| `/heapdump` | 导出 JS 堆快照 |
| `/help` | 帮助 |
| `/hooks` | 查看 hook 配置 |
| `/ide [open]` | IDE 集成状态和连接 |
| `/import [codex\|gemini\|cursor]` | 导入其他工具的配置 |
| `/init` | 生成 CLAUDE.md；设 `CLAUDE_CODE_NEW_INIT=1` 时为交互式流程，并可附带 skills/hooks |
| `/insights` | 生成近期会话分析 HTML 报告 |
| `/install-github-app`、`/install-slack-app` | 安装 GitHub App（可顺带配 Actions）或 Slack App |
| `/keybindings` | 打开 `~/.claude/keybindings.json` |
| `/list-agents` | 列出可通信的 subagent、teammate 和会话 |
| `/login`、`/logout` | 登录、登出或切换账号 |
| `/loop [interval] [prompt]`（别名 proactive） | **Skill**：按间隔重复执行；不给间隔时由模型自定节奏 |
| `/loops` | 管理 loop |
| `/mcp [reconnect\|enable\|disable]` | MCP 连接和 OAuth |
| `/memory` | 编辑 CLAUDE.md，开关或查看 auto memory |
| `/mobile`（别名 ios、android） | 显示下载 App 的二维码 |
| `/model [model]` | 切换模型并保存为默认；可在里面调整 effort |
| `/output-style [style]` | 文档中仍列出；但本机 [bin] 标注已移除，改为 `/config` → Output style |
| `/passes`、`/upgrade`、`/usage-credits`（旧名 extra-usage）、`/privacy-settings`、`/rate-limit-options` | 账号、计费、限额相关 |
| `/permissions` | 交互式管理 allow / ask / deny 规则 |
| `/plan [description]` | 直接进入 plan 模式 |
| `/plugin [sub]`、`/reload-plugins [--force]` | 插件菜单，热重载插件 |
| `/powerup` | 交互式功能教学（带动画演示） |
| `/radio`、`/stickers` | 彩蛋类命令 |
| `/recap` | 按需生成一行会话摘要 |
| `/release-notes` | 带版本选择器的更新日志 |
| `/reload-skills`、`/skills`、`/skill-doctor` | 重新扫描 skill；列表（可过滤）；统计上下文成本和使用频率 |
| `/remote-control`、`/remote-env`、`/teleport`（别名 tp）、`/web-setup` | 远程控制、云端环境、拉取云端会话、连接 GitHub |
| `/rename [name]` | 重命名会话，名字显示在输入框上 |
| `/resume [session]` | 按 ID 或名称恢复会话，或打开选择器（含后台会话） |
| `/rewind`（别名 checkpoint、undo） | 回滚代码和/或对话，或从某点开始总结 |
| `/run`、`/run-skill-generator`、`/verify` | **Skill**：启动并操作项目 app 来验证改动 |
| `/sandbox` | 切换沙箱模式（仅支持的平台） |
| `/schedule` | 云端定时 routine |
| `/scroll-speed` | 鼠标滚轮速度 |
| `/security-review` | 对当前分支 diff 做安全评审 |
| `/setup-bedrock`、`/setup-vertex` | 第三方云的配置向导 |
| `/simplify [target]` | **Skill**：在不改行为的前提下清理代码 |
| `/status` | 设置界面的 Status 页：版本、模型、账号、连通性 |
| `/statusline` | 用自然语言让 Claude 生成状态行脚本 |
| `/subtask <task>` | 派生继承完整对话的 fork 子代理（后台运行） |
| `/tasks`（别名 bashes） | 查看和管理全部后台工作 |
| `/team-onboarding` | 根据使用历史生成团队上手指南 |
| `/terminal-setup` | 安装 Shift+Enter 换行绑定（Apple Terminal 下为 Option+Enter 并关闭响铃） |
| `/theme` | 主题（含 auto 跟随终端明暗） |
| `/tui [default\|fullscreen]` | 切换渲染器，保留会话重启 |
| `/ultraplan` | 已移除，改用 plan 模式 |
| `/ultrareview [PR\|branch]` | 云端多代理深度评审 |
| `/update-config` | **Skill**：用自然语言修改 settings |
| `/usage` | 会话成本、套餐限额、活动统计 |
| `/vim` | 已移除（v2.1.92），改为 `/config` → Editor mode |
| `/voice [hold\|tap\|off]` | 语音听写 |
| `/workflows`、`/workflow-authoring` | 动态 workflow 的进度视图和脚本编写 |
| `/pr-comments` | 已移除（v2.1.91） |

其他 [bin] 中还有：`commit`、`pr`、`claude-code-docs`、`explain-usage`、`claude-in-chrome`、`setup-cowork`、`memory-types` 等内置 skill，以及 `daemon`、`tui`、`wellbeing`、`workflow-launch-exec`、`pause-memory`、`design-consent/revoke` 等内部或灰度命令。

**补全细节**：
- 在 prompt 中间输入 `/` 也能补全命令 [doc:interactive-mode "Complete a command mid-prompt"]。
- skill 的 `argument-hint` 会在补全时显示。

---

## 3. 全部快捷键与输入模式

### 3.1 通用 [doc:interactive-mode] 与 [bin] 默认绑定表一致

| 按键 | 作用 | 交互细节 |
|---|---|---|
| `Ctrl+C` | 中断，或清空输入 | |
| `Ctrl+D` | 退出 | |
| `Esc` | 中断当前回复或工具调用，或关闭对话框 | 已完成的工作会保留；有排队消息时接着发送；在权限提示上按 `Esc` 等于 No |
| `Esc Esc` | 输入框有内容时清空并存入历史（↑ 可找回）；输入框为空时打开 rewind 菜单 | 关键设计 |
| `Shift+Tab`（Windows 部分环境为 `Alt+M`） | 循环权限模式：default(Manual) → acceptEdits → plan → [bypassPermissions] → [auto] | 在文件权限提示上按它，选“本会话始终允许” |
| `Ctrl+G` / `Ctrl+X Ctrl+E` | 在外部编辑器 `$EDITOR` 中编辑 prompt | |
| `Ctrl+L` | 重绘屏幕 | |
| `Ctrl+O` | transcript 查看器 | |
| `Ctrl+R` | 反向搜索历史 | `Ctrl+S` 切换搜索范围 [bin historySearch:cycleScope] |
| `Ctrl+V` / `Cmd+V`(iTerm2) / `Alt+V`(Win) | 粘贴剪贴板图片 | |
| `Ctrl+B` | 把正在运行的 Bash 或 agent 放到后台 | |
| `Ctrl+T` | 任务清单开关 | |
| `Ctrl+S` | 暂存或恢复 prompt（stash） | |
| `Ctrl+Z` | 挂起进程 | |
| `Ctrl+X Ctrl+K` | 停止本会话全部后台 subagent | |
| `Ctrl+Enter` / `Ctrl+X Ctrl+S` | 立即发送排队消息 | |
| `Option/Alt+P` | 模型选择器 | 在选择器中可调 effort，也可选“仅本会话” |
| `Option/Alt+T` | 开关扩展思考 | 原来是 Tab |
| `Option/Alt+O` | 快速模式 | |
| `Ctrl+Shift+B` | brief 视图 | [bin] |
| `Tab` | 接受补全；在权限提示上为附加评论 | |
| `↑↓` / `Ctrl+P/N` | 移动光标或翻历史 | |
| `←→` | 切换对话框标签页 | |
| `?`（输入框为空时） | 快捷键帮助面板 | |
| 按住或轻点 `Space` | 语音听写（需开启 `/voice`） | |

### 3.2 行编辑（readline 风格）

`Ctrl+A/E/K/U/W/Y`、`Alt+Y`（在 `Ctrl+Y` 之后循环粘贴历史，kill ring）、`Alt+B/F/D`、`Ctrl+_`（撤销）。

### 3.3 多行输入

`\` + `Enter`、`Option+Enter`、`Shift+Enter`（需先跑 `/terminal-setup`）、`Ctrl+J`、直接粘贴。

### 3.4 输入前缀（输入模式）

| 前缀 | 模式 |
|---|---|
| `/` | 命令或 skill |
| `!` | Shell 模式：直接执行命令，输出进入上下文 |
| `@` | 文件路径提及，带模糊补全 |
| `:` | emoji 短码 |
| `?` | 帮助面板 |
| `#` | 已移除（原为快速写入记忆）[bin] |

### 3.5 Transcript 查看器

| 按键 | 作用 |
|---|---|
| `?` | 帮助 |
| `{` `}` | 在用户 prompt 之间跳转 |
| `Ctrl+E` | 显示全部 |
| `[` | 把全文写入终端原生 scrollback，便于用 Cmd+F 或 tmux 复制 |
| `v` | 在 `$EDITOR` 中打开 |
| `q` / `Esc` | 退出 |

### 3.6 Vim 模式

- 开启方式：`/config` → Editor mode。
- 支持 NORMAL、INSERT、VISUAL 模式，文本对象，以及 INSERT 模式下的键序列重映射（`vimInsertModeRemaps`）。
- 证据：[doc:interactive-mode][bin]。

### 3.7 自定义快捷键

- 配置文件：`~/.claude/keybindings.json`，保存后立即热加载。
- 格式：`{"bindings":[{"context":"Chat","bindings":{...}}]}`。
- 共 20 多个 context（app / chat / confirm / diff / footer / history / historySearch / scroll / select / transcript / voice …），约 150 个 action（完整清单见 [bin] 摘录）。
- 支持和弦键，如 `ctrl+x ctrl+k`。

### 3.8 其他输入行为

- **消息排队**：Claude 工作时输入的内容会排队，在合适的时机发送；可以撤回。
- **Prompt suggestions**：灰色的预测下一句，可关闭（`promptSuggestionEnabled`）。
- **后台 Bash**：长时间运行的命令可以放到后台，用 `/tasks` 管理。

---

## 4. 权限模式与规则

### 4.1 模式 [bin][doc:permission-modes]

| 模式 | 免询问范围 | 用途 |
|---|---|---|
| `default`（界面显示 Manual；CLI 也接受 `manual`） | 只读 | 敏感工作 |
| `acceptEdits` | 读、编辑、常见 fs 命令（mkdir/touch/mv/cp） | 边审边改 |
| `plan` | 只读（auto 可用时加上分类器批准的命令） | 先分析后改；计划需审批后才执行 |
| `auto` | 全部，由服务端分类器做安全审查 | 长任务 |
| `dontAsk` | 只读和预批准工具，其余一律拒绝 | CI |
| `bypassPermissions` | 全部 | 仅限容器或 VM |

**任何模式都不会自动批准的操作**：
- 命中 ask 规则的工具
- AskUserQuestion
- 删除关键路径（`rm` / `rmdir`）
- 开启 `blockReadsOutsideWorkingDirectories` 后对工作目录外的读取

deny 规则在所有模式下都生效，包括 bypass。受保护路径的写入不会被自动批准。

### 4.2 规则语法 [doc:permissions]

- **三类规则**：`permissions.allow`、`permissions.ask`、`permissions.deny`，在 settings 中配置，或用 `/permissions` 交互编辑。
- **写法**：
  - 整个工具：`Bash`、`Read`、`WebFetch`
  - 精确匹配：`Bash(npm run build)`
  - 通配：`Bash(npm run *)`（`Bash(ls *)` 与 `Bash(ls*)` 语义不同）
  - 路径：`Read(./.env)`、`Edit(~/.claude/settings.json)`（gitignore 风格）
  - 域名：`WebFetch(domain:example.com)`
  - MCP：`mcp__server__tool`
  - 按参数匹配：`Agent(model:opus)`、`Agent(isolation:worktree)`、`Bash(run_in_background:true)`
  - 另有 `Cd`、`Skill(...)` 等
- **复合命令**：会拆解后逐段匹配；只读命令有内置白名单。
- **优先级**：managed > CLI 参数 > local > project > user。项目中的 allow 规则受 workspace trust 约束。
- **交互细节**：
  - 权限提示中按 `Tab` 可以附加评论给 Claude。
  - 选项“本会话允许”会把规则写入 local settings。
- **可扩展**：PreToolUse / PermissionRequest hook、`--permission-prompt-tool`（MCP 工具代答）、沙箱（`/sandbox`，开启后 bash 可自动放行）。

---

## 5. 记忆（CLAUDE.md 分层、#）

| 层级 | 位置 | 证据 |
|---|---|---|
| Managed | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux `/etc/claude-code/CLAUDE.md` | [doc:memory] |
| 用户 | `~/.claude/CLAUDE.md`（本机不存在）、`~/.claude/rules/` | [doc][local] |
| 项目 | `./CLAUDE.md` 或 `./.claude/CLAUDE.md`、`.claude/rules/*.md`（可用 paths 限定作用范围），也支持 `AGENTS.md` | [doc] |
| 本地 | `./CLAUDE.local.md`（加入 gitignore） | [doc] |

**加载规则**：
- 从 cwd 向上逐级加载，所有文件拼接而不是覆盖，顺序为从根目录到 cwd。
- 子目录中的 CLAUDE.md 在读取该目录文件时才按需加载。
- `@path` 可以导入其他文件。
- 块级 HTML 注释会被剥离，不占 token。
- `claudeMdExcludes` 可以排除 monorepo 中其他团队的文件。

**Auto memory**：
- Claude 自动记录学到的东西，可用 `autoMemoryEnabled`、`autoMemoryDirectory` 配置；`/memory` 可以查看和开关。
- [bin] 中还有 `autoDreamEnabled`（后台整理记忆）。

**`#` 前缀已移除**：现在改为让 Claude 编辑 CLAUDE.md，或使用 `/memory`。[bin]

**`/init`**：生成 CLAUDE.md。

---

## 6. 自定义命令 / 子代理 / skills / output-style / plugins

| 能力 | 位置与格式 | 关键细节 | 证据 |
|---|---|---|---|
| Skills（取代自定义命令） | `~/.claude/skills/<name>/SKILL.md`、`.claude/skills/`、插件；旧的 `.claude/commands/*.md` 仍可用 | 见下方说明 | [doc:skills][local] |
| Subagents | `.claude/agents/*.md`、`~/.claude/agents/`、`--agents <json>`、managed、插件 | 见下方说明 | [doc:sub-agents] |
| Output styles | 内置 Default / Proactive / Concise / Explanatory / Learning；自定义放在 `~/.claude/output-styles/*.md` | 通过 `/config` 或 `outputStyle` 设置切换；会修改系统提示词 | [doc:output-styles][bin] |
| Plugins | 打包 skills、agents、hooks、MCP、LSP、output-style；通过 marketplace 安装 | 见下方说明 | [help][doc:plugins][local] |

**Skills 细节**：
- frontmatter 字段：`name`、`description`、`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context: fork`、`agent`、`hooks`、`paths`、`shell`。
- 变量替换：`$ARGUMENTS`、`$0`、`${CLAUDE_SESSION_ID}`、`${CLAUDE_SKILL_DIR}` 等。
- ``!`cmd` `` 可以注入动态上下文。
- 模型可以自动调用 skill，用户也可以用 `/name` 调用。
- `/skill-doctor` 统计上下文成本。
- 本机已安装 2 个 skill。

**Subagents 细节**：
- 优先级：managed > CLI > 项目 > 用户 > 插件。
- 内置 subagent：Explore（只读、快速）、Plan、general-purpose 等。
- frontmatter 可配置：tools、model、permissionMode、mcpServers、skills、memory（持久记忆）、hooks。
- 支持前台或后台运行、恢复、嵌套派生、并发上限。
- `/fork`、`/subtask` 可派生 fork 子代理。
- 可以用 `@agent-name` 显式调用。

**Plugins 细节**：
- 命令：`/plugin`、`claude plugin install`、`--plugin-dir`、`/reload-plugins`。
- 作用域：user / project / local。
- 相关设置：`enabledPlugins`、`extraKnownMarketplaces`。
- 本机有 `plugins/known_marketplaces.json`。

---

## 7. Hooks [bin][doc:hooks]

- **配置位置**：
  - `~/.claude/settings.json`
  - `.claude/settings.json`
  - `.claude/settings.local.json`
  - managed 设置
  - 插件的 `hooks/hooks.json`
  - skill 或 subagent 的 frontmatter
- **合并与执行**：各层 hook 会合并而不是覆盖；匹配到的 hook 并行执行，同样的 handler 只跑一次。
- **Handler 类型（5 种）**：
  - `command`：stdin 接收 JSON，通过 exit code 和 stdout 回传结果
  - `http`：POST JSON
  - `mcp_tool`
  - `prompt`：单轮 LLM 判定
  - `agent`：派一个子代理去验证，实验性
- **事件（31 个，来自 [bin]）**：
  - 工具相关：PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch
  - 权限相关：PermissionRequest、PermissionDenied
  - 用户输入：UserPromptSubmit、UserPromptExpansion
  - 会话生命周期：SessionStart、SessionEnd（reason 取值 clear / resume / logout / prompt_input_exit / other）、Setup
  - 停止：Stop、StopFailure、SubagentStart、SubagentStop
  - 压缩：PreCompact、PostCompact
  - 通知与展示：Notification、MessageDisplay
  - 协作与任务：TeammateIdle、TaskCreated、TaskCompleted
  - MCP elicitation：Elicitation、ElicitationResult
  - 环境变化：ConfigChange、WorktreeCreate、WorktreeRemove、InstructionsLoaded、CwdChanged、FileChanged、DirectoryAdded
  - 在线文档还有 PreModelSwitch 等更新的事件。
- **输入**：JSON 中包含 `hook_event_name`、session_id、transcript_path、cwd，以及各事件自己的字段。
- **输出**：
  - exit code：0 表示成功，stdout 可以是 JSON；2 表示阻断，stderr 回传给 Claude；其他非 0 为非阻断错误。此约定来自文档，本次没有逐字复核。
  - JSON 字段：`continue`、`stopReason`、`suppressOutput`、`systemMessage`、`decision:"block"`，以及 `hookSpecificOutput`（含 `permissionDecision`、`updatedInput`、`additionalContext`）[bin]。
- **超时**：command、http、mcp_tool 超时后丢弃输出；PreToolUse 超时不会阻断工具调用。支持 `async: true` 后台运行。
- **治理**：`disableAllHooks`、`allowManagedHooksOnly`、`allowedHttpHookUrls`、`httpHookAllowedEnvVars`。
- **交互**：
  - `/hooks` 只读查看配置。
  - stop hook 报错时界面提示 “ctrl+o to see”。
  - `--include-hook-events` 会把 hook 事件输出到 stream。

---

## 8. Statusline [doc:statusline][bin]

- **配置**：
  - 格式：`"statusLine": {"type":"command","command":"~/.claude/statusline.sh","padding":0,"refreshInterval":N,"hideVimModeIndicator":bool}`。
  - 也可以用 `/statusline <描述>` 让 Claude 生成脚本；该命令只获准修改 `~/.claude/settings.json`。
- **stdin JSON 字段**：
  - 模型与会话：`model.id/display_name`、`session_id`、`session_name`、`transcript_path`、`version`
  - 路径与仓库：`cwd`、`workspace.current_dir/project_dir/added_dirs/git_worktree/repo.{host,owner,name}`
  - 成本：`cost.total_cost_usd/total_duration_ms/total_api_duration_ms/total_lines_added/removed`
  - 上下文窗口：`context_window.used_percentage/remaining_percentage/context_window_size/current_usage/total_input_tokens/total_output_tokens`、`exceeds_200k_tokens`
  - 缓存：`prompt_cache.*`（含 expires_at）
  - 限额：`rate_limits.five_hour/seven_day/spend_limit.{used_percentage,resets_at}`
  - 模式与风格：`output_style.name`、`vim.mode`、`effort.level`、`thinking.enabled`
  - 代理与 worktree：`agent.name`、`worktree.{name,path,branch,original_cwd,original_branch}`
  - PR：`pr.{number,url,kind,review_state}`
  - 其他：`prompt.id`、`process.pid`
- **刷新时机**：
  - 启动或恢复会话时
  - 新的 assistant 消息
  - `/compact` 完成
  - 权限模式切换
  - vim 模式切换
  - `command` 变更（立即执行，不防抖）
  - `refreshInterval` 定时
  - rate-limit 到达 `resets_at`、缓存到达 `expires_at`
  - 以上事件有 300ms 防抖。
- **输出能力**：多行、ANSI 颜色、OSC 8 可点击链接。宽度从 `COLUMNS` 读取。在帮助菜单或权限提示期间会隐藏。不消耗 token。
- **Subagent 状态行**：`subagentStatusLine`。

---

## 9. Checkpoint / Rewind [doc:checkpointing][bin]

- **自动快照**：每条会开启新一轮的 prompt 都会对编辑工具改过的文件做快照。
  - 保留最近 100 个 checkpoint。
  - 快照随会话保存，恢复会话后仍然可以 rewind。
  - 约 30 天后被清理。
  - 本机目录为 `~/.claude/file-history/`；会话 jsonl 中有 `file-history-snapshot` 和 `file-history-delta` 记录 [local]。
- **入口**：`/rewind`（别名 checkpoint、undo），或输入框为空时按 `Esc Esc`。
- **rewind 菜单**：
  - 列出每条 prompt。
  - 操作选项：恢复代码和对话 / 只恢复对话 / 只恢复代码 / 从此处开始总结 / 总结到此处（可输入引导语）/ Never mind。
  - 恢复对话后，原 prompt 会回填到输入框。
  - 如果之前执行过 `/clear`，顶部会出现 “/resume <id> (previous session)” 条目。
- **限制**：以下变更不会被跟踪或恢复：
  - Bash 引起的改动
  - subagent 做的编辑
  - 外部改动
  - 轮中插入的消息
  - 软链和硬链路径
- **开关**：`fileCheckpointingEnabled`。

---

## 10. 会话（continue / resume / fork / export）[doc:sessions][help][local]

| 能力 | 用法 | 细节 |
|---|---|---|
| 继续 | `claude -c` | 继续当前目录最近的会话 |
| 恢复 | `claude -r [id\|name]`、`/resume` | 选择器支持搜索、预览，并显示后台会话；也可以从摘要恢复；权限模式按规则恢复 |
| 命名 | `-n/--name`、`/rename` | 名字显示在输入框和终端标题上（`terminalTitleFromRename`） |
| 分叉 | `/branch [name]`、`claude -c --fork-session`、`/fork`（后台副本）、`/subtask` | `/branch` 会打印新旧两个会话 ID |
| 清空 | `/clear [name]` | 旧会话保留，可恢复 |
| 导出 | `/export [file]` | 纯文本写入文件或复制到剪贴板；`/copy [N]` 复制单条回复 |
| 存储 | `~/.claude/projects/<cwd 转义>/<uuid>.jsonl` | 记录类型：user、assistant、attachment、system、mode、permission-mode、ai-title、last-prompt、file-history-*、queue-operation；输入历史在 `~/.claude/history.jsonl`；由 `cleanupPeriodDays` 控制清理 [local][bin] |
| 跨端 | `/desktop`、`/teleport`、`--teleport`、`--cloud`、`/remote-control`、`/background` + `claude agents` | 会话可以在终端、桌面端、Web 和后台之间迁移 |
| 不落盘 | `--no-session-persistence` | |

---

## 11. Headless（Non-interactive）与 SDK 事件格式、退出码 [doc:headless][help]

- **基本用法**：`claude -p "<prompt>"`，也支持 stdin 管道输入。可与 `-c`、`-r` 组合续聊。
- **`--output-format`**：
  - `text`（默认）
  - `json`：单个结果，包含 `result`、`session_id`、usage、cost 等；配合 `--json-schema` 时结构化结果放在 `structured_output`。
  - `stream-json`：NDJSON 流，需要 `--verbose`。
    - 首个事件是 `system/init`，包含 model、tools、mcp_servers、mcp_server_errors、plugins、plugin_errors、capabilities。
    - 之后是 `assistant` 和 `user` 消息；subagent 的消息带 `parent_tool_use_id`。
    - 加 `--include-partial-messages` 时有 `stream_event`（其中含 text_delta）。
    - 可能出现 `system/api_retry`（attempt、max_retries、retry_delay_ms、error_status、error 分类）和 `system/plugin_install`。
    - 加 `--include-hook-events` 时有 hook_started、hook_progress、hook_response。
    - 加 `--prompt-suggestions` 时有 `prompt_suggestion`。
    - 最后一行是 `result` 消息。
- **`--input-format stream-json`**：双向流，可配合 `--replay-user-messages`。
- **`--bare`**：
  - 跳过 hooks、skills、插件、MCP、auto memory 和 CLAUDE.md 的自动发现，也不读 OAuth 和钥匙串，需要 `ANTHROPIC_API_KEY`。
  - 这是推荐的脚本和 SDK 用法，官方表示未来会成为 `-p` 的默认行为。
  - 不加 `--bare` 时，`-p` 会执行项目的 hooks 和 `.mcp.json`，而且没有 trust 提示，存在安全隐患。
- **限制参数**：`--max-turns`（超出后报错退出）、`--max-budget-usd`、`--permission-mode dontAsk`、`--allowedTools`、`--permission-prompt-tool`。
- **后台任务的收尾**：
  - 后台 Bash 在出结果约 5 秒后被终止。
  - 后台 subagent 或 workflow 会等待完成，空闲上限 10 分钟。
  - 输出排空等待最长 30 秒。
- **退出码**：
  - 已确认：SIGTERM 退出码为 143（记录中断并运行 SessionEnd hook）；`--json-schema` 非法时报错退出；`--max-turns` 超限时报错退出。
  - 常规错误为非 0，成功为 0（通用约定，本次没有逐项核对）。
- **SDK**：称为 Agent SDK（TS / Python），消息类型与 stream-json 一致。

---

## 12. IDE 集成 [doc:ide-integrations][doc:jetbrains][bin]

- **VS Code 扩展**（也适用于 Cursor 等）：
  - 可放在侧边栏或编辑器标签页，支持多会话、会话分组。
  - `Cmd+Esc`：焦点在编辑器和 Claude 之间切换。
  - `Cmd+Shift+Esc`：新标签页。
  - `Option+K`：插入 @ 引用。
  - 原生 diff 视图，可逐处接受或拒绝改动。
  - 支持 checkpoint rewind、插件管理，以及切换到 terminal 模式。
- **CLI 与 IDE 的联动**：
  - 扩展会启动一个名为 `ide` 的本地隐藏 MCP server。
  - CLI 连接后可以在 IDE 中打开 diff，并自动附带当前选区和活动文件（显示为 “⧉ Selected N lines from <file>”）。
  - 可用 Read deny 规则排除敏感文件。
- **CLI 入口**：`/ide [open]`、`claude --ide`（只有一个 IDE 时自动连接）。本机 `~/.claude/ide/` 存放 lock 文件 [local]。
- **JetBrains 插件**；桌面端通过 `/desktop` 接续；浏览器端为 Claude in Chrome（`/chrome`、`--chrome`）。

---

## 13. doctor / update / terminal-setup

| 名称 | 用法 | 细节 | 证据 |
|---|---|---|---|
| `claude doctor` | 在 shell 中运行 | 只读体检，不弹 trust 提示 | [help] |
| `/doctor [prompt-audit]` | 会话内运行 | 以 skill 形式实现，能诊断并修复：安装问题、未使用的扩展、重复或臃肿的 memory、慢 hook、更新、权限；可用 `DISABLE_DOCTOR_COMMAND` 禁用 | [doc][bin] |
| `claude update` / `/update` | | 更新通道由 `autoUpdatesChannel`（latest / stable）控制，可设 `minimumVersion`；默认后台自动更新，本机有 `.update.lock` 和 `.last-update-result.json` | [help][bin][local] |
| `claude install [stable\|latest\|ver]` | | 原生安装，版本存放在 `~/.local/share/claude/versions/` | [help] |
| `/terminal-setup` | | 为 VS Code、Cursor、Alacritty 等写入 Shift+Enter 换行绑定；Apple Terminal 下为 Option+Enter 并关闭响铃 | [bin][doc] |
| `/release-notes`、`/status`、`/heapdump`、`/debug`、`--safe-mode` | | 排障辅助 | [doc] |

---

## 14. 对终端用户最有价值的前 25 项

“独特”列标 ★ 的是与 Codex CLI 明显不同的设计。Codex 一侧的判断基于对 Codex CLI 常见能力的了解（exec、sandbox/approval、AGENTS.md、/review、resume、config.toml、notify）；以兄弟代理的 Codex 调研文档为准。

| # | 功能 | 为什么有价值 | 独特 |
|---|---|---|---|
| 1 | Shift+Tab 循环 6 种权限模式（含 plan、auto 分类器、dontAsk） | 一键切换信任级别；auto 靠服务端分类器消除频繁确认 | ★ Codex 用 sandbox × approval 两个维度，没有 plan 模式和 AI 分类器审批 |
| 2 | `/rewind` + Esc Esc checkpoint（代码和对话分别回滚，可从某点总结） | 大胆试错、零成本撤销 | ★ Codex 没有内置文件快照回滚 |
| 3 | 细粒度权限规则 `Bash(npm run *)`、`Read(./.env)`、`WebFetch(domain:)`，allow/ask/deny 三类，按层合并 | 可审计、可团队共享 | ★ 规则 DSL 比 Codex 的 approval 策略细得多 |
| 4 | Hooks：31 种事件、5 种 handler（command/http/mcp_tool/prompt/agent），可阻断或改写输入 | 自动格式化、守卫、通知、审计 | ★ Codex 主要只有 notify 回调 |
| 5 | CLAUDE.md 多层记忆 + `.claude/rules` 路径规则 + auto memory | 项目知识持续积累 | 部分独特（Codex 用 AGENTS.md；CC 也兼容 AGENTS.md） |
| 6 | Skills（`/name` 调用或模型自动调用，frontmatter 丰富，支持 `!` 注入命令输出） | 可复用工作流 | ★ |
| 7 | Subagents（Explore/Plan/自定义，前后台运行，fork） | 并行调研、隔离上下文 | ★ |
| 8 | `/context` 上下文网格 + `/compact [指令]` + autocompact 阈值 | 直观管理 token | 部分独特 |
| 9 | 自定义 statusLine（丰富的 stdin JSON，含限额、成本、PR、worktree） | 常驻信息面板 | ★ |
| 10 | `-p` + stream-json 双向流 + `--json-schema` 结构化输出 + `--bare` | 脚本、CI、SDK 化 | 与 `codex exec --json` 对应；schema 校验和 bare 模式更完整 |
| 11 | 会话 `-c` / `-r` / `/branch` / `--fork-session` / 命名 | 多线并行探索 | 部分独特（分叉） |
| 12 | `!` shell 模式与后台 Bash（Ctrl+B、`/tasks`） | 不离开会话跑命令，长任务放后台 | 部分独特 |
| 13 | 消息排队 + Ctrl+Enter 立即发送 + Esc 中断并保留进度 | 边跑边补充指令 | |
| 14 | `@` 文件提及、图片粘贴、外部编辑器 Ctrl+G | 输入效率 | |
| 15 | `/diff` 面板（含逐轮 diff） | 实时审阅改动 | 与 Codex `/diff` 相近，但多了逐轮视图 |
| 16 | 插件与 marketplace（打包 skills、agents、hooks、MCP） | 生态分发 | ★ |
| 17 | `keybindings.json` 全量可重绑定（20+ context）+ vim 模式 | 键位自由 | ★ |
| 18 | `/model`（Alt+P）+ `/effort` + Alt+T 思考开关 + `/fast` | 快速在成本和质量之间切换 | |
| 19 | worktree 一等公民（`-w`、`--tmux`、`/batch` 多 worktree 并行开 PR） | 隔离并行开发 | ★ |
| 20 | 后台、云端会话迁移（`/background`、`/teleport`、`/desktop`、`/remote-control`） | 跨设备接力 | ★ |
| 21 | Output styles（Explanatory/Learning 等） | 教学或精简风格 | ★ |
| 22 | `/code-review`、`/security-review`、`/ultrareview` | 内置评审 | 与 Codex `/review` 对应；ultrareview 在云端多代理运行 |
| 23 | IDE 集成（隐藏的 `ide` MCP，自动附带选区，在 IDE 中打开 diff） | 编辑器联动 | |
| 24 | `/doctor` 可自动修复 + `/usage` 限额面板 + 限流后等待自动继续 | 自助排障，额度透明 | 部分独特 |
| 25 | `/import codex\|gemini\|cursor` 一键迁移配置 | 降低迁移成本 | ★ 直接对标竞品 |

### 与 Codex 明显不同的独特设计（汇总）

1. **权限模型**：CC 采用“模式 + 规则 DSL + hook + AI 分类器（auto）”；Codex 以 OS 级沙箱（read-only / workspace-write / full-access）配合 approval 策略为核心。CC 的沙箱（`/sandbox`）只是可选项。
2. **可回滚**：CC 有文件级 checkpoint 和会话分叉；Codex 主要依赖 git。
3. **扩展体系的层次**：CC 有 Skills、Subagents、Hooks、Plugins/marketplace、Output styles、Statusline、Keybindings 七类扩展点，都可以通过文件声明，并在 user/project/local/managed 四层合并。
4. **多形态会话**：后台 agent、云端、桌面、移动端、Remote Control、worktree/tmux 并行，同一会话可以在多端迁移。
5. **可观测性 UI**：`/context` 网格、statusLine JSON、transcript 查看器、`/focus`、`/insights`、`/skill-doctor`。
6. **向竞品取数**：`/import codex` 可以直接读取 Codex 配置；也兼容 AGENTS.md。

---

## 附：调研备注

- 本机的 `~/.claude/settings.json` 只有 `env`（6 个键名：ANTHROPIC_AUTH_TOKEN / BASE_URL / API_KEY、API_TIMEOUT_MS 等，值未读取）和 `skipDangerousModePermissionPrompt` 两个顶层键，说明本机走的是第三方 API 网关。
- 协作风险：本代理曾用 curl 把 CC 文档下载到 `/tmp/cli-cmp/docs/`，可能覆盖了 Codex 兄弟代理下载的同名文件（如 `ide-integrations.md`、`vs-code.md` 等，时间约为 03:09）。这些 CC 文档已移到 `/tmp/cli-cmp/cc-docs/`。**Codex 调研方需要重新拉取同名文件**，这条提醒此前没能送达父代理。
