# ChatGPT / Codex 插件生态、技能与自动化机制盘点

> 调研基线：本机已安装运行的 Codex 架构（ChatGPT.app）中的官方捆绑插件目录 `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins`、动态运行时插件目录 `~/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins`、配置 `~/.codex/config.toml` 与自动化定义 `~/.codex/automations`。

---

## 一、插件标准体系与格式规范

ChatGPT (Codex) 采用极其统一、标准化的插件生态架构：
1. **目录结构**：
   - 包含元数据配置：`.codex-plugin`（标识为 Codex 原生插件）、`.mcp.json` 或 `desktop-mcp.json`（声明暴露给大模型的 Model Context Protocol 工具服务）、`.app.json`（声明内嵌应用与前端视图）。
   - 包含技能包（`skills/`）：存放结构化的 Skill 知识库与可复用自动化执行指令（如 `SKILL.md`）。
   - 包含可执行组件（`bin/`、`scripts/` 或 `resources/`）：Node.js 或 Python 脚本。
2. **多进程与运行时沙箱**：
   - 插件通过独立子进程（如专用 Node REPL、Python 运行环境或独立 MCP Server）拉起，不阻塞 Electron 主渲染线程。
   - 工具调用需符合 JSON Schema，大模型通过调用声明的 MCP 工具完成具体操作。

---

## 二、官方捆绑插件（Bundled Plugins）详解

在 `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins` 中内置的 13 个核心插件：

1. **`browser`（内置浏览器控制）**：
   - 基于隔离的浏览器实例，支持页面 snapshot、点击、滚动、文本输入、表单填写。
   - 核心安全机制：自动 Cookie/Session 隔离，严格按域名防外溢。
2. **`chrome`（Chrome 宿主集成）**：
   - 配合专用的 Chrome Native Messaging Host 与扩展程序，允许直接复用用户已登录的日常 Chrome 浏览器标签页。
   - 解决用户无需重复在 AI 沙箱里扫码登录复杂企业系统的问题。
3. **`unified-computer-use`（统一桌面计算机操作）**：
   - 整合了屏幕视觉截图（Vision）、macOS Accessibility 语义树（AXControls）、系统事件注入。
   - 具备后台无干扰操作（AX 语义）与前台接管（全局光标键盘）双通道。
4. **`codex-app-tools`（应用工具集）**：
   - 暴露 Electron 宿主桌面能力与项目工作区管理 API。
5. **`computer-history`（屏幕与操作历史追踪）**：
   - 记录会话期间的历史截图与操作回溯，防止死循环与重复无效点击。
6. **`record-and-replay`（操作录制与回放）**：
   - 允许录制一段桌面/浏览器操作流，并将其转化为可重复执行的自动化脚本。
7. **`deep-research`（深度调研与全网搜索聚合）**：
   - 递归展开长程搜索、自动摘要多篇文献/网页、生成专业综合分析报告。
8. **`latex`（公式与科技排版）**：
   - 本地 LaTeX 语法校验、编译与公式渲染预览。
9. **`sites`（本地 Web 应用预览与托管）**：
   - 本地轻量 Web 服务器，用于快速渲染 AI 生成的静态网页、单页应用并在侧边栏 WorkBench 中即时交互。
10. **`messages`（通讯与提醒）**：
    - 集成系统级通知、邮件/消息通道。
11. **`visualize`（图表与数据可视化）**：
    - 快速将结构化数据（JSON/CSV）转换为交互式图表（折线图、柱状图、桑基图等）。
12. **`user-writing`（用户写作风格与质量分析）**：
    - 辅助生成符合用户语气偏好、文风标准的长文本。

---

## 三、文档与 Office 生产力插件（Primary Runtime Plugins）

在 `~/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins` 中，OpenAI 针对严肃办公场景设计了一整套 Office 专家插件：

1. **`documents`（Word / 文档生成专家）**：
   - 配备专用 `render_docx.py` 与样式模板库。
   - 包含专业 Skill 指南：`writing_quality.md`、`template-create.md`、`template-distill.md`。
   - 特点：不是简单输出纯文本，而是严格按照排版规范生成标准 `.docx` 文档（标题层级、首行缩进、专业页眉页脚、统一表格边框配色）。
2. **`spreadsheets`（Excel / 表格处理专家）**：
   - 包含规范：`style_guidelines.md`、`clarification-questions.md`、`template-elicitation.md`。
   - 特点：掌握复杂财务模型、公式计算（SUMIF/VLOOKUP）、单元格高亮规则与图表自动绑定。
3. **`presentations`（PowerPoint / 幻灯片演示专家）**：
   - 包含规范：`style_guidelines.md`、`native_evidence.md`、`template_following.md`。
   - 特点：按母版版式、母版调色盘、卡片式布局精准生成多页 PPTX。
4. **`pdf`（PDF 审阅与解析）**：
   - 深度支持页码定位、表格提取与高保真图文抽取。
5. **`template-creator`（模板设计器）**：
   - 帮助用户从已有文件反向提炼企业模板，供后续自动化批量产出复用。

---

## 四、自动化调度（Automations）与记忆体系（Memories / Goals）

1. **自动化任务架构**：
   - 物理存储在 `~/.codex/automations/<task_id>/`。
   - 包含完整运行配置文件与提示词模板。
   - 系统级守护进程按 Cron / 定时表达式在后台静默拉起，通过 MCP 调用网络工具与生成模型，完成后写入本地产物目录并向操作系统推送通知。
2. **长效记忆（Memories & Goals）**：
   - 存储在 `~/.codex/memories_1.sqlite` 与 `~/.codex/goals_1.sqlite`。
   - **事实记忆（Memories）**：自动提取用户在长对话中透露的持久偏好（编程语言习惯、输出语言、职业背景、常用库版本），并在后续所有新会话中自动注入上下文。
   - **目标追踪（Goals）**：持续跨会话跟踪用户设定的中长期里程碑与待办进展。
