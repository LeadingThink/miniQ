# miniQ 多智能体与开源 Harness 审查

日期：2026-09-06。将本轮“多功能体”按多智能体协作理解。

## 结论

miniQ 已有真正的子 agent：启动、后台执行、继续、消息、单独模型、停止和可选 Git worktree。
不足主要在可靠团队编排，而不是缺少一个启动按钮；不能把现有能力描述为“完全没有多智能体”。
OneAPI 的多模型适配应保留，不能用仅返回最终文本的 CLI 包装替代现有原生工具协议。

本轮读取官方说明及下列固定版本源码，并在独立 miniQ worktree 使用可控假模型复现缺陷。
没有读取生产凭据、调用收费模型、操作生产数据库或重启正在运行的客户端。

| 项目 | 审查版本 | 范围 |
| --- | --- | --- |
| miniQ | `2cceaeb0ef8dd2ce100b9a44259e6aae5c22eb30` | daemon 子任务生命周期、任务图、权限、事件和已有工作台 |
| openai/codex | `ac192cd7937b0d73edc6dffe009940ae53782dd4` | 多 agent 启动、角色、上下文继承、权限交集、运行容量、恢复路径 |
| deepseek-ai/deepseek-harness | `d347e703908d0406b7a7ef80e3a0e594d86b2215` | 架构、安全声明、子 agent 能力契约、实验性团队任务板与邮箱、原生产品适配器 |

“GPT harness”在这里对应官方开源 Codex，不是闭源 ChatGPT 客户端的源代码。
没有做统一任务基准测试，因此不宣称总体成功率、速度或成本已经超过任一产品。

## 已复现问题与本批修复

| 问题 | 原因与修复 | 验证 |
| --- | --- | --- |
| 停止父轮后后台子 agent 继续请求模型 | 原来创建独立取消 token；现在子 token 继承当前执行者，嵌套继续传递 | 等待模型响应时取消父轮，子任务进入 cancelled，取消后的新启动被拒绝 |
| 父轮结束后，会话停止遗漏后台任务 | session.cancel 原来只查 active_turns；现在同时向该会话全部 agent 发出停止信号 | 经真实 RPC dispatch 验证，同时验证另一会话不受影响 |
| 已完成父 agent 的后代无法一起停止 | stop 原来只处理一个记录；现在遍历同会话的后代并统一发信号，再在共享期限内等待 | 后代包括新 token 的恢复任务；兄弟任务继续运行 |
| 前台子 agent 的调用 future 被取消后卡在 running | 工具取消会丢弃调用 future；现在独立运行时任务持有启动、执行、终态和 worktree 清理 | 先复现失败，再验证主动丢弃调用 future 后仍进入 cancelled |
| 停止后恢复可能继续旧的排队指令 | 取消清空旧 inbox，新的显式 follow-up 仍可恢复 | 恢复后的模型请求不包含旧排队指令 |
| 清理期间停止仍可能显示 completed | finalizing/stopping 的完成路径检查取消 token | 人工控制状态边界验证最终为 cancelled |
| daemon 关闭只通知前台轮 | 关闭时也通知所有已登记后台 agent | 假模型上的独立测试状态验证，不操作真实 daemon |
| 任务依赖接受直接、间接和单次更新形成的循环 | 对完整候选图执行非递归拓扑校验；验证成功才发布更改 | 两节点、三节点及同时 addBlocks/addBlockedBy 的循环全部拒绝 |
| 未完成依赖可以开始甚至完成任务 | 对候选图中的执行中/已完成任务校验所有前置任务 | 正向/反向加边、重开前置任务、满足依赖后正常推进均覆盖 |
| 无效更新可能部分改变图 | 所有更改在候选副本上校验；错误不写回 | 拒绝后对比完整任务板，包括名称、owner 和双向关系 |

主要实现：

- `crates/miniq-daemon/src/agent_tasks.rs`
- `crates/miniq-daemon/src/agent_task_manager.rs`
- `crates/miniq-daemon/src/agent_task_manager/cancellation.rs`
- `crates/miniq-daemon/src/gateway/session.rs`
- `crates/miniq-tools/src/tasks.rs`
- `crates/miniq-tools/src/tasks/graph.rs`

停止表示取消已被请求，并非所有操作被瞬时回滚。单个 agent.stop 最多等待现有的 30 秒期限，
慢清理可继续显示 stopping；session.cancel 不等待全部后代清理结束。daemon 的完整优雅退出屏障仍待实现。
本批没有改变模型输出 token 上限，也没有添加强制输出预算。

## 仍有实质差距

以下是源码中确认的设计缺口或明确标注的风险，不是本批已经交付的能力。

| 优先级 | 缺口与当前证据 | 必须达到的验收标准 |
| --- | --- | --- |
| P1 | 子 agent 身份、history、inbox、result 保存在 AgentTaskManager 内存 | 独立 child session、父子关系及轮状态落库；重开后可读取和显式恢复 |
| P1 | 子轮失败时只保留轮前 history，已执行工具可能未进入恢复上下文 | 每次模型可见工具结果有耐久记录；模拟工具完成后 provider 断线，不重复已提交操作 |
| P1 | agent_tasks.rs 将 AgentEvent 通道空消费；工具使用父 sessionId | 每个子任务有 agentId/turnId/callId 归属、可重放历史、实时阶段与压缩事件；不混入主回答 |
| P1 | TaskManager 内存任务板，owner 是自由文本，没有 revision/CAS | 团队成员身份验证、原子领取、过期版本冲突；两个 agent 同时领取只有一个成功 |
| P1 | 子 agent 目前各有 task_scope，不是共同团队任务板 | 区分个人计划和团队共享图；共享依赖/领取不会覆盖主会话计划 |
| P1 | inbox 只是字符串队列，没有消息 ID、发送者和确认记录 | 发前持久化、确认、重放与去重；入队后崩溃可恢复，不能承诺跨进程 exactly-once |
| P1 | 发给运行中 agent 的消息在整轮结束后消费；主 agent 不在成员注册表 | 区分普通消息/后续任务/中断，在安全步骤边界交付；子任务可以明确回复 Lead |
| P1 | 有深度/步骤限制，但背景 tokio::spawn 没有团队并发准入 | 会话/全局并发限制、可见排队、公平释放；父任务等待子任务不能占满容量造成死锁 |
| P1 | 子权限由请求模式和全局设置计算，并非父授权的能力交集 | 子权限不能大于父权限；测试计划模式、恢复、审批和跨 agent 消息路径 |
| P2 | subagentType 主要插入通用提示；没有验证过的角色能力配置 | 按角色定义指令、工具允许集合、模型能力和可检验输出；不靠名称暗示隔离 |
| P2 | 子任务只有独立 model，没有独立 effort/protocol/context 继承策略 | 接入已有模型能力元数据；支持明确的 fresh/summary/fork，私有签名按模型隔离 |
| P2 | 新子 agent 只有通用 system 和委派文本 | 明确继承适用项目指令、技能与工作目录规则；保留指令来源和作用域 |
| P2 | 多数任务共享目录；worktree 从 HEAD 起步，未包含父目录未提交改动 | 显式声明启动基线、写入范围及变更归属；冲突检测、审阅、整合有完整流程 |
| P2 | AgentPanel 只有部分身份、模型、状态、输出、停止能力 | 独立历史、当前操作、耗时、真实 usage、依赖导航、消息和改动对比 |
| P2 | 原生产品运行时与 OneAPI 模型接口尚未形成清晰的可选后端契约 | 后端声明支持的持续会话、恢复、流事件、审批、工具、取消及授权来源 |
| P2 | 没有同任务、同预算的多智能体质量基准 | 单/多 agent 对照；记录成功率、重复工作、冲突、实际 token 与耗时，不靠任务数量宣传 |

权限部分是设计缺口，不是已复现的越权攻击：现有 plan mode 已拦截写工具，
agent_run 在计划模式下也有 mode 限制。需要额外验证的是权限继承及 agent_message 的跨任务影响。
owner 自由文本目前仍保留；阻塞任务用例中的“陌生成员 owner”不代表本批已实现团队身份验证。

## 向两个项目学什么

| 关注点 | Codex 源码 | DeepSeek Harness 源码 | miniQ 采用方向 |
| --- | --- | --- | --- |
| 运行时边界 | CLI、SDK、app-server 是不同集成层；harness 管理上下文/工具/审批/事件 | 插件按服务、适配器、消费者划分，使用明确能力契约 | 保留 Rust/OneAPI 主引擎，原生产品作为可选、能力自描述的执行后端 |
| 委派上下文 | 角色配置、model/effort、fork 策略和持久化身份 | fresh/fork 有明确契约；不支持的选项拒绝 | 显式继承，不隐式复制全部历史，也不静默忽略参数 |
| 权限 | 子请求权限与父有效授权取交集 | 子后端能力校验和不支持选项拒绝 | 能力矩阵和授权交集都要在运行时验证 |
| 日志 | 独立线程持久化及恢复路径 | 模型可见即有日志；耐久事实与瞬时流事件分离 | 数据库日志为事实来源，UI 和恢复使用同一记录 |
| 团队状态 | 稳定路径身份、带发送者的通信及执行容量 | 实验性团队有持久化邮箱、revision 任务板、依赖就绪检查 | 先身份/日志，再共享任务/邮箱，再调度和工作台 |

重要限制：DeepSeek Harness 明确是 developer preview，未经安全审计；Agent Teams 位于
`packages/experimental`，不包含在官方发布中，不能视为现成生产组件。
其 writeScopes 是冲突提示，不是锁或写权限；邮箱源码限定进程内重试与接收端去重，
并不提供跨进程 exactly-once 保证。

其原生 Codex 适配器虽然使用真实 app-server，但当前每次启动新的临时线程、只执行一轮，
不提供继续/恢复/进度流/产品会话持久化和人工审批通道；原生 Claude Code 适配器也有单次执行边界。
直接复制这些包装不符合用户“不做功能妥协”的目标。

## 推荐后续顺序

1. 可靠性基础：本批停止与图校验之后，补独立 child session、执行日志和事件归属。
2. 团队协议：成员身份、共享任务 revision/领取、持久化邮箱、步骤边界交付、并发准入。
3. 原生能力与工作台：角色、权限交集、上下文策略、可选原生后端、变更审阅和基准测试。

OneAPI 模型协议和 Codex/Claude Code 产品协议是两个层次。能调用 GPT/Claude 模型，
不自动获得对应产品的沙箱、工具进程、审批 UI、MCP 配置与持久化会话。
原生后端必须沿用各产品支持的接口和认证，不假设一个 OneAPI key 能代替所有产品登录。
也不应把所有模型强行转换到一种最低能力接口。

## 验证记录

所有命令从独立工作目录根运行，构建输出使用测试缓存，没有替换正在运行的二进制。

- 初始三个诊断用例证实基线缺陷；已改为期望正确行为的回归测试，不提交“错误行为通过”的断言。
- 前台调用被丢弃的新增用例先失败为 running，再通过为 cancelled；共享目录和真实干净 worktree 两种模式均通过，后者确认目录被正常清理。
- `cargo test -p miniq-daemon -p miniq-tools --tests`：181 项通过，2 项已有环境依赖测试忽略（真实浏览器、联网搜索）。
- `cargo check --workspace`：通过。
- `cargo clippy -p miniq-tools -p miniq-daemon --all-targets --no-deps -- -D warnings`：通过；同时清理已有推理强度校验的多余 unwrap，并重跑其 4 项定向测试，参数行为不变。
- `cargo fmt --all -- --check`、`git diff --check`：通过。新增实现/测试源文件均小于 500 行；无版本、依赖锁文件或生成产物改动。
- 没有执行上游 harness、不消耗收费模型、不运行原生客户端 UI 验收；不据此声称全部 OneAPI 模型或原生后端已在线验证。

## 来源

OpenAI Docs 的官方资料用于区分模型、harness 与产品集成层，促使本批优先处理生命周期和事件/权限边界。

- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [Codex 多 agent 启动源码](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- [Codex 身份恢复与子权限继承源码](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/agent/control/spawn.rs)
- [Codex 执行容量源码](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/agent/control/execution.rs)
- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/architecture.md)
- [DeepSeek 安全声明](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md)
- [DeepSeek 实验性团队契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/experimental/agent-team/README.md)
- [DeepSeek 任务板源码](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/experimental/agent-team/src/task-board.ts)
- [DeepSeek 邮箱源码](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/experimental/agent-team/src/mailbox.ts)
- [DeepSeek 原生 Codex 适配器边界](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subagent/subagent-codex/README.md)
- [DeepSeek 原生 Claude Code 适配器边界](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subagent/subagent-claude-code/README.md)
