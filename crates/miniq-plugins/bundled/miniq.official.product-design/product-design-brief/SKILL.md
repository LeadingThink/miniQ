---
name: product-design-brief
displayName: 设计简报关卡
description: 设计简报关卡。任何出方案、原型、还原或重设计之前先用：目标或用户结果不清时一次提问，清楚时一句话复述默认值并同轮继续，缺目标不得实现；用户需要时也产出完整产品简报、页面清单与 Mermaid 用户流程
version: 1
---

# 设计简报关卡

本技能有两种模式：
- **关卡模式（默认，每次构建前都要过）**：快速判断“能不能开工”，能就用默认值继续，不能就问。
- **完整简报模式**：用户要“理清思路 / 写产品简报 / PRD 前置 / 画用户流程”时，产出 `design/brief.md` 与 `design/flows.md`。

## 触发场景

- 路由到 ideate、prototype、image-to-code、url-to-code、重设计链路之前
- “我想做一个……帮我理一下”“写个产品简报”“画一下用户流程”
- 需求只有一句话、看不出要给谁用或要达成什么

## 前置条件

- 已运行 `product-design-user-context` 预检，拿到已保存上下文（没有也可继续）。
- 已读 `product-design-router/references/critical-rules.md` 与 `communication.md`。
- 判定清单与默认值表见 `references/gate-checklist.md`；完整简报模板见 `references/brief-template.md`。

## 分步流程（关卡模式）

1. **收集已知信息**：本轮用户消息、附件（图片用 `view_image`，PDF 用 `view_pdf`，文档用 `doc_read`）、`user-context.md`、`memory_search` 查到的偏好、工作区现有代码（`glob`）。
2. **判定两个核心项**：
   - **目标**：要设计/构建的是什么界面或解决什么问题？
   - **用户结果**：谁在用、用完得到什么（完成什么任务）？
   能从上下文合理推出的算“清楚”；只能靠编造的算“不清楚”。
3. **不清楚 → 提问并停下**：用 `ask_user` 一次问清，最多 3 题，每题给建议选项与默认值（题目模板见 `references/gate-checklist.md`）。拿到回答前**不生成图片、不写代码、不搭项目**。
4. **清楚 → 复述并继续**：用一句话说出将采用的默认值（平台/视口、保真度、视觉来源、范围），例如“按手机端 390 宽、沿用你们现有蓝色主题做注册到首单的三屏原型。”然后**同一轮**进入下一个技能，不等待确认。
5. **次要缺口用默认值**：平台、视口、页数、风格等次要信息按 `references/gate-checklist.md` 的默认值表补全，不为它们单独提问。
6. **重设计附加步骤**：用户说“像某某/比某某更好/重设计”时，在复述中点明“这是重设计，会先截图现状和参考，再出几个方向供你选”，随后进入截图与 `product-design-ideate`。

## 分步流程（完整简报模式）

1. 先完成关卡模式第 1–3 步（信息不足时一次问清：目标用户、现有替代方案、成功标准、平台、约束）。
2. **竞品速览（可选）**：需要证据时转 `product-design-research`，或直接 `web_search` → `web_fetch` 挑 3–5 个竞品，只记定位、核心流程、差评痛点，附来源链接。
3. **写简报**：`file_write` 到 `design/brief.md`，结构见 `references/brief-template.md`（定位、用户与场景、JTBD、MVP/之后/不做、成功指标、风险与待验证假设）。
4. **画流程**：`file_write` 到 `design/flows.md`，用 Mermaid `flowchart`；每条主流程标注入口与异常分支（网络失败、权限被拒、空数据），并附页面清单表（页面、目的、关键元素、跳转）。
5. **可视化检查（可选）**：写一个引入 mermaid 的 HTML，用 `browser_automation` 打开截图，`view_image` 检查可读性；或经 `ask_user` 同意后 `shell_run` 执行 `npx -y @mermaid-js/mermaid-cli -i design/flows.md -o design/flows.svg`。
6. 需要 Word 版时用 `doc_write` 导出 `design/brief.docx`。

## 工具与参数要点

- `ask_user`：只在关卡判定“不清楚”时用；一次最多 3 题，附选项与默认值。
- `view_image` / `view_pdf` / `doc_read`：读用户给的材料，不要只凭文件名判断。
- `memory_search`：查“固定平台”“品牌色”等历史偏好。
- `file_write`：`design/brief.md`、`design/flows.md`；覆盖已有文件前 `ask_user`。

## 质量检查

- 关卡模式：复述句包含平台/视口、保真度、视觉来源三项；没有编造目标。
- 完整简报：无编造数据（市场规模、用户量写“假设，待验证”）；竞品信息有来源链接；Mermaid 语法可渲染（如做了可视化检查，截图已用 `view_image` 看过）。

## 失败回退

- 用户对提问不回应或说“你定”：目标仍不明确时，给出一个最可能的目标供用户一键确认，**不要**自行开工。
- 用户给的附件打不开：说明原因，请用户重新提供或描述。
- Mermaid 渲染失败：保留源码，说明渲染失败但不影响阅读。

## 交付格式

- 关卡模式：一句话复述（或一次 `ask_user`），然后直接进入下一技能。
- 完整简报模式：2–4 行总结关键决策 + 文件位置，结尾一个下一步（通常是“要不要先出三个视觉方向？”）。
