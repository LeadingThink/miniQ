# miniQ Desktop AI Coworker 实现文档

## 1. 产品定位

miniQ 是一款面向通用办公场景的桌面端 AI Agent 产品。它不是编程 IDE,也不是聊天机器人,而是一个在用户电脑上协助完成工作的 "AI Coworker":

用户给出目标 —— 整理资料、生成报告、分析表格、修改文档、准备演示稿、汇总会议内容、起草邮件、完成一个项目任务 —— agent 自动拆解步骤、读取本地文件、调用工具和应用、在关键操作前请求用户确认,最终交付一个可直接使用的结果。

核心原则:

- 目标驱动:用户描述结果,agent 负责规划和执行,过程可见、可控、可中断。
- 本地控制优先:文件、shell、审批、沙箱、记忆全部由本机 Rust runtime 管控。
- 技能为中心:agent 的通用执行力来自一小组内置工具;"怎么做某类工作" 的知识全部以技能(Skill)组装,用户可以把一次任务的做法固化成新技能。
- 安全默认:命令审批、风险分级、路径沙箱、审计日志是核心能力,不是补丁。
- 轻量实现:Tauri 2 + Rust daemon,不走 Electron + Node 的重量级路线。

## 2. 核心概念:通用 Agent + 技能体系

### 2.1 两层能力模型

```text
┌─────────────────────────────────────────────┐
│ 技能层(知识 / 流程)                        │
│   SKILL.md + 可选 scripts/                   │
│   "怎么整理周报"、"怎么分析这类表格"、        │
│   "怎么处理发票"、"怎么写代码修 bug"          │
│   —— 全部可由用户从任务中蒸馏生成            │
├─────────────────────────────────────────────┤
│ 工具层(执行能力,内置、不可由技能替代)      │
│   file_read/write/list  shell_run            │
│   git_status/diff       doc_read (pdf/office)│
│   web_fetch             mcp_call ...         │
│   —— 全部经过 ToolRouter、风险分级、审批     │
└─────────────────────────────────────────────┘
```

关键结论(来自参考项目验证,详见 §5):

- 工具给 agent 通用执行力("想干嘛就能干嘛"),数量保持少而稳定。
- 技能是组织工具的知识层,不是新的执行通道。技能里的脚本仍通过 `shell_run` 执行,自动继承审批与沙箱。
- 编程、报告、数据分析、邮件等都不是独立子系统,而是同一个 agent 加载不同技能后的表现。

### 2.2 技能格式

一个技能是一个目录:

```text
weekly-report/
  SKILL.md          # 必需:YAML frontmatter + markdown 正文
  scripts/          # 可选:可执行脚本(py/ps1/sh/js)
  templates/        # 可选:输出模板(docx/pptx/md 模板等)
  references/       # 可选:参考资料
```

`SKILL.md` frontmatter 最小字段:

```yaml
---
name: weekly-report
description: 汇总本周工作记录并生成周报 docx
version: 1
origin: distilled          # bundled | user | distilled | installed
requires:
  bins: []                 # 依赖的本地命令
allowedTools: []           # 留空 = 不额外限制
enabled: true
---
```

正文约定结构(与蒸馏输出契约一致):

```markdown
## 适用场景
## 步骤(写明每步用哪个工具)
## 注意事项(真实踩过的坑)
## 如何确认完成
```

### 2.3 技能如何参与推理

1. daemon 启动 / 会话开始时扫描技能目录,只解析 frontmatter(便宜)。
2. 系统提示词注入 `<available_skills>` 清单(name + description),设定 token 预算,超预算先压缩描述再截断。
3. agent 判断某技能相关时,调用内置工具 `skill_read(name)` 读取正文和文件清单,再按其中的步骤行动。
4. 技能自带脚本时,`skill_read` 返回脚本落盘后的绝对路径,agent 用 `shell_run` 执行 —— 因此脚本执行天然进入风险分级和审批。

技能目录优先级(同名时高优先级遮蔽低优先级):

```text
<workspace>/.miniq/skills/   # 项目技能
<data_dir>/skills/           # 用户全局技能(含蒸馏产物)
内置 bundled 技能             # 编译期打包
```

### 2.4 「创建技能」:录制 → 蒸馏 → 复用 → 进化

这是产品的招牌功能,实现分四步:

1. **录制**:无需额外操作 —— 会话的 messages / tool_calls / approvals 本来就完整落在 SQLite,这就是 transcript。
2. **蒸馏(distill)**:用户在任务完成后点「保存为技能」,daemon 把该会话 transcript 交给蒸馏 prompt,产出一份 SKILL.md 草稿:步骤必须写明确切工具名与关键参数、记录真实出现过的坑、给出完成判据;纯问答类会话拒绝蒸馏(返回 SKIP 及原因)。
3. **校验与保存**:蒸馏产物用与技能加载完全相同的解析器校验(保证"学会的技能一定能用"),用户在 UI 预览、可编辑,确认后写入 `<data_dir>/skills/<name>/`。技能名从任务内容确定性派生,保证重复学习得到稳定身份。
4. **进化(refine)**:后续会话若命中同名技能且任务再次完成,提供「更新技能」:把新 transcript 与现有 SKILL.md 一起交给 refine prompt,合并新经验并 version+1,或判定 KEEP 不变。

增强(后置):挖掘历史会话中重复出现的工具调用序列(次数 ≥ N 且未被现有技能覆盖),主动建议"把这个流程存成技能"。

安全红线:蒸馏 prompt 明确禁止把密钥、token、个人敏感信息写进技能;蒸馏产物默认 `origin: distilled`、仅本机可用,分享/安装体系(注册表、签名)属于后期。

## 3. 总体架构

```text
Tauri 2 Desktop App (apps/desktop)
  ├─ TypeScript 前端(当前 React 实现,组件按可迁移 Svelte 设计)
  ├─ Tauri command bridge(仅 daemon 发现/启动)
  └─ Local WebSocket client
       ↓ JSON-RPC 2.0 / WebSocket
Local Rust Agent Daemon (miniq-daemon)
  ├─ RpcGateway(认证、分发、事件广播)
  ├─ SessionManager(workspace / session / turn 生命周期)
  ├─ AgentRuntime(规划-执行循环,miniq-agent)
  ├─ ToolRouter(miniq-tools)
  ├─ SkillService(发现、注入、读取、蒸馏、进化)★ 新增
  ├─ ApprovalManager(风险分级 + 审批)
  ├─ SandboxManager(miniq-sandbox)
  └─ Memory / Store(miniq-memory, SQLite)
       ↓
Tools and Integrations
  ├─ file / shell / git 工具(已实现)
  ├─ doc 工具:pdf / docx / xlsx / pptx 读取与生成 ★ 新增
  ├─ web 工具:网页抓取整理 ★ 新增
  ├─ MCP clients(外部工具接入)
  └─ Model provider adapters(OpenAI-compatible,已实现)
```

## 4. 技术栈

| 层级 | 技术 | 职责 |
| --- | --- | --- |
| 桌面容器 | Tauri 2 | 窗口、托盘、自动更新、daemon 发现启动 |
| 前端 | TypeScript(React 现状 / Svelte 可选) | 任务进度、审批、文件预览、结果交付、技能管理 |
| 本地核心 | Rust | agent runtime、工具、技能、审批、沙箱、持久化 |
| 本地通信 | JSON-RPC 2.0 over WebSocket | UI 与 daemon 双向通信、事件流 |
| 工具协议 | MCP | 外部工具与第三方能力接入 |
| 存储 | SQLite | 会话、消息、工具调用、审批、审计;技能以文件形式存盘 |
| 异步运行时 | Tokio | daemon、工具调用、事件推送、任务取消 |
| 数据校验 | serde + schemars | Rust 类型生成 JSON Schema(schemas/) |

## 5. 参考项目吸收方式

`reference-repos/` 为本地完整代码参考(已 gitignore),实现每个模块前先检索对应实现:

| 项目 | 重点参考 |
| --- | --- |
| moltis | 技能目录发现(多根优先级 + frontmatter 惰性解析)、`<available_skills>` 提示词注入与 token 预算、`read_skill`/`create_skill` 等技能 CRUD 工具及路径守卫 |
| ironclaw | **`ironclaw_skill_learning`:transcript → distill/refine 的技能学习管线**(蒸馏/进化 prompt、与安装路径同解析器校验、SKIP 门槛);技能激活打分(keywords/patterns/预算/信任衰减);trusted vs installed 信任分层 |
| opencrust | `skill_suggester`(重复工具序列挖掘 → 主动建议成技能)、`create_skill_tool` |
| zeroclaw | WASM 插件模型(manifest + 权限声明 + Ed25519 签名 + wasmtime)—— 留作后期第三方分发方案;轻量 runtime 与 `Tool` trait |
| openfang / librefang | Tauri 桌面结构、技能开关 UI |
| microclaw | 消息事件流、多端连接 |

已验证的关键设计判断:

- SKILL.md 指令注入是四个项目共同的主流形态;可执行代码放 `scripts/` 由 agent 经 shell 工具调用,而非独立执行通道。
- 技能学习(distill/refine)在 ironclaw 有完整先例,蒸馏产物必须用加载路径同一解析器校验。
- WASM 插件仅在需要沙箱化第三方分发时才引入,第一阶段不做。

使用原则:吸收架构边界与关键实现细节,不复制项目结构;不继承参考代码中的旧逻辑与历史兼容层。

## 6. 仓库结构

```text
miniQ/
  reference-repos/          # 本地参考代码,不提交
  apps/desktop/
    src/                    # TypeScript 前端
    src-tauri/              # Tauri 2 shell(独立 cargo package)
  crates/
    miniq-protocol/         # JSON-RPC 请求、响应、事件类型(已实现)
    miniq-daemon/           # daemon 入口、网关、executor(已实现)
    miniq-agent/            # turn 运行器、ToolExecutor trait(已实现)
    miniq-tools/            # file/shell/git 工具 + ToolRouter(已实现)
    miniq-sandbox/          # 路径约束、命令风险分级(已实现)
    miniq-memory/           # SQLite 持久化(已实现)
    miniq-models/           # LLM provider adapter(已实现)
    miniq-skills/           # 技能:类型、发现、注入、蒸馏、进化 ★ 新增
    miniq-docs/             # pdf/docx/xlsx/pptx 解析与生成 ★ 新增
  schemas/                  # 生成的 JSON Schema
  migrations/               # SQLite migration
  docs/
```

代码边界要求:

- `miniq-skills` 只依赖 protocol 与文件系统,蒸馏所需的模型调用通过 trait 注入(不直接依赖 miniq-models)。
- `miniq-docs` 只做文档解析/生成,以工具形式经 `miniq-tools` 注册进 ToolRouter。
- 其余边界不变:agent 不碰 SQLite 和系统命令;tools 全部经 ToolRouter;sandbox 只做判定;memory 只做持久化。
- 单文件不超过 500 行,单函数不超过 100 行。

## 7. 进程模型(已实现,保持不变)

两个本地进程:Tauri 壳负责启动/发现 daemon(`daemon.json` + `/health` 探测),UI 经一次性 token 建立 WebSocket。daemon 支持多 workspace、多 session、单 session 任务取消、重启后可读恢复、所有工具调用写审计日志。

## 8. UI 模块

围绕"任务"而非"对话"组织界面,6 个主区域:

- **任务面板(sidebar)**:工作区、任务(session)列表、每个任务的状态与进度、模型/技能状态。
- **执行时间线**:目标 → 步骤计划 → 工具调用卡片(输入/输出可折叠)→ 审批卡片 → 阶段性产物。已实现聊天时间线,需扩展步骤计划与产物展示。
- **Composer**:目标输入、附件、上下文选择。
- **结果交付区**:任务产出的文件清单(报告、表格、演示稿),支持预览、打开所在目录、"接受/放弃"。
- **技能页** ★:技能列表(来源/版本/开关)、技能详情预览、编辑、删除;会话完成后的「保存为技能」入口与蒸馏结果预览确认流。
- **设置**:模型 provider(已实现)、技能目录、MCP server、权限策略。

前端不直接访问文件系统、git 或 shell;一切经 daemon 协议,保证审批、审计、沙箱一致。

## 9. Daemon 核心模块

### 9.1 RpcGateway(已实现,新增技能方法)

现有方法:`daemon.health`、`workspace.open/list`、`session.create/list/open/sendMessage/cancel`、`approval.resolve`、`tool.list`、`settings.get/update`。

新增:

- `skill.list` — 全部技能(含来源、版本、enabled)。
- `skill.read` — 技能正文与文件清单(UI 预览用)。
- `skill.distill` — 输入 sessionId,返回蒸馏出的 SKILL.md 草稿或 SKIP 原因。
- `skill.save` — 保存(新建或覆盖)用户确认后的技能。
- `skill.refine` — 输入 sessionId + 技能名,返回合并后的新版本草稿。
- `skill.setEnabled` / `skill.delete`。

### 9.2 SessionManager(已实现,保持)

状态机:`idle / running / waiting_approval / cancelling / failed`。每个 workspace 同时只允许一个写入型 turn。

### 9.3 AgentRuntime(已实现,增强)

现有:构建上下文 → 调 provider → 解析工具调用 → 经 ToolRouter 执行 → 回喂结果循环,直到无工具调用。

增强:

- 系统提示词组装加入 `<available_skills>` 段(SkillService 提供,带 token 预算)。
- 面向长任务的计划输出约定:鼓励模型先给步骤清单,UI 以进度形式展示(第一版靠提示词约定,不做独立 planner 状态机)。

### 9.4 ToolRouter(已实现,扩充工具)

内置工具(现有):`file_read/list/write`、`shell_run`、`git_status/diff`。

新增工具按三个梯队规划(对比 zeroclaw 86 个工具与 moltis 40+ 个工具后收敛的必备集合):

**第一梯队 —— 通用 agent 基本功(M1)**

- `file_edit` — 精确字符串替换编辑(中风险,走审批)。避免整文件覆盖式修改。
- `file_glob` — 按模式匹配查找文件(低风险)。
- `file_grep` — 文件内容正则搜索(低风险)。跨平台自实现,不依赖系统 grep。
- `web_fetch` — 抓取网页正文为 markdown(高风险=网络,按域名审批,可会话内放行)。
- `web_search` — 联网搜索(高风险=网络;搜索 provider 可配置)。

**第二梯队 —— 任务型 agent 标配(M3/M5)**

- `task_update` — agent 维护多步任务计划,驱动 `plan_updated` 事件与 UI 进度展示。
- `ask_user` — 审批之外的主动澄清提问(结构化选项 + 自由输入)。
- `doc_read` — 统一入口读取 pdf/docx/xlsx/pptx/csv 为结构化文本(低风险)。
- `doc_write` — 生成 docx/xlsx/pptx/md/csv(中风险,走审批)。
- `checkpoint` — 写入型操作前自动备份,支持回滚(配合 file_write/edit/doc_write)。
- `http_request` — 通用 HTTP API 调用(高风险=网络,按域名审批)。
- `skill_read` — 读取技能正文/脚本路径(低风险,M2 随技能系统)。
- `memory_search/write`、`file_patch`。

**第三梯队 —— 生态与进阶(M6)**

- `mcp_call` — MCP server 工具接入(进审批与审计链)。
- `browser.*` — 浏览器自动化("操作应用"的落点,重依赖,后置)。
- `screenshot` / `image.info` — 屏幕与图像理解。
- `email.read/search` — IMAP 邮件读取(草稿生成先以技能形式产出 .eml,不直接发送)。
- `agent.spawn` — 子代理并行任务。
- `cron` — 定时任务。

工具输入输出必须结构化;持久化与协议传输保持完整数据,不做截断。

### 9.5 SkillService ★

职责:

- 按 §2.3 的目录优先级发现技能,解析 frontmatter,维护内存索引。
- 生成系统提示词技能清单(token 预算 → 压缩 → 截断)。
- 提供 `skill_read` 工具与 `skill.read` RPC;bundled 技能脚本按需落盘。
- 蒸馏与进化:组装 transcript(messages + tool_calls + approvals)→ 调蒸馏/进化 prompt → 用加载路径同一解析器校验 → 返回草稿。
- 守卫:技能名/路径合法性、防路径穿越、符号链接拒绝、单技能体积上限。

## 10. 协议设计(已实现,增量)

JSON-RPC 2.0 over WebSocket,三类:Request / Response / Event。协议变更只向前推进,`PROTOCOL_VERSION` 递增,不做旧协议兼容层。

现有事件:`session_status_changed`、`message_created`、`assistant_delta`、`tool_call_started/finished`、`approval_requested/resolved`、`turn_completed/failed`。

新增事件:

- `plan_updated` — 步骤计划(首次给出或更新)。
- `artifact_created` — 任务产物(文件路径 + 类型 + 说明),驱动结果交付区。
- `skill_suggested` — (后期)检测到可固化的重复流程。

## 11. Memory 与 SQLite(已实现,增量)

现有表:workspaces、sessions、messages、tool_calls、approvals、memories、audit_events(见 migrations/0001)。

增量 migration:

- `artifacts(id, session_id, path, kind, title, created_at)` — 任务产物索引。
- `skill_usage(id, session_id, skill_name, used_at)` — 技能使用记录,供进化与建议挖掘。

技能本体存文件系统(可被用户直接编辑、git 管理),SQLite 只存索引与统计 —— 事实源分离,避免双写不一致。

Memory 分类保持:Global / Workspace / Session;写入 memory 必须显式标注 scope。

## 12. 安全、审批与沙箱(已实现,扩展)

三层不变:静态权限 → 风险分级 → 用户审批。

风险等级(现有实现):`low` 自动执行;`medium/high` 审批(允许一次 / 本会话允许 / 拒绝);`blocked` 直接拦截。审批模式键:工具名,`shell_run` 细化到程序名。

技能相关的扩展规则:

- 技能本身无执行权:脚本必须经 `shell_run`(或未来的受限执行工具)进入分级与审批,无旁路。
- 信任分层:`bundled/user/distilled` 技能默认可用;`installed`(未来来自外部)默认只读工具授权,提权需显式确认。
- 蒸馏产物落盘前经过敏感信息扫描(密钥/token 模式),命中即要求用户处理。
- `web_fetch` 网络访问按域名审批,支持"本会话允许该域名"。

## 13. 模型 Provider(已实现,保持)

`ModelProvider` trait:`stream_complete(request) -> DeltaStream`。已支持 OpenAI-compatible(含 SSE 流式与分片 tool-call 参数);Anthropic-compatible 后续补充。Provider 不直接调工具;蒸馏/进化同样经 provider,走独立的低温请求。

## 14. 开发里程碑

里程碑安排原则:先把 agent 的"手脚"补齐(第一梯队工具),再上技能系统,然后围绕办公文档和任务体验(第二梯队),招牌功能技能学习紧随其后,生态与进阶能力(第三梯队)收尾。

### M0 基础平台(已完成)

Rust workspace、协议、SQLite、WebSocket 网关、聊天流式闭环、file(read/list/write)/shell/git 工具、风险分级、审批流、settings、React UI、Tauri 壳。47 项测试 + 真实 SSE 端到端验证通过。

### M1 核心工具补齐(第一梯队)✅ 已完成

- `file_edit`:精确字符串替换(唯一匹配校验、审批、编辑前快照),替代整文件覆盖的小改动场景。
- `file_glob`:模式匹配查文件,含忽略规则(node_modules/target/.git 等)。
- `file_grep`:内容正则搜索(纯 Rust 实现,限制结果规模,分页返回)。
- `web_fetch`:URL → 正文 markdown(HTML 净化、大小上限、按域名审批)。
- `web_search`:搜索 provider 抽象 + 至少一个实现(可配置 API);未配置时返回明确的不可用提示引导用户配置。

验收:agent 能在不认识的目录里自主定位文件与内容并完成一次小修改;能抓取指定网页并总结;全部新工具进入风险分级、审批与审计链,附单元与集成测试。

### M2 技能系统骨架 ✅ 已完成

- `miniq-skills`:SKILL.md 解析、目录发现(三级优先)、索引。
- 系统提示词注入 `<available_skills>`(token 预算)。
- `skill_read` 工具 + `skill.list/read/setEnabled/delete` RPC。
- UI 技能页(列表/预览/开关)。
- 打包 2~3 个 bundled 示例技能(如"整理目录并输出清单"、"生成 markdown 周报")。

验收:agent 在任务中能自主发现并按技能步骤执行;技能开关即时生效。

### M3 办公文档与任务体验(第二梯队上半)✅ 已完成

- `miniq-docs`:pdf/docx/xlsx/pptx/csv 读取为结构化文本;docx/xlsx/md/csv 生成。
- `doc_read` / `doc_write` 工具接入 ToolRouter(write 走审批)。
- `checkpoint`:file_write/edit、doc_write 前自动备份,UI 可一键回滚。
- `task_update` 工具 + `plan_updated` 事件:多步任务计划外显为 UI 进度。
- `ask_user` 工具:agent 主动澄清(结构化选项卡片)。
- `artifact_created` 事件 + artifacts 表 + UI 结果交付区。

验收:"读这份 PDF 和这个 Excel,写一份 docx 摘要报告" 全流程闭环 —— 计划可见、产物出现在交付区、误改可回滚。

### M4 技能学习(招牌功能)✅ 已完成

- 蒸馏管线:transcript 组装 → distill prompt → 同解析器校验 → 草稿。
- `skill.distill/save/refine` RPC;UI「保存为技能」+ 草稿预览编辑确认流。
- 敏感信息扫描;SKIP 门槛(纯问答不蒸馏)。
- 进化:命中已有技能的会话完成后提供「更新技能」。

验收:完成一次多步骤任务 → 一键保存为技能 → 新会话中 agent 自动运用该技能且步骤明显更少;重复任务后技能可进化出新版本。

### M5 更广工作流(第二梯队下半)✅ 已完成

- `http_request`(域名审批)、`file_patch`(原子多编辑)、`memory_search/write`(写入走审批)。
- 邮件草稿 bundled 技能 `email-draft`(产出 .eml,不直接发送)。
- `skill_suggested`:工具密集且未用技能的会话完成后主动建议保存技能(≥5 次成功工具调用阈值)。

### M6 生态与进阶(第三梯队)✅ 核心项已完成

已完成:

- MCP client:stdio 传输(JSON-RPC over newline-delimited JSON,initialize 握手 + tools/list + tools/call),`mcp_call` 工具进 ToolRouter 与审批链(按 server 审批),`mcp.list/update` RPC,UI 管理面板(添加/启停/移除/测试连接/工具列表)。
- 多任务并行:同 workspace 写入串行、跨 workspace 并行(workspace 级写入锁)。
- 系统托盘:关窗最小化到托盘,托盘菜单 Show/Quit。
- Windows 安装包:NSIS(`npx tauri build`),miniq-daemon 以 externalBin 随包分发。

后续(非本版验收项):

- `browser.*` 浏览器自动化、`screenshot`/`image.info`、`email.read/search`、`agent.spawn`、`cron`。
- 自动更新与安装包签名(需要签名证书与更新服务端)。
- (评估)技能分享/安装与签名验证 —— 参考 zeroclaw WASM 插件与 ironclaw registry。

## 15. 测试策略

Rust:

- miniq-tools 新工具:file_edit 唯一匹配/冲突用例、file_glob 忽略规则、file_grep 正则与分页、web_fetch HTML 净化与大小上限(本地 mock HTTP)、checkpoint 备份回滚往返。
- miniq-skills:SKILL.md 解析/校验往返、目录优先级遮蔽、prompt 预算截断、蒸馏产物校验(用固定 transcript 快照 + mock provider)。
- miniq-docs:各格式解析快照测试、生成文件可再读回。
- 既有:protocol schema、ToolRouter、sandbox 分级、migration、daemon JSON-RPC 集成(mock provider 脚本化多轮 tool call)。

前端:时间线渲染、审批卡交互、技能页、交付区。

端到端:mock OpenAI SSE 服务驱动「目标 → 计划 → 工具 → 审批 → 产物 → 保存为技能 → 复用技能」全链路。

## 16. 第一版对外 MVP 范围

必须包含(= M0 已有 + M1 ~ M4):

- 桌面 app + 本地 daemon + 流式对话(已有)。
- 审批、沙箱、审计(已有)。
- 完整的第一梯队工具:file_edit/glob/grep、web_fetch/search。
- 技能系统:发现、注入、读取、开关。
- 办公文档读写(pdf/docx/xlsx 至少各一)、checkpoint 回滚、任务计划外显、结果交付区。
- 「保存为技能」蒸馏闭环。

暂不包含:技能市场与签名分发、WASM 插件、远程多 agent、团队协作、直接发送邮件、自动操作任意 GUI 应用。

## 17. 工程规范

- 类型优先、schema 优先(schemas/ 由 gen-schemas 生成)。
- 高内聚低耦合;相同校验/路径规范化/审批判断抽象复用。
- 不过度设计:第一版单用户本地;技能=文件,不引入数据库存正文。
- 不保留旧逻辑:重构后删除旧实现与旧测试。
- 不做数据截取:持久化与协议保持完整数据,UI 折叠展示。
- 审计不可绕过:任何工具调用必须经 ToolRouter;技能脚本无执行旁路。

## 18. 推荐下一步

1. M1 先做纯本地三件套 `file_edit/glob/grep`(无新外部依赖,复用 sandbox 路径约束),再做 `web_fetch/search`(引入 HTML 净化与搜索 provider 抽象)。
2. M2:实现 `miniq-skills` 解析与发现,先让 bundled 技能进系统提示词并可被 `skill_read`。
3. 蒸馏 prompt 与校验器同步设计(输出契约即 §2.2 正文结构),M2 期间即可用固定 transcript 打磨。
4. M3 文档工具选型:纯 Rust 解析库优先(pdf-extract/docx-rs/calamine/umya-spreadsheet 类),避免运行时依赖 Office。
5. UI 从"对话"过渡到"任务"心智:先加结果交付区与技能页,再演进任务面板。
