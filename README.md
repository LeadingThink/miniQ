# miniQ

miniQ 是一个面向开发者的桌面端 AI cowork 产品:Tauri 2 桌面壳 + 本地 Rust agent daemon,agent 在本地工作区中读文件、跑命令、改代码,高风险操作需要用户审批。

完整设计见 [docs/desktop-cowork-implementation.md](docs/desktop-cowork-implementation.md)。

## 架构

```text
Tauri 2 Desktop (apps/desktop)
  └─ React UI ── WebSocket (JSON-RPC 2.0) ──▶ miniq-daemon
                                                ├─ miniq-protocol   协议类型
                                                ├─ miniq-memory     SQLite 持久化
                                                ├─ miniq-models     LLM provider (OpenAI-compatible)
                                                ├─ miniq-agent      turn 运行器
                                                ├─ miniq-tools      ToolRouter + file/shell/git 工具
                                                └─ miniq-sandbox    路径约束 + 命令风险分级
```

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

## 测试

```powershell
cargo test --workspace          # Rust: protocol/memory/sandbox/tools/daemon 集成
cd apps/desktop; npm run build  # 前端类型检查 + 构建
```

## 安全模型

- 所有工具调用经过 `ToolRouter`,写入 `tool_calls` 与 `audit_events`。
- 路径一律约束在 workspace 内(`miniq-sandbox`)。
- 命令按风险分级:`low` 自动执行;`medium/high` 需审批(允许一次 / 本会话允许 / 拒绝);`blocked` 直接拦截。
