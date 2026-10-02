# ChatGPT 桌面客户端（Codex Electron 架构）全面功能与 UI 盘点报告

> 盘点基线：本机运行的 `/Applications/ChatGPT.app`（版本 `26.901.51231`，内部代号 Codex，Electron 架构，ASAR 解包自 `/private/tmp/chatgpt-asar-inspect.1VrZt9/`），结合 `app_automation` 真实运行态截图、AX 控件树、`~/.codex/config.toml` 及本地运行时缓存进行实测核对。

---

## 一、客户端整体架构与形态

1. **核心架构与多进程模型**：
   - 基于 Electron 框架，前端为 Vite 打包的 React SPA（7,943 个 chunk 模块，分片高度组件化与按需加载）。
   - 包含高性能本地独立服务：
     - `codex` 原生守护进程（210MB）
     - `cua_node` 专用 Node 24.19.0 运行环境与 REPL 宿主（345MB）
     - `codex-code-mode-host`（60MB）
     - 原生 Node 扩展包（`native/`）：`bare-modifier-monitor.node`（按键监听）、`browser-use-peer-authorization.node`（浏览器授权）、`devicecheck.node`、`hid-topology-watcher.node`、`input-monitoring-permission.node`、`launch-services-helper`、`sky.node`、`sparkle.node`（自动更新）、`system-audio-spectrum`（系统音频频谱可视化）。
   - 内置专用 CLI 工具：`codex` CLI、`rg`（ripgrep）、`scripts/launch_codex_app_tools_mcp`。

2. **主交互视窗形态**：
   - 采用标准三栏式弹性工作台：
     - **左侧栏（导航与组织）**：置顶会话（Pinned）、项目分组（Projects，支持折叠展开）、归档会话、定时任务（已安排的任务）、快捷动作（新对话、Pull Request）、底部用户账户与设置入口。
     - **中间栏（对话与多 Agent 执行流）**：主对话流、分层折叠工具调用、实时代码 diff、耗时计时器（`已处理 X分钟 Y秒`）、子智能体状态指示器（多子智能体头像堆叠 + `N 完成` badge）、底部 Composer 输入区。
     - **右侧工作面板（Workbench）**：支持并排多标签工作区（网页浏览器、文件源码/富文本预览、Git Diff 审阅、终端、Worktree 切换、已安排任务详情），可拖拽调宽或一键全屏/隐藏。

---

## 二、设置体系（Settings）全功能清单

通过 `app_automation` 深入 ChatGPT 设置面板，其设置分为「个人」、「集成」、「编码」、「已归档」四大类别共 17 个子页面：

### 1. 个人设置
- **常规（General）**：
  - **默认文件打开位置**：可选择 VS Code、Cursor、系统默认等外部编辑器，支持一键在外部 IDE 中跳转打开产物。
  - **语言**：应用 UI 语言切换（支持自动检测、简体中文等）。
  - **在菜单栏中显示（Menu Bar Extra）**：关闭主窗口后，仍保留在 macOS 顶部菜单栏常驻图标，快速调出。
  - **底部面板（Bottom Panel）**：在应用标题栏中显示底部面板控件，快速切换折叠状态。
  - **默认终端位置**：可选择显示在「底部」或「右侧」。
  - **运行时防止系统休眠（Keep Awake）**：在 ChatGPT 执行长时间任务（如批量跑代码、网络调研）时，自动阻止系统睡眠，防止后台断流。
  - **开源许可证**：第三方依赖声明。
  - **插件总开关**：允许使用已安装插件。
  - **编辑器行为（Editor）**：
    - **纯文本编辑器**：编写消息时，将代码、Markdown 和链接保留为纯文本，防止误触富文本格式污染。
    - **显示上下文窗口使用情况**：在界面直观展示当前会话已消耗的 Context Window token 比例与上限。
    - **发送快捷键**：可配置为「按 Enter 键发送」（Shift+Enter 换行）或「按 ⌘+Enter 发送」。
    - **跟进处理方式（Follow-up Queue Mode）**：核心长任务交互机制！当 AI 正在运行时，用户输入后续消息的处理策略：
      - 「**加入队列（Queue）**」：不打断当前运行，当前任务结束后自动消费该条消息。
      - 「**调整方向（Steer）**」：立即中断或重定向当前任务运行方向。
      - 辅助按键：按 `⌥+Enter`（Alt+Enter）可灵活临时对单条消息反向操作。
  - **弹出窗口（Quick Popover / Spotlight 模式）**：
    - 全局快捷键激活小窗悬浮面板，即开即走。
    - 默认使用独立聊天：在任何项目外开始新聊天。
  - **通知控制（Notifications）**：
    - **轮次完成通知**：可配置「仅在未聚焦时」、「总是」或「从不」。
    - **启用权限通知**：当后台任务需要用户授权敏感操作时，发出系统通知。
    - **启用问题通知**：当任务遇到 `ask_user` 或输入阻塞时主动弹通知。
  - **趣味实验（Experiments）**：
    - 彩纸礼炮（Confetti）：任务圆满成功或触发彩蛋时全屏放彩纸。
    - 音频可视化（Audio Visualizer）：使用系统音频为语音对话添加实时频谱动效。
- **导入（Import）**：外部会话、配置、历史数据导入。
- **外观（Appearance）**：系统跟随、明亮、深色主题；字号缩放。
- **底部（Bottom Panel Config）**：配置底部面板工具栏挂载的快速工具。
- **配置（Profile / Custom Instructions）**：用户全局背景偏好、角色身份定义。
- **个性化（Personalization & Memory）**：内置记忆库开关、管理用户事实记忆列表、记忆删除与检索。
- **宠物（Pet）**：Codex 实验性内置桌面宠物系统（基于 `hatch-pet` skill，在工作台中陪伴）。
- **键盘快捷键（Keyboard Shortcuts）**：全局与应用内快捷键完整列表与自定义。
- **账户（Account）**：订阅状态、API 账单、登录身份。

### 2. 集成（Integrations）
- **电脑操控（Computer Use）**：
  - 原生支持 macOS Accessibility 与 Screen Recording 联动。
  - 支持后台应用模式与前台接管模式。
  - 授权沙箱与高危操作白名单机制。
- **应用快照（Appshots）**：捕捉应用运行时状态快照与环境还原。
- **插件（Plugins）**：市场浏览、本地插件加载、已安装插件开关与工具白名单审批设置。
- **浏览器（Browser）**：
  - 双引擎控制：内置 In-App Browser（隔离 Webview）与系统已安装的 Google Chrome 原生连接扩展。
  - 域名访问控制列表、自动 Cookie 隔离。

### 3. 编码（Coding & Dev Environment）
- **钩子（Hooks / Scripts）**：支持在模型操作前后运行自定义 shell 脚本/通知钩子（如 `notify = "SkyComputerUseClient"`）。
- **连接（Connections & Remote）**：SSH 远程主机连接、远程开发容器、云端环境（Cloud Environments）。
- **Git**：全局 Git 身份、签名、默认远程、分支命名规则。
- **环境（Environments）**：Node、Python、Rust 运行环境探测与沙箱隔离策略。
- **Worktrees**：多工作树并行隔离开发支持。

### 4. 已归档（Archive）
- 已归档聊天管理、检索、还原与永久删除。

---

## 三、输入区（Composer）与交互模式

1. **输入区能力组件**：
   - 胶囊型多状态输入框，支持附件粘贴、本地文件拖拽、图片即时预览。
   - **完全访问模式 / 沙箱模式切换开关**（如截图可见「完全访问」开关），给用户一键授权安全感。
   - **模型选择器与推理强度切换**：如 `6 Astra Ultra`，支持下拉切换模型、协议及 Reasoning Effort。
   - **Slash 命令体系**：`/` 呼出内置命令与 Skill 选择器。
   - **多消息排队与队列托盘**：当任务运行时，输入框下方出现队列状态条，展示排队中的提示词，支持在队列中上下调整顺序、编辑或移除。

2. **流式输出与任务分层展示**：
   - **时间线（Timeline）**：主文本流清晰可读，工具执行不破坏 Markdown 排版。
   - **子智能体（Sub-agent）可视化**：
     - 在任务运行条上显示并行子智能体图标、当前状态与统计（例如截图实测：`子智能体 [图标1][图标2][图标3] 72 完成`）。
     - 支持点击展开子智能体工作流独立时间线与产物。
   - **实时执行计时器**：显示耗时 `已处理 2分钟 23秒`，任务完成后转换为固定总耗时。
   - **折叠式代码块与引用**：代码执行结果自带行号、快速复制按钮、在编辑器中打开按钮。

---

## 四、项目与组织模式（Projects）

1. **会话归集到项目**：
   - 左侧侧边栏按 Project 进行树状聚合（如 `桌面`、`miniQ`、`wechat-ai-workspace`、`meeting`、`zaiwenai`、`showee`）。
   - 每个项目可以绑定特定工作目录与 Git 仓库。
   - 项目支持独立上下文记忆、独立规则提示（Project Instructions）。

2. **Git 一体化感知**：
   - 项目标题栏直接显示当前 Git 分支（如 `codex/release-0.1.41`）与变更状态 badge（如 `+319 -175`）。
   - 顶部快捷操作栏直接提供 `Pull Request` 创建按钮与 `提交或推送` 按钮。
   - 点击变更 badge 直接在右侧面板打开可视化的 Git Diff 审查器。

---

## 五、定时自动化任务（Automations）

通过实际检查 ChatGPT 界面与 `~/.codex/automations` 目录：
1. **统一的「已安排的任务」中心**：
   - 提供按计划触发或周期性运行的任务列表（Daily / Hourly / Cron 调度）。
   - 内置 AI 建议模板，用户可一键克隆常见工作流（如「每日 AI 新闻公众号稿」、「每日代码仓库自动 Review」）。
2. **任务持久化与隔离存储**：
   - 每个自动化任务拥有独立 ID、绑定目标项目、独立的提示词配置与执行记录（包含最后运行时间、状态、产出物链接）。
   - 失败重试策略、静默执行与通知推送配置。
