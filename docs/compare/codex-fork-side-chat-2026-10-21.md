# Codex 的分支与侧边聊天：源码对照与 miniQ 落地方案

> 日期：2026-10-21　基线：`40ef043`（desktop 0.1.165 之后）
>
> 一句话结论：**分叉（fork）已经可用，侧边聊天还没有按 Codex 的语义实现。**
> 现在状态栏里的“临时聊天”是一个独立的新会话，不继承主对话上下文；Codex 的 side 是
> “临时 fork + 边界提示 + 继承历史只给模型看 + 关闭即弃”。
>
> **实施状态（2026-10-21）**：本方案的 P0 后端语义与 P1 前端入口已落地，
> 详见第 10 节。上文保留设计时的差距分析，便于回溯。

---

## 0. 给同事的口径

| 能力 | 现状 | 说明 |
| --- | --- | --- |
| 分叉 | **已有**（0.1.50 起） | 每条助手回复 hover 后的小分支图标；`session.fork` 在 SQLite 里复制到指定回复，父会话不变 |
| 侧边聊天 | **只做了壳**（0.1.161） | 独立新会话，不继承上下文；会进入会话列表；关闭即删；15 分钟空闲自动释放 |
| Codex 式侧聊 | **未实现** | 上周反馈里真正要的部分：继承主对话、边界隔离、不污染主对话、不占列表 |

所以回答“功能有在做吗”：分叉做了，侧聊做了一半，剩下的一半是语义问题，不是 UI 问题。

---

## 1. Codex 是怎么做的

### 1.1 一个底层动作，两种产品形态

Codex 的 fork 和 side chat 共用 `thread/fork`，差别只在参数和生命周期：

| | Fork（分叉） | Side chat（侧边聊天） |
| --- | --- | --- |
| 底层 RPC | `thread/fork` | `thread/fork` |
| 持久化 | 持久，生成新 thread | `ephemeral: true`，不落盘 |
| 复制范围 | 到 `last_turn_id`（含） | 到最新 turn |
| 历史展示 | 新 thread 显示完整历史 | `exclude_turns: true`，UI 只显示边界之后 |
| 提示词 | 继承原配置 | 追加 side developer instructions + boundary prompt |
| 生命周期 | 独立会话，长期存在 | 切回父对话/关闭即丢弃，不能重命名 |
| 数量 | 任意 | 每个父对话同时只允许一个 |

关键协议字段（`app-server-protocol/src/protocol/v2/thread.rs:544`）：

| 字段 | 作用 |
| --- | --- |
| `thread_id` | 源 thread |
| `last_turn_id` | 复制到该 turn（含），之后的 turn 丢弃 |
| `before_turn_id` | 复制到该 turn 之前（不含），与 `last_turn_id` 互斥 |
| `ephemeral` | 不持久化；fork 只活在内存里 |
| `exclude_turns` | 返回 thread 时不带历史 turns，UI 从边界开始 |
| `developer_instructions` | 覆盖/追加开发者指令，side 用来注入只读策略 |
| `config` / `model` / `cwd` / `approval_policy` | 继承或覆盖运行配置 |

约束：
- `last_turn_id` 和 `before_turn_id` 不能同时给；
- 被引用的 turn 不能正在运行；
- `experimentalPredictionMode` 必须搭配 `ephemeral: true`，且不能带配置覆盖；
- 分叉一个 paginated thread 且 `ephemeral + includeTurns` 会被拒绝。

### 1.2 fork 的执行链

1. `app-server/src/request_processors/thread_processor.rs:5133` 校验参数、读取源 thread；
2. 按 `last_turn_id` / `before_turn_id` 截出 history；
3. `core/src/thread_manager.rs:1559` `fork_thread_from_history`：
   - `ForkSnapshot::Interrupted`：把源 thread 的在途 turn 当作 interrupted 快照，
     不共享运行时状态；
   - `InitialHistory::Resumed` + `ForkPersistence::Copied`：历史复制到新 thread；
4. 新 thread 记录 `forked_from_id`，父 thread 完全不变；
5. 返回 `ThreadForkResponse` 并广播 `thread/started`。

`forked_from_id` 只描述血缘，不建立父子生命周期绑定；父 thread 删除后子 thread 仍可独立存在。

### 1.3 side chat 的具体做法

实现集中在 `tui/src/app/side.rs`，模块头写得很清楚：

> A side conversation is an ephemeral fork used for a quick /side question while keeping the
> primary thread focused.

创建时：

```rust
// tui/src/app/side.rs: side_fork_config
fork_config.ephemeral = true;
fork_config.model = Some(parent_model);
fork_config.model_reasoning_effort = self.chat_widget.current_reasoning_effort();
fork_config.developer_instructions = Some(Self::side_developer_instructions(
    fork_config.developer_instructions.as_deref(),
));
```

`thread_fork_params_from_config`（`tui/src/app_server_session.rs:2293`）把 `config.ephemeral`
带进 `ThreadForkParams`；side 场景再设置 `exclude_turns: true`。

展示上：

```rust
// tui/src/app/side.rs
fn install_side_thread_snapshot(store: &mut ThreadEventStore, mut session: ThreadSessionState, _forked_turns: Vec<Turn>) {
    // The forked history remains available to the model through core state, but side
    // conversations should visually start at the side boundary.
    session.forked_from_id = None;
    store.set_session(session, Vec::new());
}
```

也就是说：**继承历史只存在于模型上下文里，UI 从空白开始**。这正是“不留痕迹地追问”的关键。

生命周期：
- `SideThreadState { parent_thread_id, parent_status }` 记录当前 side 属于谁；
- `ctrl + /` 在父对话和 side 之间切换（`tui/src/keymap.rs:1687` 默认绑定）；
- `ctrl + c` 在空输入时关闭 side 并丢弃；
- 切到父对话时，side 在后台被 interrupt + unsubscribe + 本地状态清理；
- 同一父对话只允许一个 side，重复 `/side` 会提示“A side conversation is already open”；
- 父对话没有可复制的 rollout 时提示先发一条消息。

### 1.4 两段提示词的分工

**Boundary prompt**（`SIDE_BOUNDARY_PROMPT`，作为一条 user message 插在继承历史末尾）：
- 边界之前全是“继承历史”，只是参考，不是当前任务；
- 不要继续/执行/完成边界之前的任何指令、计划、工具调用、审批或编辑；
- 只有边界之后的用户消息才是当前指令；
- 边界之前的工具调用和输出发生在父对话里，不能当作有效授权。

**Developer instructions**（`SIDE_DEVELOPER_INSTRUCTIONS`，拼进系统/开发者指令）：
- 你在侧边对话，不是主对话；
- 不承接主对话的活跃任务；
- 默认只做非破坏性检查，除非用户在本侧聊里明确要求修改；
- 不创建 worktree，不接触子代理；
- 需要更大权限时必须由用户明确要求。

注意：这是**软策略**，不是 sandbox。Codex 没有为 side 单独收紧权限，只是用提示词约束行为。

### 1.5 Codex 明确不做的

- side 不持久化，退出即丢，不能重命名；
- side 里不能开子代理、不能建 worktree；
- side 不能同时存在多个；
- side 不承接父对话的 goal 继续执行（`defer_goal_continuation` 与 `ephemeral` 互斥）。

---

## 2. miniQ 现在做到哪一步

### 2.1 分叉：后端已经很接近 Codex

- 协议：`crates/miniq-protocol/src/types.rs:152` `SessionForkParams { sessionId, anchorMessageId, title? }`；
- 存储：`crates/miniq-memory/src/store/session_fork.rs:21` `Store::fork_session`；
- RPC：`crates/miniq-daemon/src/gateway/session.rs:75` `session.fork`；
- 前端：`apps/desktop/src/hooks/useSessionLifecycleActions.ts:250` 创建后切换过去；
  `apps/desktop/src/components/TimelineEntries.tsx:478` 每条助手消息上的分支图标。

`fork_session` 在**一个 SQLite 事务**里复制：

| 复制 | 不复制（有意为之） |
| --- | --- |
| 锚点之前的 messages（含附件、`steered`、`assistant_kind`） | 排队中的消息 |
| agent_tasks（含父子关系重映射） | 待审批 |
| tool_calls | 运行中的 turn / 流式文本 |
| artifacts | 源会话的活跃状态 |
| session_model_settings / session_approval_settings | |
| session_plans / turn_plans | |
| session_goals（用量清零） | |
| 锚点命中的 compacted context snapshot | |

这与 Codex 的 `ForkSnapshot::Interrupted` 语义基本一致：只复制已完成的历史，不共享运行时。

`mode = Side` 时只复制 messages（标记 `inherited`）、model/approval settings 和锚点命中的
context snapshot；工具记录、产物、子代理、计划、目标都不复制。

现有缺口：
1. 入口只是 hover 小图标，没有截图里“创建聊天分支”的明确动作；
2. 没有血缘信息（`forked_from_id`），UI 无法显示“分支自 …”；
3. 锚点只校验 `role = 'assistant'`，没有限定 `final / interrupted`；
4. 没有“从最新回复分叉”的菜单入口。

### 2.2 侧边聊天：目前是独立空会话

`apps/desktop/src/components/SideConversationPanel.tsx:86`：

```ts
const session = await client.call<Session>("session.create", {
  workspaceId: workspace.id,
  title: "临时侧聊",
});
```

行为：
- 新会话，**不继承**主对话任何消息或工具结果；
- 复用当前 workspace 的项目记忆（面板上写着“使用当前窗口的项目记忆”）；
- 15 分钟空闲自动 `session.delete`；
- 关闭时 `session.delete`；
- 状态栏按钮开关；
- `session.create` 会触发 `session_status_changed`，前端 `refreshCatalog` 重新拉 `session.list`，
  所以这个“临时”会话**会出现在侧栏**；
- 侧聊里的审批不会在面板里出现（`session.open` 返回了 `approvals`，面板没用）；
- `apps/desktop/src/sideConversation.ts:24` 的 `sideConversationContext` 只有测试在用，是死代码；
- `SideConversationPanel.test.tsx` 还断言“必须调用 session.create”，改语义时要同步更新。

### 2.3 差距表

| 能力 | Codex | miniQ 现状 | 差距 |
| --- | --- | --- | --- |
| 继承对话上下文 | 是（模型可见） | 否 | **核心缺口** |
| 继承历史在 UI 隐藏 | 是 | 不适用（本来就没有） | 需新增 |
| 边界提示 | 有 | 无 | 需新增 |
| 只读倾向 | 有（提示词） | 无 | 需新增 |
| 不出现在会话列表 | 是（ephemeral） | 否 | 需新增 |
| 关闭即弃 | 是 | 是 | 已具备 |
| 只允许一个 | 是 | 是 | 已具备 |
| 父对话状态提示 | 有 | 无 | 可选 |
| 面板内审批 | 有（TUI 内） | 无 | 需补 |
| 快捷键 | `ctrl + /` | 无 | 需新增 |

---

## 3. 目标语义（验收标准）

1. 对一个已有助手回复的会话，点“新建侧边聊天”后：
   - 新侧聊的**模型上下文**包含主对话截至该回复的完整历史；
   - 侧聊 UI 从空白开始，只显示边界之后的消息；
   - 模型明确知道边界之前是参考，不会继续执行主对话的任务。
2. 侧聊不出现在会话列表、搜索结果、审批总览的“可打开会话”里。
3. 关闭面板 / 切换主会话 / 切换项目 / 空闲 15 分钟 / daemon 重启，侧聊都会被删除。
4. 侧聊默认不写文件、不建 worktree、不开子代理、不写长期记忆、不创建计划任务；
   用户明确要求时才允许最小修改。
5. 同一时间只有一个侧聊；父会话没有可继承的助手回复时给出明确提示。
6. 分叉仍然是持久化的独立会话，父会话不变，历史完整可见。

非目标（本期不做）：
- 侧聊持久化/恢复；
- 侧聊重命名；
- 侧聊转正为正式会话（可以后续加“保留为分支”）；
- 侧聊里开子代理或 worktree。

---

## 4. 实现方案

### 4.1 数据模型：迁移 `0028_session_forks.sql`

```sql
-- 1 = 该行只作为模型上下文，不进入任何客户端历史视图。
-- 只有 side fork 会写入 1；普通分叉保持 0，现有行为不变。
ALTER TABLE messages ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_inherited ON messages(session_id, inherited, created_at);

CREATE TABLE session_forks (
  session_id        TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  anchor_message_id TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('branch', 'side')),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_session_forks_parent ON session_forks(parent_session_id);
```

设计要点：

- **`inherited` 是最关键的一列。** 继承消息必须留在 `messages` 表里，因为：
  - 每轮上下文由 `list_messages` 直接读取，分表会让上下文装配变成两套路径；
  - compacted snapshot 的锚点是 message id，分表会让快照失效；
  - 附件、`steered`、`assistant_kind` 已经在消息行里，复制逻辑现成。
- 客户端历史统一加 `inherited = 0`，**不按会话类型分支**。这样普通分叉、普通会话完全不受影响，
  也没有“side 专用查询路径”。
- `session_forks` 不做父会话级联删除：分叉是独立会话，父会话删了子会话仍应存在。
  子会话删除时删掉自己的 fork 行即可。

### 4.2 Store：`fork_session` 增加 mode

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ForkMode { Branch, Side }

pub fn fork_session(
    &self,
    source_session_id: &str,
    anchor_message_id: Option<&str>,
    title: Option<&str>,
    mode: ForkMode,
) -> Result<Session>
```

事务内步骤：

1. **解析锚点**：`None` 时取源会话最新一条 `role='assistant' AND assistant_kind IN ('final','interrupted')`
   且 `inherited = 0` 的消息；没有则返回明确错误（“主对话还没有可继承的回复”）。
2. **校验**：
   - 锚点必须是该会话的 assistant 消息；
   - `mode = Side` 时源会话本身不能是 side（禁止 side of side）；
   - 锚点取 durable 的 `final / interrupted` 行，流式中的 `commentary` 不会被选中。
3. 创建目标 session：
   - branch：`"{源标题} · 分支"`；
   - side：`"侧边聊天 · {源标题}"`（只用于日志/审批，侧栏不显示）。
4. 复制 messages，`inherited = (mode == Side) as i64`。
5. **side 追加边界消息**（同一事务）：
   ```rust
   INSERT INTO messages (id, session_id, role, content, attachments_json, created_at, steered, assistant_kind, inherited)
   VALUES (new_id("msg"), target_id, 'user', SIDE_BOUNDARY_PROMPT, '[]', now_iso(), 0, NULL, 1);
   ```
   作为一条 `inherited = 1` 的 user 消息，它的顺序天然落在继承历史之后、用户第一条侧聊消息之前；
   `list_messages` 会带上它，而所有客户端历史视图会过滤掉它。
6. branch 才复制 `session_plans`、`turn_plans`、`session_goals`；side 跳过。
   原因：`turn.rs` 会把 session goal 和 plan 注入系统提示，side 继承后会误以为要接着完成主任务。
7. **side 不复制 `tool_calls`、`artifacts`、`agent_tasks`。**
   原因：miniQ 的模型上下文只由 `messages` 构成，工具记录属于过程展示；复制过去会让侧聊的
   “过程折叠”里出现主对话的工具调用，而 `tool_calls` 没有 `inherited` 标记可过滤。
   侧聊自己的工具调用会正常写入它自己的 session。
8. 两种模式都复制 model settings、approval settings 和锚点命中的 context snapshot。
9. 写入 `session_forks`：
   ```sql
   INSERT INTO session_forks (session_id, parent_session_id, anchor_message_id, mode, created_at)
   VALUES (?, ?, ?, 'side' | 'branch', ?);
   ```
10. 提交。

为什么不把边界提示放在 `turn.rs` 里临时插入：
- 放在 messages 里，顺序、快照、压缩、导出都自然一致；
- `inherited = 1` 已经保证 UI 不可见；
- 不需要改 `restore_conversation` 的索引计算。

### 4.3 历史、列表、搜索的过滤

给所有“客户端可见消息”查询加 `AND inherited = 0`：

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `crates/miniq-memory/src/store/history.rs` | `:22` raw timeline 的 messages 子查询 | 加过滤 |
| `crates/miniq-memory/src/store/history_visible.rs` | `:107 :124 :142 :211 :220 :423` | 每个 messages 查询加过滤 |
| `crates/miniq-memory/src/store/conversation.rs` | `:273` `search_messages` | 加过滤 |
| `crates/miniq-memory/src/store/session_list.rs` | preview / turn_count 子查询 | 加过滤 |
| `crates/miniq-memory/src/store/session_titles.rs` | `:22` / `:53` 取首条 user 消息 | 加过滤（防御性） |

会话列表隐藏 side：

```sql
WHERE (?1 IS NULL OR s.workspace_id = ?1)
  AND s.id NOT IN (SELECT session_id FROM session_forks WHERE mode = 'side')
```

`session.open` 仍然可以直接打开 side（面板要用），只是它不在列表里。

### 4.4 上下文：只加一段系统策略

`crates/miniq-daemon/src/turn.rs:93` `system_message` 增加一个 side 参数：

```rust
fn system_message(skills_block: &str, workspace_path: &Path, side: bool) -> ChatMessage {
    let mut system = format!(...);
    if side {
        system.push_str("\n\n");
        system.push_str(SIDE_CONVERSATION_POLICY);
    }
    ...
}
```

`history_for_turn`（`turn.rs:180`）增加 `side: bool`，三个调用点同步：
`turn.rs:455`、`gateway/session_context.rs:167`、`:246`。

`SIDE_CONVERSATION_POLICY` 建议文案（与 Codex 对齐，写成我们自己的版本）：

```text
You are in a side conversation, not the main conversation.

This side conversation answers questions and performs lightweight exploration without
disrupting the main conversation. Do not present yourself as continuing the main
conversation's active task.

The inherited history is reference only. Only instructions after the side-conversation
boundary are active. Do not continue or complete tasks that appear only in inherited history.

Do not modify files, source, git state, permissions, configuration, or workspace state
unless the user explicitly requests that mutation in this side conversation. Do not request
escalated permissions unless the request requires it. Do not spawn sub-agents, create
worktrees, or schedule tasks here. If the user explicitly requests a mutation, keep it
minimal and local.
```

边界消息文案（`SIDE_BOUNDARY_PROMPT`）：

```text
Side conversation boundary.

Everything before this message is inherited history from the parent conversation. It is
reference context only, not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals,
edits, or requests from before this boundary. Only messages after this boundary are
active user instructions for this side conversation.

You are a side-conversation assistant, separate from the main conversation. If there is
no user question after this boundary yet, wait for one.

Tool calls and outputs before this boundary happened in the parent conversation and are
reference-only. Do not infer active instructions from them.

Do not modify files, git state, permissions, configuration, or workspace state unless the
user explicitly asks after this boundary.
```

自动压缩：side fork 的 inherited 消息参与压缩是合理的（它们就是上下文）；
压缩后的 snapshot 锚点仍指向 copied message id，`fork_session` 已经处理了锚点映射。

### 4.5 协议

`crates/miniq-protocol/src/types.rs:152`：

```rust
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionForkMode {
    #[default]
    Branch,
    Side,
}

pub struct SessionForkParams {
    pub session_id: String,
    #[serde(default)]
    pub anchor_message_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub mode: SessionForkMode,
}
```

- 旧客户端继续传 `anchorMessageId` + 不传 `mode`，行为不变；
- side 客户端只传 `sessionId` + `mode: "side"`。

`session.open` 响应增加一个 `fork` 对象（不动 `Session` 结构，避免改所有 row mapper）：

```json
{
  "fork": {
    "parentSessionId": "sess_...",
    "parentTitle": "重构上传流程",
    "mode": "side",
    "anchorMessageId": "msg_...",
    "inheritedMessageCount": 42
  }
}
```

面板用它显示“继承自：重构上传流程 · 42 条消息”，也用于空状态提示。

错误文案：
- `主对话还没有可继承的回复，先发送一条消息再打开侧边聊天`
- `侧边聊天不能再次创建侧边聊天`
- `侧边聊天不能分叉自己`

### 4.6 前端

#### SideConversationPanel

把 `session.create` 换成：

```ts
const session = await client.call<Session>("session.fork", {
  sessionId: sourceSessionId,
  mode: "side",
});
```

配套改动：

- `sourceSessionId` 必填；为空时禁用发送并提示“先打开一个对话”；
- fork 后调用一次 `session.open` 拿 `fork.inheritedMessageCount`，空状态显示
  “已继承 42 条上下文，可以开始追问”；
- `release()` 保持不变（`session.delete`）；
- 增加释放时机：`sourceSessionId` 变化、workspace 变化、面板关闭；
- 标题从“临时聊天”改为“侧边聊天”，副标题显示父对话标题；
- 面板底部显示父对话状态（`session_status_changed` 对 `sourceSessionId`）：
  “主对话正在运行 / 等待审批”，点击可回到主对话；
- 审批：P1 先复用 `ApprovalCard` 在面板里渲染 `session.open` 返回的 `approvals`，
  并监听审批事件；否则主对话处于“询问”模式时侧聊会卡住。

#### 消息上的“创建聊天分支”

`TimelineEntries.tsx:478` 现在是一个 `GitBranch` 图标按钮。改成：

- `title/aria-label` 改为“创建聊天分支”；
- 在最后一条 `final` 回复上显示带文字的胶囊按钮（和截图一致），其余消息保持 hover 图标；
- 运行中的消息保持禁用，文案“本轮完成后可分支”。

#### Composer 加号菜单

`Composer.tsx:600` 的 `composer-plus-panel` 增加两项：

```
新建侧边聊天        Ctrl+Alt+S（macOS：⌘⇧S）
从最新回复分叉
```

新增可选 props：`onNewSideChat`、`onForkLatest`，由 `AppShell.tsx:289` 传入。
两个动作都要求当前有会话；没有会话时禁用并给 tooltip。

`从最新回复分叉` 直接调用 `app.actions.forkSession(latestFinalMessageId)`；
任意位置分叉仍然走消息上的“创建聊天分支”。

#### 快捷键

- `apps/desktop/src/shortcuts.ts`：`COMMAND_IDS` 增加 `newSideChat`，
  `SHORTCUTS` 增加 `⌘⇧S / Ctrl+Alt+S`；
- `apps/desktop/src/hooks/useAppCommands.ts`：增加 case，调用 `onNewSideChat`；
- `apps/desktop/src-tauri/src/app_menu.rs`：`command_spec` 增加
  `"newSideChat" => ("新建侧边聊天", Some("CmdOrCtrl+Shift+S"))`；
  现有测试会校验 accelerator 唯一性，`⌘⇧S` 目前空闲。

#### 状态栏

`AppStatus.tsx:147` 的按钮文案从“临时聊天”改为“侧边聊天”，行为不变。

### 4.7 生命周期与清理

| 时机 | 行为 |
| --- | --- |
| 面板关闭 | `session.delete`（已有） |
| 切换主会话 | 先取消运行中的 turn，再删除 side |
| 切换 workspace | 删除 side（已有类似逻辑） |
| 空闲 15 分钟 | 删除（已有） |
| daemon 启动 | `recover_interrupted_work` 里 purge 所有 `mode='side'` 的会话 |
| 崩溃 | side 不出现在列表，下次启动被 purge；不会泄漏到 UI |
| 主对话运行中打开侧聊 | 允许；锚点取最后一条完成的回复 |
| 侧聊运行中关闭 | 先 `session.cancelTurn`，再 delete；避免删除运行中的会话 |

启动 purge 建议：

```rust
pub fn purge_side_sessions(&self) -> Result<usize> {
    // 按 delete_session 的依赖顺序清理，或复用同一事务
}
```

在 `main.rs:39` 的 `recover_interrupted_work()` 之后调用。

### 4.8 安全与边界

| 风险 | 处理 |
| --- | --- |
| 侧聊修改文件 | 提示词约束（与 Codex 一致）；如需硬约束，P2 在 session 级别注入只读 tool policy |
| 侧聊开子代理 / worktree | 提示词禁止；P2 在 `agent_run` / `worktree` 工具入口按 fork mode 拒绝 |
| 侧聊写长期记忆 | `learn.rs:26` 的 transcript 装配跳过 side 会话 |
| 侧聊创建计划任务 | `schedule.create` 要求显式 UI 入口，不在侧聊暴露 |
| 侧聊审批无人处理 | 面板内渲染审批卡；或在 side 上默认只读审批模式 |
| 继承消息泄漏到客户端 | 所有历史查询统一 `inherited = 0`，并加查询级测试 |
| 侧聊出现在审批总览并跳转 | 审批总览对 side 会话只显示标题、不跳转，或在面板内处理 |

---

## 5. 测试计划

Rust（`crates/miniq-memory`、`crates/miniq-daemon`）：

1. `side_fork_copies_history_as_inherited_and_adds_boundary`：
   - 源会话 3 轮；side fork 后 messages 数量 = 6 + 1 边界；
   - 所有复制行 `inherited = 1`，边界是最后一条 inherited user 消息。
2. `visible_history_hides_inherited_rows`：`HistoryView::Visible` 返回空；raw view 也返回空。
3. `branch_fork_keeps_history_visible`：普通分叉的 `inherited = 0`，可见历史完整。
4. `side_fork_skips_goals_and_plans`。
5. `side_fork_skips_tool_calls_artifacts_and_agent_tasks`：`session.open` 的
   `toolCalls` / `artifacts` 为空，过程折叠里没有父对话的工具。
6. `side_fork_rejects_side_source`。
7. `latest_anchor_prefers_final_or_interrupted`（忽略 commentary）。
8. `session_list_excludes_side_and_inherited_preview`。
9. `search_messages_ignores_inherited`。
10. `delete_session_removes_fork_row`。
11. `recover_interrupted_work_purges_side_sessions`。
12. `system_prompt_contains_side_policy_only_for_side`。
13. `history_for_turn_includes_boundary_after_inherited`。

前端（vitest）：

1. `SideConversationPanel` 调用 `session.fork` 且 `mode: "side"`，不再调用 `session.create`；
2. 空状态显示继承条数；
3. 切换 `sourceSessionId` 触发释放；
4. `Composer` 加号菜单出现“新建侧边聊天 / 从最新回复分叉”；
5. `shortcuts` 注册 `⌘⇧S / Ctrl+Alt+S`；
6. `TimelineEntries` 的“创建聊天分支”可点击并在运行中禁用。

---

## 6. 分阶段落地

**P0：语义与数据层（后端）**
- 迁移 0028；
- `fork_session(mode)` + 边界消息 + 跳过 goals/plans；
- 历史/列表/搜索过滤；
- 系统策略注入；
- 协议字段 + `session.open` 的 `fork` 信息；
- 启动 purge；
- Rust 测试。

**P1：入口与面板（前端）**
- 面板改用 `session.fork`，空状态、父标题、释放时机；
- 消息上的“创建聊天分支”胶囊；
- 加号菜单两项；
- 快捷键 + 原生菜单；
- 面板内审批；
- 前端测试。

**P2：打磨**
- 父对话状态提示（运行中/待审批）；
- “分支自 …”血缘 chip；
- 侧聊“保留为分支”；
- 硬性工具策略（子代理/worktree/计划任务）；
- 移动端/远程主机适配。

---

## 7. 风险与取舍

1. **过滤遗漏**：`inherited = 0` 需要覆盖所有客户端历史查询。建议把条件抽成共享 SQL 片段，
   并在 `history`、`history_visible`、`search`、`list` 各加一条“继承不可见”的测试。
2. **提示词是软约束**：和 Codex 一样，不做沙箱级只读。真正需要硬约束时再加工具策略。
3. **Prompt cache**：side fork 复制的是同一前缀，模型请求可复用缓存；边界消息只追加在末尾，
   不会破坏前缀。这是 fork 相比“摘要后新建会话”的优势。
4. **删除与运行竞态**：关闭侧聊时如果 turn 还在跑，必须先取消再删，否则删除后 turn 仍会写事件。
5. **审批可见性**：侧聊的审批如果不能就地处理，会让功能“看起来卡住”，P1 必须解决。
6. **side of side**：直接禁止，避免继承链和 inherited 标记叠加。
7. **不复制 goal/plan**：这是与普通分叉最重要的差异，漏掉会让侧聊试图继续主任务。

---

## 8. 源码索引

| 主题 | Codex | miniQ |
| --- | --- | --- |
| fork 协议 | `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:544` | `crates/miniq-protocol/src/types.rs:152` |
| fork 请求处理 | `codex-rs/app-server/src/request_processors/thread_processor.rs:5133` | `crates/miniq-daemon/src/gateway/session.rs:75` |
| fork 执行 | `codex-rs/core/src/thread_manager.rs:1559` | `crates/miniq-memory/src/store/session_fork.rs:21` |
| side 生命周期 | `codex-rs/tui/src/app/side.rs:1` | `apps/desktop/src/components/SideConversationPanel.tsx` |
| side 配置 | `codex-rs/tui/src/app/side.rs:side_fork_config` | 待实现 |
| side 提示词 | `codex-rs/tui/src/app/side.rs:SIDE_BOUNDARY_PROMPT / SIDE_DEVELOPER_INSTRUCTIONS` | 待实现 |
| fork 参数构造 | `codex-rs/tui/src/app_server_session.rs:2293` | `apps/desktop/src/hooks/useSessionLifecycleActions.ts:250` |
| 快捷键 | `codex-rs/tui/src/keymap.rs:1687`（ctrl+/） | `apps/desktop/src/shortcuts.ts` |
| 会话列表 | — | `crates/miniq-memory/src/store/session_list.rs:19` |
| 可见历史 | — | `crates/miniq-memory/src/store/history_visible.rs` |
| 启动恢复 | — | `crates/miniq-daemon/src/main.rs:39` |

---

## 9. 参考行为速查

- Codex side 打开条件：父 thread 已加载、已产生至少一条消息；否则提示先发消息。
- Codex side 只允许一个；再次 `/side` 提示“A side conversation is already open”。
- Codex side 不能重命名（`SIDE_RENAME_BLOCK_MESSAGE`）。
- Codex side 关闭时：`turn/interrupt` → `thread/unsubscribe` → 清本地状态。
- Codex side 的模型历史包含父历史，但 UI 从边界开始（`install_side_thread_snapshot`）。
- Codex fork 是持久复制；side 是 ephemeral，不写 thread metadata。

---

## 10. 实施记录（2026-10-21）

### 后端

| 文件 | 改动 |
| --- | --- |
| `migrations/0028_session_forks.sql` | `messages.inherited`、`session_forks`（含 `inherited_message_count`）与索引 |
| `crates/miniq-protocol/src/types.rs` | `SessionForkMode`、`SessionForkParams.mode`、可选锚点、`SessionForkInfo` |
| `crates/miniq-memory/src/store/session_fork.rs` | `fork_session(mode, boundary)`；side 只复制消息/设置/快照并写边界；`session_fork_info`；`purge_side_sessions` |
| `crates/miniq-memory/src/store/{history,history_visible,conversation,session_list,session_titles}.rs` | 客户端历史、搜索、列表预览统一过滤 `inherited = 0`；列表排除 side |
| `crates/miniq-memory/src/store/workspaces.rs` | 删除会话/工作区时清理 `session_forks` |
| `crates/miniq-daemon/src/side_conversation.rs` | `BOUNDARY_PROMPT`、`POLICY`、`is_side` |
| `crates/miniq-daemon/src/turn.rs` | `history_for_turn(..., side)` 注入侧聊策略 |
| `crates/miniq-daemon/src/gateway/session.rs` | `session.fork` 传 mode/boundary；`session.open` 返回 `fork` 信息 |
| `crates/miniq-daemon/src/main.rs` | 启动时清理上一进程遗留的 side 会话 |
| `crates/miniq-daemon/src/learn.rs` | 侧聊不参与技能沉淀 |

### 前端

| 文件 | 改动 |
| --- | --- |
| `SideConversationPanel.tsx` | 改用 `session.fork(mode: "side")`；继承条数/父标题；关闭、切换主对话、切换项目时取消并删除 |
| `SessionMenu.tsx` / `SessionMenu.css` | 会话“…”菜单：重命名、置顶、新建侧边聊天、分叉子菜单、归档；样式对齐截图 |
| `AppStatus.tsx` | 接入会话菜单；状态栏入口改名“侧边聊天” |
| `TimelineEntries.tsx` / `experience.css` | 最后一条回复显示“创建聊天分支”胶囊 |
| `AppShell.tsx` | `openSideConversation`、侧聊会话状态、快捷键事件 |
| `shortcuts.ts` / `useAppCommands.ts` / `nativeMenuBridge.ts` / `app_menu.rs` | `Ctrl+Alt+S`（mac `⌘⇧S`）、`Ctrl+Alt+R`、`Ctrl+Alt+P` 与原生菜单同步 |

### 验证

- `cargo test -p miniq-memory --lib`：90 passed。
- `cargo test -p miniq-daemon --lib side_prompt`：1 passed。
- `cargo check -p miniq-memory -p miniq-daemon`：通过。
- `npx tsc --noEmit`：通过。
- 前端定向测试：`SideConversationPanel`、`SideConversation`、`SessionMenu`、`AppStatus`、`shortcuts`、`nativeMenuBridge` 共 28 passed。

### 仍属 P2

- 面板内审批卡（目前侧聊审批仍由全局审批总览承载）。
- 父对话“正在运行/待审批”状态条。
- 子代理、worktree、计划任务的硬性工具拦截（当前为提示词约束）。
- 侧聊“保留为分支”。
