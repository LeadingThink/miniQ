# miniQ 子任务扩张与 Codex 对比

审查日期：2026-10-20（Asia/Hong_Kong）。本次只做仓库拉取和诊断，没有修改运行逻辑。

## 结论

此次 14 个子任务真实存在。主任务直接创建 2 个，它们创建 5 个二级任务，后者又创建 7 个三级任务。
主要原因是 miniQ 将“通常启动 2–4 个 worker”的主动委派策略同时注入主任务和每个子任务，
允许三层嵌套，却没有整棵任务树共享的并发额度。不能只归因于模型，也不是 UI 凭空多算了任务。

截图中的回答“实际运行了两个”只覆盖直接子任务，漏掉了 12 个后代。

## 审查对象与方法

- miniQ HEAD：`176eb034acfc745171f44987cb486e5c2eae1e5b`。
- Codex：`https://github.com/openai/codex.git`，浅克隆到 `reference-repos/codex`。
- Codex HEAD：`8196bcdc189ad2c189d631b321fa54b8e09b9bb0`，2026-10-20。
- 以只读 SQLite 连接检查截图对应会话 `sess_70233f727b3f4c598d2df43babef44f4` 的任务元数据、
  父子关系、生命周期时间、创建调用和子任务历史中的系统策略。
- 会话标题：`现在有个问题，就是这个终端在工作的时候会莫名其妙…`。
- OpenAI Docs 多智能体页面请求超时；下列 Codex 结论依据本次取得的官方仓库源码，
  不假定它与所有已安装客户端、服务端下发配置或历史版本完全一致。

## 实际任务树

下列无自定义名称的叶子使用数据库 description 标注，括号内状态来自持久化记录。

```text
主任务
├─ terminal-entrypoint-audit（失败）
│  ├─ terminal-entry-audit（完成）
│  └─ process-ipc-audit（失败）
│     ├─ 只读追踪桌面前端 IPC 和事件（取消）
│     └─ 只读检查守护进程和工具子进程（完成）
└─ workflow-state-audit（取消）
   ├─ frontend-panel-layout（取消）
   │  ├─ render-chain（完成）
   │  ├─ layout-hooks（完成）
   │  └─ state-streaming（完成）
   ├─ task-stream-lifecycle（取消）
   └─ rust-terminal-side-effects（取消）
      ├─ 只读前端终端入口和启动链审查（失败）
      └─ 只读 CLI launcher monitor 审查（完成）
```

统计：

| 项目 | 记录结果 |
| --- | --- |
| 一级 / 二级 / 三级任务 | 2 / 5 / 7 |
| 完成 / 失败 / 取消 | 6 / 3 / 5，与截图一致 |
| 创建调用总数 | 29 |
| 成功创建 | 14 |
| cwd 与 isolation 同时传入，被拒绝 | 10 |
| plan mode 工具限制，被拒绝 | 3 |
| 达到嵌套深度 3，被拒绝 | 2 |
| 活跃生命周期峰值 | 14 个子任务，不包含主任务 |

2026-10-20 11:55:41.711（香港时间），第 14 个任务创建；第一个任务到 11:57:54.102 才完成。
因此当时 14 个子任务都尚未结束。这是生命周期重叠，不代表 14 个模型 HTTP 请求在同一瞬间执行；
部分父任务可能正在等待后代。

三个失败任务的错误分别是耗尽 20、32、22 个模型步骤预算。拒绝的 15 次创建没有产生额外任务记录，
不能将它们混入 UI 的 14 个任务。另有 5 次子任务尝试向 `parent` 发消息，因无法解析该收件人失败，
增加了无效协调，但不是任务数增长的直接原因。

## miniQ 的根因

1. `crates/miniq-daemon/src/parallel_policy.rs:24` 要求对独立分支使用 `agent_run`，并写明
   `Start a small cohort (usually 2-4 workers)`。这是主动委派倾向，不是整棵树的硬限制。
2. `parallel_policy.rs:43` 的 `refresh_child_policy` 将相同策略写入子任务 system history；
   `agent_tasks.rs:90` 在子任务执行前调用它。本次 14 个任务保存的历史均实际包含这段策略，
   不只是从当前源码推测旧会话行为。
3. `agent_tasks.rs:20,373` 只限制嵌套深度为 3；`child_context` 继续提供子任务创建能力。
   深度限制不能控制同层宽度。每层都“少量拆分”，仍然可以产生很大的任务树。
4. `agent_task_manager.rs:129` 创建时检查名称冲突并登记任务，没有团队容量准入；
   `agent_tasks.rs:439` 为后台任务直接启动 Tokio task。
   `ActivityGate` 用于关闭/更新时的活动跟踪，不是并发限额。
5. `agent_tasks.rs:174` 的 `maxTurns` 是每个任务独立的模型步骤上限，默认 32；
   它既不限制子任务数量，也不是父子共享的总预算。
6. `crates/miniq-tools/src/agent.rs:138` 的工具说明也强调启动 cohort，强化了系统策略。

UI 的 `agent.list` 查询整个 session 的任务，包含所有层级与终态任务；
`apps/desktop/src/components/AgentSummary.tsx:199` 据此显示数量和状态。
截图显示的是会话内总记录，不是“主任务直接创建数”，也不是“当前并发数”。
本次并发过多由生命周期记录另行证实。

## Codex 的关键差异

| 方面 | 当前 Codex 源码 | 当前 miniQ |
| --- | --- | --- |
| 何时主动委派 | V2 区分显式请求模式与主动模式 | 所有任务统一使用主动并行策略 |
| 内置模式选择 | 无配置/模型目录覆盖时，Ultra 选择主动模式；其他强度选择显式请求模式 | 没有对应的委派模式选择 |
| 显式请求模式提示 | 没有用户或适用 AGENTS.md/skill 明确要求，不创建子 agent | “独立分支通常创建 2–4 个” |
| 团队容量 | V2 默认 4 个并发槽，口径包含主 agent，并有运行/驻留容量控制 | 没有共享团队额度 |
| 深度 | V1 默认 1；V2 不应套用 V1 深度限制 | 最多 3 层，但各层可以继续扩张 |

对应源码（均位于 `reference-repos/codex`）：

- `codex-rs/prompts/src/model_messages/multi_agent.rs:46`：显式/主动模式原文。
- `codex-rs/core/src/session/multi_agents.rs:77`：配置与模型目录覆盖、Ultra 条件。
- `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:738`：V1 默认工具提示同样要求显式委派授权。
- `codex-rs/core/src/config/mod.rs:256`：V1 默认线程限制 6、V2 默认并发槽 4、V1 默认深度 1。
- `codex-rs/core/src/config/mod.rs:1670`：V2 子任务容量由总槽数减 1 得出。
- `codex-rs/core/src/agent/control/execution.rs`：执行容量控制。
- `codex-rs/core/src/agent/control/residency.rs:146`：创建前预留容量，无法释放驻留槽则返回限制错误。
- `codex-rs/core/src/tools/handlers/multi_agents_tests.rs:2485`：V2 不受 V1 max_depth 限制的测试。

因此不能说 Codex 永远不递归或整个会话最多创建 3 个子任务：主动模式支持递归，
已完成任务后的后续创建也可能增加累计数量。这里的实质区别是委派触发策略与共享运行容量。

## 建议修改方向（尚未实施）

1. 删除固定“通常 2–4 个”的默认拆分指令。普通定位/修复由主任务直接处理；
   若目标是与 Codex 的显式模式一致，仅在用户或适用项目/技能指令要求委派时启用。
2. 分离主任务与子任务的策略。子任务默认完成既定范围，不再次招募；
   需要额外人手时由主任务统一决定，避免同一系统提示在每层放大。
3. 增加整棵树共享、原子预留的并发额度，例如总计 4 个槽（主任务 + 最多 3 个子任务）。
   新建与恢复都受限制，完成/失败/取消释放额度；达到上限时明确拒绝新启动，避免父等子造成隐式死锁。
   如果还要限制累计数量，需另设本轮创建额度，不能把并发限制当成累计限制。
4. 展示并汇报直接子任务数、后代总数与当前执行数，最终回答依据运行记录汇总整棵树。
5. 修正工具参数说明中 `cwd` 与 `isolation` 的互斥约束；单独处理 `parent` 收件人协议，
   减少本次已观察到的参数重试与无效通信。

建议的回归验证：普通任务策略、子任务策略、并发创建竞争、后代共享额度、恢复准入、
失败/取消后的额度释放、深度边界、完整任务树统计。提示词单元测试只能验证注入内容，
不能代替模型行为评测；需要用同类终端排错任务比较创建数、重复工作与实际完成质量。

## 本次变更与验证边界

已完成参考仓库克隆和源码/真实记录交叉核对。参考仓库目录已由项目 `.gitignore` 忽略。
保留原有 `useAppWorkbench.ts`、`useAppWorkbench.test.tsx` 及其他本地文件；没有改动数据库、
运行中客户端、应用版本或运行逻辑，没有触发发布。此次没有代码行为变更，因此没有执行测试、
格式器或类型检查；交付前检查文档差异及 Git 状态。

## 后续提示词调整（2026-10-20）

用户随后要求删除默认“启动 2–4 个”的指令，并澄清也不应规定“默认自行完成”，
而应让模型根据奥卡姆剃刀原则判断。此次按该澄清更新共享系统策略和 `agent_run` 工具说明：

- 不设置固定 worker 数量，也不预设必须拆分或必须直接执行。
- 主任务和各层子任务均权衡时间、质量收益与协调成本、重复工作及新增复杂度，
  选择能保持质量和完整性的最简单分工。
- 保留独立任务可并行执行、结果收集以及共享资源操作顺序执行的规则。
- 子任务恢复时替换旧系统策略，保留任务证据，不累积新旧两套提示词。

这次仅调整决策提示，没有新增并发额度、禁止递归的运行时限制或发布版本。
模型行为仍由其根据任务判断；不把提示词调整表述为数量上限保证。

本次提示词修改验证：`cargo test -p miniq-daemon --lib policy`（12 项）、
`cargo test -p miniq-daemon --lib agent_tasks::tests`（28 项）、
`cargo check -p miniq-daemon -p miniq-tools --all-targets`、
`cargo fmt --all -- --check` 和 `git diff --check` 均通过。
检查存在未改动文件中的 unused/dead_code 警告。没有进行真实模型行为评测。
