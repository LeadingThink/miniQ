# miniQ 当前能力底盘、架构与薄弱项全景盘点

> 盘点基线：miniQ 代码仓库（最新 commit `aa15264`，版本 0.1.41），包含 Rust 13 个独立 crate（`crates/`）、Electron/Tauri 桌面端（`apps/desktop/`）、移动端（Android/iOS）及中继通信服务（`services/relay`）。

---

## 一、miniQ 现有核心架构与技术能力

1. **多层混合架构**：
   - **底座**：Rust 原生守护进程（`miniq-daemon`）提供高并发、低内存、跨平台支持。
   - **协议与工具抽象**：`miniq-protocol` 规范了执行事件流、会话批准（session approval）、运行指标；`miniq-tools` 实现了 native shell、patch、文件读写、AX 语义操控、computer use 等底层执行器。
   - **多智能体编排**：`miniq-agent` 提供多智能体派发（`agent_run`）、并发执行、检查点还原（checkpoint）、Token/步数预算监控与重试机制。
   - **桌面渲染端**：Tauri/Web 架构，包含 130 多个组件模块，支持三栏布局、右侧工作台（Workbench）、嵌入式多标签浏览器、文件源码与富文本预览。
   - **多端互联**：移动端（Android 已发布，iOS TestFlight）通过 `services/relay` 与桌面守护进程打通，支持远程消息操作与会话同步。

2. **已具备的强项工具链**：
   - **计算机操控（App & Desktop Automation）**：
     - 原生支持 macOS 后台无感辅助功能（`app_automation`，基于 AXUIElement），无需抢占用户光标即可实现窗口点击、滚动、设值。
     - 支持前台接管（`computer_use`），带视觉截图与全局键鼠事件。
   - **内嵌浏览器（Browser Automation）**：
     - 支持多标签切换、页面 Snapshot 语义解析、表单填写、视觉截图。
   - **开发运维集成**：
     - 内置 Terminal 终端、SSH 远程主机连接管理、Git 状态感知与代码 Diff 查看。
   - **文档与办公产物**：
     - 内置 `miniq-docs`，支持 docx、md、txt、xlsx、csv 的读写。

---

## 二、与 ChatGPT 相比的关键薄弱环节与痛点

通过对源码、测试用例与历史文档（`side-panel-comparison-2026-09-20.md`, `experience-improvement-ledger.md` 等）的交叉对比，miniQ 当前存在以下 8 大维度的显著薄弱项：

### 1. 设置体系（Settings）的完整度与精细度
- **现象**：ChatGPT 拥有 17 个分类严密的独立设置页（涵盖默认外部编辑器 VS Code/Cursor 关联、防系统休眠 Keep Awake、纯文本编辑器切换、上下文窗口 Token 消耗条、发送快捷键、队列处理模式、全局悬浮窗快捷键、详细的三级通知控制等）。
- **miniQ 现状**：设置选项相对初级，分散在不同抽屉中，缺乏对长任务防休眠、外部编辑器关联、全局弹出悬浮窗等桌面级体验设置。

### 2. 长任务输入区（Composer）的跟进与排队机制
- **现象**：ChatGPT 拥有极其丝滑的「跟进处理方式（Follow-up Queue Mode）」。当 AI 正在运行耗时数分钟的任务时，用户继续在输入框输入，界面支持「加入队列（排队）」或「调整方向（Steer 中断重定向）」，并有直观的待办队列托盘可上下拖动、编辑待执行消息。
- **miniQ 现状**：目前在任务运行时多为单向阻塞或打断，缺少视觉化待办消息队列与优先级调序交互。

### 3. 多智能体（Sub-agent）前台可视化与状态反馈
- **现象**：ChatGPT 在运行多子智能体时，主时间线上有醒目的多 Agent 头像堆叠组件、已完成步数 Badge（如 `子智能体 72 完成`），点击可无缝展开各个 Agent 的独立流水账。
- **miniQ 现状**：虽然底座具备强大的 `agent_run` 并发执行和 `process_output` 收集能力，但在前端界面上子任务的展开形态、实时进度反馈还不够生动，缺乏直观的头像堆叠与阶段性收敛动画。

### 4. 自动化任务中心（Automations / Scheduled Tasks）
- **现象**：ChatGPT 拥有系统顶层的「已安排的任务」主视图，提供开箱即用的任务模板库、周期性 Cron 调度、执行历史与产出物归档。
- **miniQ 现状**：miniQ 虽然有底层的任务循环与调度逻辑，但缺少一个类似 ChatGPT 一级导航的「定时自动化中心」UI，用户无法像使用自动化看板一样轻松创建、监控和暂停定时日常任务。

### 5. Office 办公产物的专业度与模板生态
- **现象**：ChatGPT 的 Primary Runtime 拥有经过深思熟虑的 Office 插件家族（`documents`, `spreadsheets`, `presentations`），每个插件内部都有详尽的排版质量规范与模板（`writing_quality.md`, `style_guidelines.md`），生成的 docx/pptx/xlsx 具有极高审美。
- **miniQ 现状**：`miniq-docs` 虽有基础读写能力，但更偏向纯工具调用，缺乏配套的「设计感模板系统」与「版式审美规约」，导致生成复杂 PPTX/Excel 时美观度有待提升。

### 6. Chrome 宿主直接复用（免登录生态）
- **现象**：ChatGPT 提供 `chrome` 插件，配合 Native Host 直接连接用户已打开的系统 Chrome，无缝复用用户的现有 Cookie 与登录态。
- **miniQ 现状**：主要依赖内嵌的独立浏览器（Isolated Browser），遇到需要复杂扫码登录、短信验证码的政企网站时，用户不得不重复登录。

### 7. 长效偏好记忆（Memories & Goals）
- **现象**：ChatGPT 将记忆持久化在独立的 SQLite（`memories_1.sqlite`, `goals_1.sqlite`），并在设置里提供用户可见可编辑的记忆列表（如「用户更喜欢用 TypeScript」「默认使用中文回答」）。
- **miniQ 现状**：`miniq-memory` 具备检索与存储 API，但在桌面 UI 上尚无一个一览无余、支持手动增删改查的「记忆与个人目标管理」看板。

### 8. 桌面级小确幸交互（Micro-interactions）
- **现象**：ChatGPT 拥有长任务完成后的系统通知提示音、状态徽标震动、菜单栏驻留小图标、任务完成彩纸礼炮（Confetti）、代码块一键投送到 VS Code、语音对话频谱动效等。
- **miniQ 现状**：整体风格偏向极客工程师工具，在细节的情绪反馈、动效与多系统托盘驻留上还有打磨空间。
