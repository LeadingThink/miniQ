# miniQ

miniQ 是一款面向通用办公场景的桌面端 AI Coworker:用户给出目标,agent 拆解步骤、读取本地文件、调用工具、在关键操作前请求审批,最终交付可直接使用的结果。所有"怎么做某类工作"的知识以技能(SKILL.md)组装,一次任务的做法可以一键蒸馏为可复用技能。

完整设计见 [docs/desktop-cowork-implementation.md](docs/desktop-cowork-implementation.md)。

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
- **MCP**:配置 stdio MCP server,tools 经 `mcp_call` 进入审批与审计链

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
- 路径一律约束在 workspace 内(`miniq-sandbox`)。
- 命令按风险分级:`low` 自动执行;`medium/high` 需审批(允许一次 / 本会话允许 / 拒绝);`blocked` 直接拦截。
