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

默认从 provider 报告的上下文窗口扣除输出预留和 5% 安全边际，工具 schema 和消息策略开销也计入请求预算。provider 未报告容量时使用 64,000 个估算 token。`MINIQ_CONTEXT_TOKENS` 可以限制本地预算（最低 8,000）。

Responses 任务请求启用 `context_management` compaction，其触发阈值为可用输入预算的 80%，早于本地压缩上限。`MINIQ_RESPONSES_COMPACT_THRESHOLD` 可以进一步降低原生触发阈值。标题、计划审查和本地摘要等内部请求不启用此参数，Chat Completions 和 Anthropic 请求也不携带 Responses 专用字段。

收到成功响应中的 compaction item 后，将其原样保存、回放，并移除它覆盖的旧活动 input。完整工具结果仍保存在本地 checkpoint；模型可通过 `tool_history list/read` 按调用 ID 和 Unicode 字符 offset 分页回读。归档元数据不发送给 provider，持久化仍使用原有敏感字段脱敏。完整聊天记录保持在 SQLite 中。

当活动请求超过本地预算时：

1. 把过大的工具结果替换为可恢复的 `toolCallId` 引用。
2. 如果仍超限，保留必要系统前缀和最近完整回合，一次生成包含目标、授权、约束、进度、证据、失败原因和下一步的 handoff 摘要；超出可用输入容量时才分批。
3. 将摘要作为历史数据保留，避免把旧工具输出提升为新系统指令。已收到的原生 compaction item 仍保留。
4. 发出 `context_compacted` 事件，报告前后估算 token。

压缩保持工具调用与结果的配对边界。系统策略和工具 schema 的前缀在同一任务内保持稳定，有利于 provider 前缀缓存。原生压缩需要 Responses endpoint 支持 `context_management`；本次修改基于当前自定义 provider 已支持该参数的配置，不会对未知参数错误静默重试。

官方接口语义参考：[OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)。

## 工具调度

同一步中互不影响的只读工具会并行执行：

```text
file_read, file_list, file_glob, file_grep,
git_status, git_diff, doc_read, skill_read, memory_search
```

文件写入、shell、网络、MCP 和需要审批的操作保持串行。新增工具默认不进入并行白名单，只有确认无副作用、无审批依赖且结果顺序不影响正确性后才能加入。

代码分析先定位相关入口和配置，使用具体文件模式或 `file_grep outputMode=files_with_matches` 发现文件，再读取必要内容；证据不足时才扩大范围。搜索遵守 `.gitignore`，显式排除 `.git` 元数据，Windows canonical 路径与 workspace 使用相同形式，结果保持相对路径。

验证按用户请求、仓库规则和变更风险选择。无修改的分析仅在需要消除具体不确定性时运行相关测试；相关检查通过后，只有用户或仓库明确要求、共享逻辑或高风险改动需要时才扩大到全量测试。

`task_update` 更新本轮完整清单；`task_create/task_item_update` 操作具有 ID 的依赖图。图查询不能改写当前清单；更新图必须使用实际返回的 ID。首次清单可与独立读取一起调用，减少单独规划回合。

## 模型请求耗时诊断

`model_calls.record_json` 和 `session.modelCalls` 为每次请求单独记录 `elapsedMs`、`streamReadyMs`、`firstEventMs` 和 `firstTextMs`。所有耗时从该次请求开始计时，使用单调时钟；重试各自拥有记录，不混入工具运行时间。

- `streamReadyMs`：adapter 返回响应流的时间，包含请求准备、协议协商和建立响应流。
- `firstEventMs`：传输层收到首个完整 SSE `data` 事件的时间，早于解码和通道处理；注释心跳不算，provider 数据心跳或元数据事件可能算。
- `firstTextMs`：host 首次观察到非空 assistant 正文的时间；工具调用、推理、元数据和结束事件均不算正文。

首次观测立即持久化；失败、取消和重启保留已观测值，未观测或历史记录显示“未记录”，不能当成零。日志在首次事件、首次正文和请求结束时输出调用 ID 与耗时，不记录提示词或正文。桌面端“模型调用记录”显示这三个时间点。首个事件到正文的间隔可能包含推理或上游缓冲，单凭这些时间仍不能直接证明 provider 排队时间。

## 失控保护

- 交互式会话不设置固定的模型 step 上限；取消、重复工具批次检测和上下文压缩仍会阻止失控任务。子 agent 仍默认最多执行 32 个 step，也可通过 `maxTurns` 显式设置 1 到 96 的预算。
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
