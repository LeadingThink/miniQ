# miniQ Agent 运行时

miniQ 的 Agent 运行时吸收了 DeepSeek Harness 与 OpenAI Codex 开源实现中已经验证的机制，重点解决长任务连续性、工具吞吐和失控恢复。当前实现保持现有 crate 边界，不引入并行内核或另一套会话系统。

## 每轮上下文

`miniq-daemon` 把可恢复的会话记录保存到 SQLite 的 `model_context_snapshots` 表。模型每次请求使用该记录的副本；图片历史会按当前需要选择发送的像素。快照包括：

- user 和 assistant 消息；
- assistant 发出的完整 tool calls；
- 对应的 tool results；
- 快照对应的最后一条持久消息 ID。
- 已观察图片的原图引用和结构化来源档案，独立于模型文字摘要保存。

下一轮先恢复快照，再追加该消息 ID 之后的新用户消息。这样模型获得的是完整工具记录，而不是只有聊天正文的近似历史。快照按 session 覆盖写入，数据库迁移位于 `migrations/0006_model_context.sql`。

工具执行前后也会保存 checkpoint。失败或取消时保留已确认结果与未完成标记，下一轮按最新请求继续；不会把未确认的工具执行当作成功结果。

图片历史保留最新用户参考批次和最近两个工具图片批次，其余按会话引用回读。默认查看使用有界预览，精细核查可读取原图；电脑控制截图保持原尺寸。详见 [图片历史管理与本机对照实测](image-history-management.md)。

## 上下文压缩

默认软上限为 96,000 个估算 token，可通过环境变量调整：

```text
MINIQ_CONTEXT_TOKENS=128000
```

配置值最低为 8,000。达到上限后按以下顺序处理：

1. 裁剪较早且超过 4,000 token 的工具结果，保留工具名、调用关系和结果摘要标记。
2. 如果仍超限，保留最近一个完整用户回合，把更早消息分批交给当前模型生成工作摘要。
3. 用摘要、最近完整回合和当前消息组成新的模型上下文。
4. 发出 `context_compacted` 事件，向客户端报告压缩前后估算 token、摘要消息数和被裁剪的工具结果数。

压缩边界会向前回溯到 user 消息，避免留下没有对应 tool call 的孤立 tool result。

## 工具调度

同一步中互不影响的只读工具会并行执行：

```text
file_read, file_list, file_glob, file_grep,
git_status, git_diff, doc_read, skill_read, memory_search
```

文件写入、shell、网络、MCP 和需要审批的操作保持串行。新增工具默认不进入并行白名单，只有确认无副作用、无审批依赖且结果顺序不影响正确性后才能加入。

## 失控保护

- 交互式会话不再设置固定的模型 step 上限；取消、重复工具批次检测和上下文压缩仍会阻止失控任务。子 agent 仍默认最多执行 32 个 step，也可通过 `maxTurns` 显式设置 1 到 96 的预算。
- 完全相同的工具调用批次连续出现 4 次时主动停止，避免模型重复读取或执行同一动作。
- 原有取消信号在每个 step 和工具执行阶段继续生效。
- 写操作仍经过风险分级、审批、checkpoint 和审计链路。

## 代码位置

- 上下文预算和压缩：`crates/miniq-agent/src/context.rs`
- step 循环、并行白名单和重复检测：`crates/miniq-agent/src/lib.rs`
- 快照恢复与保存：`crates/miniq-daemon/src/turn.rs`
- SQLite 存储：`crates/miniq-memory/src/store/model_context.rs`
- 客户端事件：`crates/miniq-protocol/src/event.rs`

## 后续演进

当前实现优先落地高价值的运行时能力，还不是完整的插件化 harness。下一阶段应按以下顺序推进：

1. 用持久事件日志覆盖失败、取消和恢复中的每个 step，让任意中断点都可以确定性重放。
2. 把模型、上下文策略、工具策略和审批策略收敛成稳定接口，再开放插件扩展。
3. 增加真实 provider、审批和压缩组合测试，以及长任务恢复评测。
4. 为压缩率、重复调用、工具延迟和恢复成功率建立运行时指标。

这些演进必须复用当前 snapshot、协议事件和审计表，不建立第二套并行状态源。
