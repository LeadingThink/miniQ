# miniQ

miniQ 是一款面向通用办公场景的桌面端 AI Coworker:用户给出目标,agent 拆解步骤、读取本地文件、调用工具、在关键操作前请求审批,最终交付可直接使用的结果。所有"怎么做某类工作"的知识以技能(SKILL.md)组装,一次任务的做法可以一键蒸馏为可复用技能。

完整设计见 [docs/desktop-cowork-implementation.md](docs/desktop-cowork-implementation.md)。
Agent 长会话、压缩与工具执行保护见 [docs/harness-runtime.md](docs/harness-runtime.md)。

## 架构

```text
Tauri 2 Desktop (apps/desktop, React + 托盘)
  └─ WebSocket (JSON-RPC 2.0) ──▶ miniq-daemon
       ├─ miniq-protocol   协议类型(请求/响应/事件, schemars)
       ├─ miniq-memory     SQLite 持久化(会话/消息/工具调用/审批/产物/checkpoint/记忆/审计)
       ├─ miniq-models     LLM provider(OpenAI-compatible SSE)
       ├─ miniq-agent      turn 运行器(规划-执行循环)
       ├─ miniq-tools      ToolRouter + 21 个内置工具
       ├─ miniq-skills     技能系统(发现/注入/蒸馏/进化)
       ├─ miniq-docs       pdf/docx/xlsx/pptx/csv 读, docx/xlsx/md/csv 写
       └─ miniq-sandbox    路径约束 + 命令风险分级
```

## 核心能力

- **工具**:file_read/list/write/edit/glob/grep/patch、shell_run、git_status/diff、doc_read/write、web_fetch/search、http_request、memory_search/write、task_update、ask_user、skill.read、mcp_call
- **技能**:三级目录发现(项目 > 用户 > 内置),注入系统提示词,`Save as skill` 一键把任务 transcript 蒸馏为 SKILL.md,重复任务可进化版本
- **安全**:low 自动执行;medium/high 审批(允许一次 / 本会话允许,shell 按程序、网络按域名、MCP 按 server 细分);blocked 拦截;写入前自动 checkpoint 可回滚;全部进审计日志
- **任务体验**:步骤计划外显、澄清提问卡片、产物交付区、同 workspace 串行 / 跨 workspace 并行
- **外部会话**:全量发现并导入本机 Codex、Claude Code、OpenCode 历史,保留原始事件与来源身份,导入后可直接用 miniQ 继续
- **MCP**:配置 stdio MCP server,tools 经 `mcp_call` 进入审批与审计链

外部会话的来源路径、导入语义和扩展契约见 [docs/external-session-import.md](docs/external-session-import.md)。

## 快速开始

```powershell
# 1. 构建 daemon
cargo build -p miniq-daemon

# 2. 配置模型 provider(OpenAI-compatible)
$env:MINIQ_BASE_URL = "https://api.openai.com/v1"   # 或本地端点
$env:MINIQ_API_KEY  = "sk-..."
$env:MINIQ_MODEL    = "gpt-4o-mini"

# 3. 启动桌面 app(自动启动/发现 daemon)
cd apps/desktop
npm install
npm run tauri dev
```

浏览器开发模式(不经过 Tauri):先手动启动 daemon,再打开 `http://localhost:1420/?port=<端口>&token=<token>`(见 `%LOCALAPPDATA%/miniq/daemon.json`)。

## 测试与打包

```powershell
cargo test --workspace          # Rust: 115+ 测试(单元 + WebSocket 集成 + mock MCP)
cd apps/desktop; npm run build  # 前端类型检查 + 构建

# Windows 安装包(先构建 daemon 并放入 externalBin)
cargo build --release -p miniq-daemon
cp target/release/miniq-daemon.exe apps/desktop/src-tauri/binaries/miniq-daemon-x86_64-pc-windows-msvc.exe
cd apps/desktop; npx tauri build
```

## 安全模型

- 所有工具调用经过 `ToolRouter`,写入 `tool_calls` 与 `audit_events`。
- 工具路径约束在项目根目录内(`miniq-sandbox`);用户明确附加的项目外文件仅允许读取该文件,不授予写入或相邻目录访问权。
- 命令按风险分级:`low` 自动执行;`medium/high` 需审批(允许一次 / 本会话允许 / 拒绝);`blocked` 直接拦截。

## 手机与平板

iPhone / iPad 正式版已在 [App Store 上架](https://apps.apple.com/cn/app/miniq/id6811485613)，需要 iOS / iPadOS 15 或更高版本。手机端可独立问答，也可远程查看和继续电脑上的任务。使用远程功能时，在电脑 miniQ 的「设置 → 服务与远程」开启「允许远程连接」，两端使用同一个在问 API Key，电脑保持联网且未休眠。

终端版在所安装的电脑或服务器上执行任务；手机端连接这些电脑上的 miniQ，不在 iPhone / iPad 上安装终端命令或执行电脑工具。

## Terminal Client

miniQ 提供独立终端命令 `miniq`，连接同一后台时与桌面、手机共享会话和后台能力。安装不需要 Rust 或 Node.js，也可在桌面「设置 → 服务与远程 → 终端命令」一键安装到本机。

macOS（Apple Silicon / Intel）：

```sh
curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | sh
```

Windows 10 / 11 x64，在 PowerShell 中执行：

```powershell
irm https://oss.zaiwen.top/releases/miniq/install.ps1 | iex
```

Linux / WSL（x86_64，glibc 2.31+），当前可用终端正式版为 0.1.54：

```sh
curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | MINIQ_VERSION=0.1.54 sh
```

安装后重新打开终端，进入项目目录运行 `miniq`。首次使用会引导配置 API Key 并搜索选择文本模型；本机已有桌面配置会直接复用，其他电脑需单独配置，WSL 与 Windows 使用独立的数据目录。在会话中输入 `/model` 选择模型，`/effort` 调整当前会话的推理强度。`miniq resume` 选择当前项目的历史会话，`miniq doctor` 查看终端、后台版本与依赖状态。

macOS / Windows 可用 `miniq update` 更新终端程序。0.1.55 未发布 Linux 终端包，Linux / WSL 暂请使用上方指定 0.1.54 的命令安装或重装。更新保留运行中的任务，详见[终端安装、使用与多端说明](docs/terminal.md)。
