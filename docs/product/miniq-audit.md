# miniQ 当前实现只读审计

审计范围：`apps/desktop` 前端导航、会话、技能、设置、文件附件、命令入口，以及 daemon、协议和技能模块。审计方式为源码与现有测试静态阅读；没有修改仓库，没有运行构建或测试，没有读取构建产物、密钥、凭证或其他敏感配置。

## 结论

当前实现已经形成一条较完整的桌面工作流：前端通过 JSON-RPC 连接本地 daemon 或远端/SSH 主机，支持会话导航、搜索与归档、会话生命周期、模型与设置、附件上传和预览、斜杠命令、技能发现与调用，以及技能从会话中提炼并保存。连接层具备超时、取消、断线重连、远程加密载荷和远程 resync 处理。

工程成熟度在“会话和连接基础设施”上明显高于“技能管理 UI 和端到端验证”。技能相关 RPC 与 daemon 集成测试存在，但 `SkillsPanel` 本身只有很有限的直接覆盖；仓库中还存在已添加但未接入页面的技能搜索工具/测试文件。设置和会话的交互测试相对扎实，附件的异步选择、草稿归属和远程路径也有针对性测试。

## 1. 当前真实能力

### 导航、会话与命令入口

- `AppShell` 维护设置、搜索、提炼技能、外部导入等覆盖层，并把 `schedule`、`skills`、`mcp`、`plugins` 映射为页面；设置和技能也分别注册到应用命令入口。
- `useMiniqApp` 的页面类型包含 `schedule | skills | mcp | plugins | null`；切换工作区/会话时会清理部分页面和覆盖层状态。
- 侧栏支持项目/会话折叠、标题搜索、运行中/等待/未读/置顶筛选、归档、键盘导航，并能搜索远程电脑、项目路径和完整标题（这些行为都有对应测试）。
- 斜杠命令支持应用命令组、模型子菜单、技能列表、当前工作区过滤、描述和别名搜索、键盘上下键/Home/End/Escape；未匹配或禁用项不会发送。
- `/tmp` 审计中未把命令入口泛化为“所有命令都可用”：具体可用项受页面状态、workspace scope、技能启用状态和 daemon 返回值影响。

关键证据：
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/AppShell.tsx:79-117, 343-360, 386-410`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/AppSidebar.tsx:25-80`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hooks/useMiniqApp.ts:25, 158-212`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerSlash.test.tsx:76-419`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Sidebar.test.tsx:35-418`

### 设置与连接

- 设置分为服务/远程、记忆、电脑控制、外观/任务通知等 tab；设置读取 `settings.get`，提交使用 `settings.update`。
- 本地模式可配置 provider；远程 SSH 主机显示执行目标提示，模型请求、文件操作和命令在目标主机执行，且不会自动复制本机 API key。
- 连接层对 daemon health、设置、工作区和会话进行初始同步；连接失败会重试，状态区分 connecting/connected/reconnecting。
- RPC 层具备请求超时、AbortSignal 取消、pending 请求清理、远程取消消息、连接关闭时拒绝 pending、远程 blob 失败时的回退路径。
- 电脑控制设置能展示平台、显示服务器、PID、可执行路径和权限状态，并处理 macOS 屏幕录制/辅助功能状态。

关键证据：
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Settings.tsx:59-205, 253-560`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Settings.interaction.test.tsx:36-188`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hooks/useDaemonConnection.ts:27-77`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/rpc.ts:24-25, 369-505`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hostRpc.ts:4-65`

### 文件附件与预览

- 附件可以来自文件选择器、拖放、剪贴板；异步文件选择结果会归属到发起它的草稿，避免切换新会话后串入错误会话。
- 远程主机有单独的远程路径附件行为；测试明确验证本地拖放路径不会被错误发送到远程目标。
- 已覆盖 PDF、Office、表格、Markdown、HTML、SVG、Mermaid、媒体等预览组件和若干搜索/分页状态。

关键证据：
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerAttachments.test.tsx:14-34`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerSsh.test.tsx:46-`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/FilePreviewPanel.test.tsx`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/PdfPreview.test.tsx`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hooks/useFilePreview.test.ts`

### 技能与 daemon/协议

- 前端存在技能页、技能详情、导入/启用/禁用/删除等交互，以及从会话 `skill.distill`、`skill.refine`、`skill.save` 提炼保存的流程；提炼页会显示潜在敏感内容警告，并支持覆盖已有同名技能。
- 技能调用通过斜杠命令暴露，并按当前 workspace 和 enabled 状态过滤；旧 workspace 返回的技能结果会被忽略，失败列表可重试，同时保留本地命令。
- Rust 侧有 `crates/miniq-skills` 的 store/parse/prompt/learn 模块，daemon 集成测试覆盖 skill integration、skill learning、RPC、队列、会话和工具批准等路径。
- RPC 协议有 JSON-RPC 请求/响应、事件、host.call/host.connect、remote resync 和远程取消等概念；前端 `HostRpcClient` 通过 root transport 复用远程连接，不直接打开明文 SSH socket。

关键证据：
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Skills.tsx:121-`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Distill.tsx:95-179`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerSlash.test.tsx:76-419`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-skills/src/lib.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-skills/src/store.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-skills/src/parse.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-skills/src/learn.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-protocol/src/rpc.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-protocol/src/event.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-daemon/tests/skill_integration.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-daemon/tests/m4_skill_learning.rs`
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-daemon/tests/rpc_integration.rs`

## 2. UI/UX 断点

以下均来自源码/测试证据；没有通过运行应用做视觉确认。

1. 技能管理页的直接交互测试不足。当前可见的技能专用测试主要是 `Skills.utils.test.ts` 的过滤函数测试；`AppShell.hostBrowser.test.tsx` 对 `SkillsPanel` 使用 mock。斜杠命令测试覆盖了技能列表行为，但不能证明技能管理页的导入、启停、删除、详情、失败重试和 workspace 切换反馈都正确。
2. `Skills.utils.ts` 与 `Skills.utils.test.ts` 已存在，但 `Skills.tsx` 没有引用 `filterSkills`，`Skills.css` 也未在搜索结果中看到被 `Skills.tsx` 引入。这表明“技能搜索/样式升级”至少有一部分停留在未接入状态，用户可能只能通过斜杠菜单搜索，技能管理页本身的能力不一致。
3. `Skills.tsx` 的加载、RPC 失败、空状态、启停后的刷新和删除后的选中项处理需要逐项确认；本轮只确认了文件存在和页面入口，未运行 UI，也没有找到等量的直接页面测试，因此这些行为不能视为已验证的稳定能力。
4. 技能提炼弹窗首屏依赖异步 `skill.distill`；错误只在请求失败后显示，源码没有看到针对初次加载失败后的重试动作。保存动作也没有看到 pending/禁用状态，连续点击或慢速 RPC 下的重复提交风险尚未被测试证明已消除。
5. `DistillModal` 的遮罩层点击会关闭弹窗，而内部阻止冒泡；源码没有看到统一的 `role="dialog"`、焦点陷阱、Escape 关闭或关闭前未保存草稿提示。键盘和可访问性行为需要运行时确认。
6. 连接失败经过多次重试后显示错误，但后台循环仍继续尝试；从用户角度需要明确“正在重连”和“重试/停止”边界，当前证据只证明状态文本和重试机制存在。
7. 设置覆盖了多个高风险动作（远程主机、电脑权限、命令 hook、provider），但部分设置子面板的独立失败、重试、取消和远程 host 切换场景仍缺少统一的端到端验证。
8. 技能/命令的 workspace 隔离在测试中有覆盖，但技能管理页与斜杠命令的“当前目标主机/当前 workspace”提示是否始终清晰，源码证据不足，存在用户误以为是全局技能的理解断点。

## 3. 现有测试与缺口

现有覆盖：

- 前端存在约 174 个 `*.test.*` 文件，覆盖侧栏、会话生命周期、composer、slash 命令、连接、设置、附件和多种预览。
- `ComposerSlash.test.tsx` 覆盖命令/技能列表、workspace scope、键盘操作、失败重试、旧 workspace 响应隔离和禁用动作。
- `Sidebar.test.tsx` 覆盖会话搜索、项目折叠、归档、未读、筛选、键盘和远程元数据。
- `ComposerAttachments.test.tsx`、`ComposerSsh.test.tsx` 覆盖异步附件归属和远程路径边界。
- `Settings.interaction.test.tsx` 覆盖 backdrop、tab 键盘导航、provider 保存失败、首次设置和 turn-ended command。
- daemon 集成测试目录包含 `skill_integration.rs`、`m4_skill_learning.rs`、`rpc_integration.rs`、`queue_integration.rs`、`external_session_runtime.rs` 等；protocol、skills crate 也有 Rust 单元测试。

主要缺口：

- 没有发现覆盖真实 `SkillsPanel` 的完整渲染/交互测试，尤其是导入、启用/禁用、删除、详情、空状态、失败重试、分页/长列表和切换 workspace。
- 没有发现前端对 `skill.distill` 初始失败、保存重复点击、关闭未保存草稿、Escape/焦点恢复和敏感内容强制保存确认的完整交互测试。
- 没有发现把前端技能页、斜杠命令、daemon skill RPC、事件刷新串成一条真实 transport 的端到端测试；目前两端分别有测试，协议边界仍可能出现字段/事件名漂移。
- 没有运行测试，因此不能把现有测试文件等同于当前分支全部通过；工作区本身已有用户修改和未跟踪文件，审计未触碰它们。
- CI 的常规构建工作流可见 daemon/CLI 构建和部分 CLI/local 测试，但从已读的 `.github/workflows/build.yml` 不能确认它会运行完整 desktop Vitest；发布/iOS 工作流包含更多测试，触发条件和覆盖范围不同。

## 4. 可在本轮安全实现的升级建议（影响/风险排序）

### P0：为技能管理页补齐状态模型与直接交互测试（高影响 / 低风险）

先不改协议：为 `SkillsPanel` 明确 loading、empty、error、retry、mutation pending、success 和 workspace 切换过期响应状态；对导入、启用/禁用、删除、详情、长列表和失败重试补齐 Vitest/Testing Library 测试。把已有 `filterSkills` 接入技能页，或删除未接入的工具/测试，确保代码与实际 UI 一致。该项能直接降低“页面看似可用、失败时无反馈”的风险，改动集中在前端。

### P1：收紧技能提炼弹窗的可访问性和提交幂等（高影响 / 低至中风险）

给 `DistillModal` 增加真实 dialog 语义、初次加载失败重试、Escape/焦点恢复、保存 pending 禁用和关闭未保存确认；对 `skill.save` 明确一次提交状态，并继续保留敏感内容警告和 force 参数。补齐对应交互测试，避免改变 daemon 协议。该项能降低重复保存、误关闭和键盘用户无法完成流程的风险。

### P2：建立前端技能/附件/连接到 daemon 的协议契约测试（高影响 / 中风险）

基于 `crates/miniq-protocol` 的 schema/类型，为 `skill.list/import/enable/disable/delete/distill/refine/save`、事件刷新、workspace scope、RPC 错误和 remote resync 建立一组固定契约测试；至少让前端 mock payload 与 Rust 端响应字段由同一份协议样例校验。再加入一个真实 daemon transport 的最小 smoke test，覆盖连接、技能变更后列表刷新和旧 workspace 响应丢弃。该项能捕获“单元测试各自通过但协议字段不一致”的问题，风险主要在测试基础设施。

后续可做但不列入本轮前三项：统一设置子面板的 retry/取消反馈；为连接重试提供用户可见的停止/立即重试动作；补充文件大小、类型、上传取消和远程断线的端到端测试。

## 5. 关键绝对路径

- 前端入口与导航：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/AppShell.tsx`
- 侧栏与会话导航：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/AppSidebar.tsx`、`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hooks/useMiniqApp.ts`
- 设置：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Settings.tsx`
- 技能页：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Skills.tsx`
- 技能提炼：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Distill.tsx`
- RPC/远程 host：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/rpc.ts`、`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hostRpc.ts`
- 连接恢复：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/hooks/useDaemonConnection.ts`
- 附件测试：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerAttachments.test.tsx`、`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerSsh.test.tsx`
- 命令/技能测试：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/ComposerSlash.test.tsx`
- 设置测试：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop/src/components/Settings.interaction.test.tsx`
- daemon：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-daemon`
- daemon 集成测试：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-daemon/tests`
- 技能实现：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-skills`
- 协议实现：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/crates/miniq-protocol`
- 根规则文件：`/Users/xuzhanwei/Desktop/projects/meeting/miniQ/AGENTS.md`

## 未核实事项

本报告没有启动 desktop、没有做浏览器/原生 UI 操作，也没有运行 `npm test`、Vitest、Cargo 测试或构建。因此，视觉布局、运行时可访问性、实际 RPC 字段兼容性、当前分支测试通过率、构建/CI 实际触发结果，以及技能页中未从静态片段确认的具体按钮行为，都应在实现升级前通过针对性测试或手工 smoke test 验证。
