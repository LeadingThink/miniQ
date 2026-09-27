---
name: visual-diagrams
description: 当用户需要流程图、时序图、架构图、甘特图、思维导图，或想要一个可交互的概念讲解页面（例如“用动画解释 TCP 握手/复利/排序算法”）时使用。
origin: installed
---

# 图解与交互式讲解

## 适用场景
- 结构类：流程图、时序图、类图、状态图、ER 图、甘特图、思维导图、用户旅程图 → **Mermaid**。
- 讲解类：带滑块/按钮/分步动画的概念解释页（算法、物理、金融公式、系统原理）→ **原生 JS + SVG/Canvas 或 D3**。

## 前置条件
- Mermaid CDN：`https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`（离线时按 visual-charts 的方法内联）。
- 可选：若已安装 `mmdc`（`npm i -g @mermaid-js/mermaid-cli`），可以导出 SVG/PNG。

## 步骤

### A. Mermaid 图
1. 先用文字梳理节点和关系，与用户确认范围（节点超过 25 个时建议拆图）。
2. file_write 生成单文件 HTML：
   ```html
   <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>标题</title>
   <style>body{font-family:-apple-system,"PingFang SC",sans-serif;padding:24px}</style></head>
   <body><h1>标题</h1>
   <pre class="mermaid">
   flowchart LR
     A[用户下单] --> B{库存充足?}
     B -- 是 --> C[扣减库存] --> D[生成支付单]
     B -- 否 --> E[提示缺货]
   </pre>
   <script type="module">
   import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
   mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default", securityLevel: "strict" });
   </script></body></html>
   ```
   常用语法：`sequenceDiagram`、`classDiagram`、`stateDiagram-v2`、`erDiagram`、`gantt`（`dateFormat YYYY-MM-DD`）、`mindmap`、`journey`。节点文字中含括号或特殊符号时要加引号：`A["处理(异步)"]`。
3. 也可以只交付 Mermaid 代码块（用户要贴到 Notion/GitHub/Markdown 时）。需要图片时用 shell_run：`mmdc -i diagram.mmd -o diagram.svg -b transparent`。

### B. 交互式讲解页
1. 设计：一个核心概念 + 1–3 个可调参数（`<input type="range">`）+ 实时变化的可视化 + 每一步的文字说明；提供“上一步/下一步/自动播放”控件。
2. 结构：左侧（或上方）为 SVG/Canvas 画布，右侧（或下方）为说明文字；把状态集中在一个 `state` 对象中，`render(state)` 为纯函数，控件只负责修改 state 并重新渲染。
3. 用 `requestAnimationFrame` 或 D3 transition 实现动画；公式可以用 KaTeX CDN（`https://cdn.jsdelivr.net/npm/katex@0.16/dist/`）。
4. 讲解内容必须准确；涉及事实或数据时，用 web_search / web_fetch 核实并在页面底部注明来源。

### C. 验证（两类都需要）
1. browser_automation 打开 `file:///…html` → `wait` 1500ms → `screenshot`。
2. view_image 检查：Mermaid 是否已渲染为图形（若仍显示为源码文本，说明语法错误，可在 snapshot 中查看 “Syntax error” 提示并修正）；文字有没有重叠，连线是否清晰。
3. 交互页：用 browser_automation `click` “下一步”，或 `drag` 拖动滑块后再截图，确认状态确实发生变化。
4. 修改后重复验证；最后交付文件路径和截图。

## 注意事项 / 安全
- Mermaid 使用 `securityLevel: "strict"`，不要在图中嵌入用户提供的 HTML 或脚本。
- 只从 jsDelivr 等可信 CDN 加载库；不接入追踪脚本。
- 覆盖已存在的文件前先 ask_user。
