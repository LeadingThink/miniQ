---
name: product-design-router
displayName: 产品设计总入口
description: 产品设计插件总入口与路由。用户提出设计、原型、还原截图、克隆网页、重设计、出方案、设计评审、用户调研或分享原型等需求但未指定技能，或请求跨多个环节时，先用本技能判定路径并加载通用规则
version: 1
---

# 产品设计总入口

本插件把一次产品设计工作拆成：**建立上下文 → 简报关卡 → 研究/构思 → 构建 → 视觉 QA → 交付/分享**。本技能负责判断用户处在哪个环节、该走哪条路径，并确保所有技能共享同一套硬规则。

## 触发场景

- “帮我设计一个……页面/App/后台”“做个原型”“出几个方向”
- “照这张图做出来”“把这个网站复刻一份”“像 Linear 那样重做我们的设置页”
- “帮我看看这个注册流程有什么问题”“做个设计走查”
- “用户都在吐槽什么”“把原型发给同事看”
- 用户第一次使用本插件，或不清楚插件能做什么

## 前置条件

- 必读通用参考（每次任务开始时用 `file_read` 读取，已读过的本轮不必重读）：
  - `references/critical-rules.md`：关键覆盖规则（最高优先级）
  - `references/communication.md`：沟通协议
- 按需参考：
  - `references/existing-codebase.md`：在已有项目里改动时
  - `references/local-preflight.md`：新建本地原型前

## 技能地图

| 技能 | 负责什么 | 何时进入 |
| --- | --- | --- |
| `product-design-user-context` | 保存/读取产品上下文 `user-context.md`，首次引导 | 每个任务开始时跑预检；首次使用或用户要求“记住我们的产品信息” |
| `product-design-brief` | 简报关卡：目标与用户结果不清就问，清楚就复述默认值并继续；也可产出完整简报与流程图 | 所有构建/构思任务之前 |
| `product-design-research` | 用户痛点、竞品、评论、访谈纪要的研究综合 | 用户要调研或方向依赖证据时 |
| `product-design-ideate` | 用 `generate_image` 产出 2–4 个真正不同的视觉方向 | 需要方向、重设计、只有文字需求时 |
| `product-design-prototype` | 从简报/流程快速搭建可交互原型（线框或高保真） | 没有指定参考图，只需要“能点的原型” |
| `product-design-image-to-code` | 把选定图片/截图/设计稿忠实还原为可交互前端 | 有明确视觉目标图 |
| `product-design-url-to-code` | 把线上网址克隆成本地前端 | 用户明确要“克隆/复刻/一模一样” |
| `product-design-review` | 设计审计：截图取证后给 UX/视觉/无障碍发现 | 评审、走查、审计、找问题 |
| `product-design-qa` | 参考与原型并排比较的阻塞关卡，写 `design-qa.md` | 所有构建类任务交付前 |
| `product-design-share` | 把本地原型部署为可分享链接 | 用户明确要求部署/分享 |

## 分步流程

1. **上下文预检**：运行 `product-design-user-context` 的预检脚本（`shell_run`）：
   `python3 <插件目录>/product-design-user-context/scripts/preflight.py check --workspace <工作区>`。
   若 `user-context.md` 不存在且用户是在做一个长期产品，按该技能做首次引导（可以跳过，不阻塞当前任务）。
2. **判定路径**（按顺序匹配第一条）：
   1. 用户说“部署/发布/分享链接” → `product-design-share`。
   2. 用户说“评审/走查/审计/找问题/打分” → `product-design-review`。
   3. 用户说“调研/痛点/竞品分析/用户在说什么” → `product-design-research`。
   4. 用户说“克隆/复刻/一模一样/照这个网址做”且**没有**“更好/像/改进/重设计” → `product-design-url-to-code`。
   5. 用户提供了图片/截图/设计稿并要求“做出来/还原/写成代码” → `product-design-image-to-code`。
   6. 用户说“像某某/比某某更好/重新设计/改版/优化一下视觉” → **重设计链路**：`product-design-brief` → 用 `browser_automation` 或 `view_image` 截取/查看当前界面与参考对象 → `product-design-ideate` → 用户选定 → `product-design-image-to-code`。
   7. 用户要“几个方向/几版方案/灵感” → `product-design-brief` → `product-design-ideate`。
   8. 用户要“原型/线框/能点的 demo”，没有参考图 → `product-design-brief` → `product-design-prototype`（高保真且无视觉方向时，先 ideate）。
   9. 其余模糊请求 → `product-design-brief`，由简报关卡澄清。
3. **是否在现有代码库**：工作区已有前端项目且用户要改它 → 叠加 `references/existing-codebase.md`，先找设计系统与 token。
4. **构建前预告**：进入任何构建技能前，发一条带预期耗时的简短消息，然后同轮开始。
5. **QA 关卡**：构建技能收尾一律进入 `product-design-qa`，未 `passed` 不交付。
6. **交付**：按 `references/communication.md` 的交付格式，附分享提示，结尾恰好一个下一步。

## 工具与参数要点

- `file_read`：读取参考文档与 user-context.md。
- `shell_run`：运行预检脚本；后台启动本地预览。
- `browser_automation`：截图取证与验证，设置视口（手机 390×844，桌面 1440×1024）。
- `view_image` / `view_pdf`：查看用户给的图片、PDF 与所有截图。
- `ask_user`：只在简报关卡或路径确实无法判定时使用，一次问清。
- `agent_run`：多个独立资产生成、多页面截图可并行分派；共享文件写入保持串行。

## 质量检查

- 路径判定后确认：克隆与重设计没有混淆；构建任务都挂上了 QA 关卡。
- 所有截图与生成图都用 `view_image` 亲眼看过再使用或下结论。
- 交付消息符合沟通协议：结果先行、简短、恰好一个下一步。

## 失败回退

- 无法判定路径：用 `ask_user` 问一个二选一问题（如“是要一模一样地复刻，还是做一个更好的新版本？”）。
- 某技能依赖的工具不可用（如浏览器无法打开）：说明受阻点，给出替代方案（如请用户提供截图），不要伪造结果。
- 用户中途改变目标：回到第 2 步重新判定。

## 交付格式

路由本身不单独交付；由被路由的技能按其“交付格式”产出。若用户只问“插件能做什么”，用 3–5 行概述能力并以一个建议的起点结尾。
