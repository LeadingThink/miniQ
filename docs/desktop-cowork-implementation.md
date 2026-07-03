# miniQ Desktop Cowork 实现文档

## 1. 产品定位

miniQ 是一个面向开发者的桌面端 AI cowork 产品，目标体验接近 Claude Code / Codex cowork：用户在本地工作区中与 agent 协作，由 agent 读取文件、修改代码、运行命令、调用 MCP 工具、维护会话记忆，并在高风险操作前请求用户审批。

核心原则：

- 桌面体验优先：常驻本地、低延迟、支持多工作区和长期会话。
- 本地控制优先：shell、git、file、memory、approval、sandbox 都由本机 Rust runtime 管控。
- 协议优先：UI 与 agent core 之间走清晰的 JSON-RPC / WebSocket 协议，工具和外部能力通过 MCP / ACP 接入。
- 安全默认：命令审批、权限声明、沙箱策略、审计日志是核心能力，不作为后续补丁。
- 轻量实现：避免 Electron + Node agent 的重量级路线，采用 Tauri 2 + Rust daemon。

## 2. 总体架构

```text
Tauri 2 Desktop App
  ├─ Svelte / React UI
  ├─ Tauri command bridge
  └─ Local WebSocket client
       ↓
Local Rust Agent Daemon
  ├─ JSON-RPC / WebSocket gateway
  ├─ Session manager
  ├─ Agent runtime
  ├─ Tool router
  ├─ Approval manager
  ├─ Sandbox manager
  ├─ Memory service
  └─ Event stream
       ↓
Tools and Integrations
  ├─ MCP clients / servers
  ├─ ACP adapters
  ├─ Shell tool
  ├─ Git tool
  ├─ File tool
  └─ Model provider adapters
       ↓
SQLite
  ├─ sessions
  ├─ messages
  ├─ tool_calls
  ├─ approvals
  ├─ memories
  ├─ workspaces
  └─ audit_events
```

推荐采用单机本地 daemon，而不是把所有 agent 逻辑塞进 Tauri command。Tauri 只负责桌面外壳、窗口、系统权限和轻量桥接；agent daemon 负责长期运行状态、任务调度、工具调用和安全策略。

## 3. 技术栈

| 层级 | 技术 | 职责 |
| --- | --- | --- |
| 桌面容器 | Tauri 2 | 跨平台窗口、系统托盘、本地权限、自动更新 |
| 前端 | Svelte 或 React | 聊天、任务流、文件 diff、审批面板、设置页 |
| 本地核心 | Rust | agent runtime、工具系统、会话状态、安全控制 |
| 本地通信 | JSON-RPC 2.0 over WebSocket | UI 与 daemon 双向通信、事件流 |
| 工具协议 | MCP | 接入外部工具、上下文服务、第三方能力 |
| agent 协作协议 | ACP / JSON-RPC | 与 agent server、远程 worker 或其他客户端互操作 |
| 存储 | SQLite | 会话、记忆、工具调用、审批、审计日志 |
| 异步运行时 | Tokio | daemon、工具调用、事件推送、任务取消 |
| 数据校验 | serde + schemars | Rust 类型生成 JSON Schema |
| 前端类型 | TypeScript | 从 JSON Schema 生成请求、响应和事件类型 |

如果后续引入 Python agent 或评测脚本，必须保持 JSON Schema 与 Pydantic model 的字段限制一致。推荐以 JSON Schema 作为跨语言契约源，Rust 与 Python 都从同一份 schema 校验。

## 4. 参考项目吸收方式

本仓库使用 `reference-repos/` 作为本地参考代码目录。该目录已经加入 `.gitignore`，不会被提交，但实现 miniQ 时可以直接读取和检索其中的完整代码。

参考代码路径：

```text
reference-repos/
  openfang/     # Tauri/Rust 桌面结构、本地服务组织
  librefang/    # Tauri/Rust 桌面结构、前后端通信
  zeroclaw/     # 轻量 agent runtime、Rust 工具编排
  opencrust/    # 轻量 runtime、agent core 设计
  moltis/       # 长期 session、memory、sandbox 思路
  ironclaw/     # 安全沙箱、权限、命令审批
  microclaw/    # 聊天渠道、消息事件流
```

这些项目作为完整代码参考，不直接 fork：

- OpenFang / LibreFang：参考 Tauri 桌面结构、窗口管理、前端与本地核心的拆分方式。
- ZeroClaw / OpenCrust：参考轻量 Rust runtime，避免把 agent core 做成复杂平台。
- Moltis：参考长期 session、memory、sandbox 的服务化设计。
- IronClaw：参考安全沙箱、命令审批、权限边界。
- MicroClaw：参考聊天渠道、消息事件流、多端连接能力。

miniQ 的实现策略是吸收架构边界、代码组织方式和关键实现细节，不复制项目结构。每开始实现一个模块前，应先在 `reference-repos/` 中检索对应项目的实现，确认成熟项目如何处理进程边界、协议、工具调用、持久化和安全策略。

推荐检索方式：

```powershell
rg "tauri|command|invoke|websocket|jsonrpc" reference-repos\openfang reference-repos\librefang
rg "tool|runtime|agent|executor" reference-repos\zeroclaw reference-repos\opencrust
rg "session|memory|sqlite|sandbox" reference-repos\moltis
rg "approval|permission|sandbox|command" reference-repos\ironclaw
rg "message|chat|stream|event" reference-repos\microclaw
```

参考代码使用原则：

- 先读已有实现，再设计 miniQ 模块边界。
- 可以借鉴目录分层、trait 边界、协议字段和测试方法。
- 不直接复制大段代码，除非许可证允许且保留必要声明。
- 不为了兼容参考项目而牺牲 miniQ 的新架构。
- 参考代码中的旧逻辑、复杂兜底和历史兼容层不默认继承。

项目初期应优先完成一条稳定的本地闭环：聊天输入、模型规划、工具调用、审批、文件修改、命令执行、结果回传、会话持久化。

## 5. 仓库结构

```text
miniQ/
  reference-repos/          # 本地参考代码，被 .gitignore 忽略，不提交
  apps/
    desktop/
      src/                  # Svelte / React 前端
      src-tauri/            # Tauri 2 shell
  crates/
    miniq-daemon/           # 本地 agent daemon 入口
    miniq-protocol/         # JSON-RPC 请求、响应、事件类型
    miniq-agent/            # agent runtime、planner、executor
    miniq-tools/            # shell/git/file/MCP/ACP 工具
    miniq-sandbox/          # sandbox 和权限策略
    miniq-memory/           # SQLite memory/session 服务
    miniq-models/           # LLM provider adapter
  schemas/
    protocol.schema.json
    tools.schema.json
  migrations/
    0001_init.sql
  docs/
    desktop-cowork-implementation.md
```

代码边界要求：

- `miniq-protocol` 只放协议类型，不依赖 UI、agent、tools。
- `miniq-agent` 只编排任务，不直接访问 SQLite 和系统命令。
- `miniq-tools` 通过 trait 暴露工具能力，由 `ToolRouter` 统一调度。
- `miniq-sandbox` 只负责权限判定、路径约束、命令风险分级。
- `miniq-memory` 只负责持久化，不承载业务流程。
- 单文件不超过 500 行，单函数不超过 100 行。超过后按职责拆模块。

## 6. 进程模型

第一版采用两个本地进程：

```text
Desktop UI Process
  └─ starts and monitors
Agent Daemon Process
```

启动流程：

1. Tauri app 启动。
2. Tauri 检查 daemon 是否已运行。
3. 如果没有运行，则启动 `miniq-daemon`。
4. daemon 绑定 `127.0.0.1` 本地端口或命名管道。
5. UI 通过一次性 token 建立 WebSocket 连接。
6. UI 请求 `session.list`，恢复最近工作区。
7. 用户发送消息后，UI 调用 `session.sendMessage`。
8. daemon 推送 token、tool call、approval request、diff、command output 等事件。

daemon 需要支持：

- 多 workspace。
- 多 session。
- 单 session 内任务取消。
- daemon 重启后恢复未完成会话的可读状态。
- 所有工具调用写入审计日志。

## 7. UI 模块

桌面 UI 建议分为 6 个主区域：

- Workspace sidebar：工作区、会话列表、模型状态、MCP 状态。
- Chat timeline：用户消息、assistant 消息、工具调用、审批卡片、运行结果。
- Composer：输入框、附件、上下文选择、模式选择。
- Diff viewer：文件变更、接受/拒绝、逐文件查看。
- Terminal panel：命令输出、退出码、运行时长。
- Settings：模型、MCP server、权限策略、memory、日志。

前端状态管理建议：

- 服务端状态来自 daemon event stream。
- UI 本地只保存视图状态，例如当前 tab、展开项、输入框草稿。
- 所有 session、message、tool call、approval 的真实状态以 daemon 为准。

前端不要直接访问文件系统、git 或 shell。所有本地能力必须通过 daemon 协议调用，以保证审批、审计和沙箱一致。

## 8. Daemon 核心模块

### 8.1 RpcGateway

职责：

- 暴露 JSON-RPC over WebSocket。
- 校验请求 schema。
- 管理连接认证。
- 将请求分发到 service。
- 将 daemon 内部事件广播给订阅的 UI。

主要方法：

- `session.create`
- `session.list`
- `session.open`
- `session.sendMessage`
- `session.cancel`
- `tool.list`
- `approval.resolve`
- `workspace.open`
- `settings.update`

### 8.2 SessionManager

职责：

- 管理 workspace 与 session 生命周期。
- 维护当前 turn 状态。
- 负责消息落库。
- 负责恢复历史记录。
- 将 agent event 转换为 UI event。

Session 状态：

- `idle`
- `running`
- `waiting_approval`
- `cancelling`
- `failed`

不建议支持隐式多任务并发修改同一 workspace。第一版每个 workspace 同时只允许一个写入型 agent turn，降低文件冲突和审批复杂度。

### 8.3 AgentRuntime

职责：

- 构建模型上下文。
- 调用 model provider。
- 解析工具调用。
- 调度工具。
- 汇总结果继续推理。
- 输出最终回复。

AgentRuntime 不直接执行系统操作。所有工具必须走 `ToolRouter`，所有高风险工具必须经过 `ApprovalManager`。

### 8.4 ToolRouter

职责：

- 注册工具。
- 根据 tool name 分发调用。
- 校验 tool input schema。
- 调用 sandbox risk evaluation。
- 触发 approval。
- 写入 tool call 日志。
- 返回结构化结果。

内置工具：

- `file.read`
- `file.write`
- `file.patch`
- `file.list`
- `shell.run`
- `git.status`
- `git.diff`
- `git.apply`
- `mcp.call`
- `memory.search`
- `memory.write`

工具输入输出必须结构化，避免使用纯文本承载状态。不要截取字符串、列表或字典作为持久化事实，避免数据一致性问题。

## 9. 协议设计

协议采用 JSON-RPC 2.0，WebSocket 负责双向事件。

请求示例：

```json
{
  "jsonrpc": "2.0",
  "id": "req_01",
  "method": "session.sendMessage",
  "params": {
    "sessionId": "sess_01",
    "message": {
      "role": "user",
      "content": "帮我修复测试失败"
    }
  }
}
```

事件示例：

```json
{
  "type": "tool_call_started",
  "sessionId": "sess_01",
  "toolCallId": "tool_01",
  "toolName": "shell.run",
  "input": {
    "command": "cargo test",
    "cwd": "D:/study/miniQ"
  }
}
```

协议类型分三类：

- Request：UI 主动调用 daemon。
- Response：daemon 返回一次性结果。
- Event：daemon 推送运行状态。

所有协议类型都必须有版本字段或 schema 版本。协议变更只向前推进，不为旧协议堆叠兼容层。

## 10. Memory 与 SQLite

SQLite 是本地事实源，用于恢复会话、检索历史、审计工具调用。

基础表：

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Memory 分类：

- Global memory：用户偏好、常用模型、通用协作规则。
- Workspace memory：项目结构、运行命令、测试方式、约定。
- Session memory：当前对话中的短期任务状态。

写入 memory 必须显式标注 scope。agent 不能把临时推测直接写入长期 memory，应由规则或审批控制。

## 11. 安全、审批与沙箱

安全系统分为三层：

1. 静态权限：工具是否启用、workspace 是否允许写入。
2. 风险分级：每次工具调用按路径、命令、参数、影响范围计算风险。
3. 用户审批：中高风险操作必须显示审批卡片并等待用户确认。

风险等级：

- `low`：只读文件、git status、目录列表。
- `medium`：修改 workspace 内文件、运行测试、安装依赖。
- `high`：删除文件、移动大量文件、执行网络命令、修改 git 历史。
- `blocked`：workspace 外写入、危险系统命令、访问未授权路径。

审批卡片必须展示：

- 工具名。
- 工作目录。
- 完整命令或完整文件路径。
- 风险原因。
- 预期影响。
- 允许一次。
- 拒绝。
- 对相同模式本会话允许。

沙箱规则：

- 默认只允许访问当前 workspace。
- workspace 外路径需要用户显式授权。
- shell 命令默认在 workspace cwd 下执行。
- 文件写入必须通过 file tool 或 patch tool。
- 高风险命令不允许通过字符串变形绕过审批。

## 12. MCP / ACP 集成

MCP 集成目标：

- 允许用户配置本地或远程 MCP server。
- 将 MCP tools 映射进 `ToolRouter`。
- MCP 调用同样进入审批和审计系统。
- MCP 返回值以结构化 JSON 保存，不在 daemon 内做随意截断。

ACP / JSON-RPC 集成目标：

- 允许 miniQ 与其他 agent server 或 worker 通信。
- 支持本地 agent daemon 作为 server。
- 支持 UI 作为 client 连接 daemon。
- 预留远程 agent worker，但第一版不实现复杂分布式调度。

第一版 MCP 管理界面需要支持：

- 添加 server。
- 启用 / 禁用 server。
- 查看 server 状态。
- 查看 tools 列表。
- 测试连接。
- 查看最近调用日志。

## 13. 模型 Provider

模型层通过 adapter 抽象：

```text
ModelProvider
  ├─ complete(request) -> stream
  ├─ list_models()
  └─ validate_config()
```

第一版建议支持：

- OpenAI-compatible API。
- Anthropic-compatible API。
- 本地模型 OpenAI-compatible endpoint。

Provider 不直接调用工具。工具调用由 AgentRuntime 解析模型输出后交给 ToolRouter 执行。

## 14. 开发里程碑

### Phase 0：项目骨架

- 初始化 Tauri 2 + Svelte/React。
- 初始化 Rust workspace。
- 建立 `miniq-protocol`、`miniq-daemon`、`miniq-memory`。
- 建立 SQLite migration。
- 建立 JSON Schema 生成流程。

验收标准：

- 桌面 app 可以启动 daemon。
- UI 可以连接 WebSocket。
- UI 可以展示 daemon health 状态。

### Phase 1：聊天闭环

- 实现 session create/list/open。
- 实现 message 持久化。
- 接入一个 OpenAI-compatible provider。
- UI 展示 streaming assistant response。

验收标准：

- 用户可以创建会话并获得模型回复。
- 关闭 app 后重新打开能恢复历史会话。

### Phase 2：工具闭环

- 实现 file read/list。
- 实现 shell run。
- 实现 git status/diff。
- 实现 ToolRouter。
- 实现 tool call event stream。

验收标准：

- agent 能读取项目文件。
- agent 能运行只读命令。
- UI 能看到工具调用过程和结果。

### Phase 3：审批与写入

- 实现 ApprovalManager。
- 实现 file patch/write。
- 实现命令风险分级。
- 实现审批卡片。
- 实现 audit_events。

验收标准：

- 写文件前会请求审批。
- 高风险 shell 命令会被拦截或审批。
- 用户拒绝后 agent 能收到结构化拒绝结果。

### Phase 4：MCP 与 memory

- 实现 MCP client 管理。
- 将 MCP tools 接入 ToolRouter。
- 实现 workspace memory。
- 实现 memory search/write。

验收标准：

- 用户能添加 MCP server 并调用工具。
- agent 能读取和写入 workspace memory。
- MCP 调用进入审批与审计链路。

### Phase 5：产品化

- 多窗口或系统托盘。
- 自动更新。
- 日志导出。
- 设置导入导出。
- 崩溃恢复。
- 打包签名。

验收标准：

- Windows/macOS/Linux 至少完成一个平台的稳定安装包。
- 核心会话、工具、审批、memory 可长期使用。

## 15. 测试策略

Rust 测试：

- protocol schema 测试。
- ToolRouter 单元测试。
- sandbox 风险分级测试。
- SQLite migration 测试。
- daemon JSON-RPC 集成测试。

前端测试：

- timeline 渲染。
- approval 卡片交互。
- diff viewer 展示。
- settings 表单校验。

端到端测试：

- 启动 desktop。
- daemon health check。
- 创建 session。
- 发送消息。
- 触发 tool call。
- 审批文件修改。
- 验证 SQLite 写入。

如果项目存在 uv 环境，Python 测试和脚本运行使用 uv。若存在后端目录，进入后端目录执行测试命令。

## 16. 第一版最小可用范围

MVP 必须包含：

- Tauri 桌面 app。
- 本地 Rust daemon。
- JSON-RPC over WebSocket。
- SQLite session/message/tool_call 存储。
- OpenAI-compatible model provider。
- file read/list。
- shell run。
- git status/diff。
- command approval。
- workspace sandbox。
- tool call timeline。
- 基础 settings。

MVP 暂不包含：

- 远程多 agent 调度。
- 团队协作。
- 插件市场。
- 复杂权限继承。
- 旧协议兼容层。
- 多 workspace 并发写入。

## 17. 工程规范

- 类型优先：协议、工具输入、工具输出都必须有强类型。
- schema 优先：跨进程数据结构必须生成或校验 JSON Schema。
- 高内聚低耦合：service 只依赖必要 trait，不跨层调用具体实现。
- 无重复实现：相同工具校验、路径规范化、审批判断必须抽象复用。
- 不过度设计：第一版只实现本地单用户 cowork，不提前做复杂分布式平台。
- 不保留旧逻辑：重构后删除旧实现和旧测试。
- 不做数据截取：持久化和协议传输保持完整数据，UI 层用折叠展示解决可读性。
- 审计不可绕过：任何工具调用都必须经过 ToolRouter。

## 18. 推荐下一步

建议按以下顺序开工：

1. 创建 Rust workspace 与 Tauri app。
2. 定义 `miniq-protocol` 的 request/response/event 类型。
3. 实现 daemon health check 与 WebSocket 连接。
4. 建立 SQLite migration 和 session/message 存储。
5. 打通第一条聊天 streaming。
6. 接入 ToolRouter 和只读工具。
7. 加入审批系统后再开放写入工具。

这条路线可以先做出一个小而完整的本地 cowork 闭环，再逐步吸收 MCP、memory、sandbox 和更强的 agent runtime。核心目标是让产品从第一版开始就具备清晰边界、安全控制和长期可维护的本地架构。
