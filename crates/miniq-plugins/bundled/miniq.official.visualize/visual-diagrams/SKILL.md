---
name: visual-diagrams
displayName: 图解、交互式讲解与 UI 原型
description: 当用户需要流程图、时序图、架构图、甘特图、思维导图，或想要可交互的概念讲解页（如“用动画解释 TCP 握手/复利/排序算法”）、可调参数的 UI 原型时使用；输出 Mermaid 或单文件 HTML/SVG，并截图自检。
version: 1
---

# 图解、交互式讲解与 UI 原型

## 何时用、何时不用
- **结构类**：流程图、时序图、类图、状态图、ER 图、甘特图、思维导图、用户旅程图 → **Mermaid**。
  - 用户只是在对话里看一眼，或要贴到 GitHub、Notion、Markdown 里：**直接给 ```mermaid 代码块**，不必生成文件。
- **讲解类**：概念解释页，带滑块、按钮或分步动画（算法、物理、金融公式、系统原理）→ 原生 JS + SVG/Canvas，或者 D3。
- **UI 原型**：按钮、卡片、弹窗、页面的外观探索 → HTML 片段加 Tweak 微调面板（见 `../visual-charts/references/tweak.md`）。
- **数据图表**：交给 `visual-charts`。
- **给项目本身写图表或组件**：直接改项目代码，不生成独立文件。

## 前置条件
- Mermaid 从 CDN 加载，并锁定版本：`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs`。离线时按 visual-charts 的方法内联。
- 共用脚本在 `../visual-charts/scripts/viz.py`，提供 wrap/check/serve 三个子命令。
- 可选：已安装 `mmdc` 时，可以导出 SVG 或 PNG。本机没有 node 时跳过这一项。
- browser_automation 不支持 `file://`，预览必须通过 `viz.py serve`。

## 步骤

### A. Mermaid 图
1. 先用文字梳理节点和关系，和用户确认范围。节点超过 25 个时，建议拆成几张图。
2. 写片段文件，例如 `flow.frag.html`：
   ```html
   <h2>下单流程</h2>
   <pre class="mermaid" role="img" aria-label="下单流程图">
   flowchart LR
     A[用户下单] --> B{库存充足?}
     B -- 是 --> C[扣减库存] --> D[生成支付单]
     B -- 否 --> E[提示缺货]
   </pre>
   <script type="module">
   import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
   const dark = matchMedia("(prefers-color-scheme: dark)").matches;
   mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "default", securityLevel: "strict",
     fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-sans") });
   </script>
   ```
   然后运行 `python3 ../visual-charts/scripts/viz.py wrap flow.frag.html -o flow.html --title "下单流程"`。
3. 常用图类型：
   - `sequenceDiagram`
   - `classDiagram`
   - `stateDiagram-v2`
   - `erDiagram`
   - `gantt`（配合 `dateFormat YYYY-MM-DD`）
   - `mindmap`
   - `journey`

   节点文字含括号或特殊符号时要加引号，例如 `A["处理(异步)"]`。

### B. 交互式讲解页
1. **设计**：
   - 一个核心概念，配 1–3 个可调参数（`<input type="range">` 加 `<output>`）。
   - 可视化实时变化，每一步配一句说明。
   - 提供“上一步 / 下一步 / 自动播放”按钮。
2. **结构**：
   - 状态集中放在一个 `state` 对象里。`render(state)` 写成纯函数，控件只负责修改 state 并调用 render。
   - 说明文字所在的区域加 `aria-live="polite"`。
3. **样式**：使用 `viz-base.css` 的令牌，见 `../visual-charts/references/design-system.md`。
4. **动画**：用 `requestAnimationFrame` 或 D3 transition，并尊重 `prefers-reduced-motion`。
5. **公式**：可以用 KaTeX，锁定版本，从 `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/` 加载。
6. **内容准确**：涉及事实或数据时，用 web_search 或 web_fetch 核实，并在页面底部注明来源。

### C. UI 原型
1. 选出 2–5 个真正影响决策的设计变量，例如圆角、强调色、密度、布局。
2. 按 `tweak.md` 编写片段，用 `viz.py wrap 片段.html -o 原型.html --tweak` 生成页面。
3. 请用户试调后点击“复制参数”，把结果发回来，再把选定的取值落到正式代码里。

### D. 检查与渲染自检（A、B、C 都需要）
1. 静态检查：`python3 ../visual-charts/scripts/viz.py check <文件>`。有错误必须修正。
2. 启动服务：用 shell_run 在后台运行 `viz.py serve <文件>`，再用 process_output 取得预览地址。
3. browser_automation 依次执行：`open` 预览地址 → `wait` 1500ms → `screenshot`。然后 `resize` 到 390×844，再截一张。
4. 用 view_image 检查：
   - Mermaid 已经渲染成图形。如果还显示源码文本，说明语法有错：在 snapshot 里找“Syntax error”，修正后重试。
   - 文字没有重叠，连线清晰，深色模式下可读。
5. 交互页：`click` “下一步”，或拖动滑块，然后再截图，确认状态确实变了。
6. 修改后重复验证。完成后用 process_kill 结束服务，并关闭标签页。

## 隐私与安全
- Mermaid 使用 `securityLevel: "strict"`，图中不嵌入用户提供的 HTML 或脚本。
- 只从白名单 CDN 加载库，不接入追踪脚本，不发送网络请求。
- 覆盖已有文件前，先询问用户。

## 交付格式
- 只给 Mermaid 代码块时：代码块，外加一句说明图的读法。
- 生成文件时：
  - 文件绝对路径。
  - 1–3 句说明这张图或这个页面怎么看、怎么操作。
  - 自检结果。
  - 必要时附截图。
- UI 原型：同时说明可以调哪些变量，以及“复制参数”后如何把结果发回来。
