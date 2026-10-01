---
name: product-design-qa
displayName: 设计 QA（阻塞关卡）
description: 设计 QA 阻塞关卡：把参考图与原型截图在同视口同状态下并排比对，按评分细则登记 P0–P3 问题写入 design-qa.md，修复 P0–P2 并循环直到结论为 passed；截图受阻则 blocked 并停止。任何原型、还原交付前必须使用
version: 1
---

# 设计 QA（阻塞关卡）

QA 回答一个问题：**实现是否与参考一致、核心交互是否可用**。它是交付前的硬关卡——`design-qa.md` 最后一行不是 `final result: passed`，就不能对用户说“做好了”。

## 触发场景

- `product-design-prototype`、`product-design-image-to-code`、`product-design-url-to-code` 实现完成后（自动进入）
- 用户说“检查一下还原度”“对一下和设计稿的差异”
- 修改已有原型后的回归检查

## 前置条件

- 参考：`design/qa/reference/` 下的参考图（原图、选定方向图、网址截图）；纯文字需求的原型以 `design/prototype/README.md` 的屏幕与状态清单为参考。
- 原型能在本地打开（`../product-design-prototype/scripts/serve.py` 已启动或可启动）。
- 评分细则见 `references/qa-rubric.md`。

## 分步流程

1. **建报告**：`python3 scripts/qa_report.py init --file design/qa/design-qa.md --target <原型地址或路径> --reference <参考来源> --viewport <宽x高>`。
2. **截图**：`browser_automation` `resize` 到与参考**相同的视口**，打开每一屏与参考**相同的状态**（同一数据、同一 Tab、同一滚动位置），`screenshot` 保存到 `design/qa/screenshots/<与参考同名>.png`。
   - 截图失败：换端口/重启服务器重试一次；仍失败 → `qa_report.py finalize --blocked "<原因>"`，停止并如实告诉用户。
3. **并排比对**：对每一对图，在同一次 `view_image` 批量调用中同时查看参考与截图（先整体，再 `detail: original` 看细节），按细则的 7 个维度逐项比较。
4. **走交互**：按屏幕清单实际点击核心路径（导航、Tab、表单校验与提交、加载/空/成功态、hover/focus），不能用的记为问题。
5. **登记问题**：每个差异 `qa_report.py add --severity P? --screen "<屏>@<视口>" --issue "<现象：参考是 X，实现是 Y>" --fix "<计划>"`。严重度按细则判定，拿不准时就高不就低。
6. **修复并循环**：用 `file_edit` 修复所有 P0–P2 → 逐个 `qa_report.py resolve --id N --note "<改了什么>"` → `qa_report.py round` → **重新截图并重新比对**（回到第 2 步；修复可能引入新问题）。
7. **定结论**：`qa_report.py finalize`。若输出 `failed`，继续第 6 步；最多 5 轮，仍未通过则如实报告剩余问题，不得宣称通过。
8. **校验**：`qa_report.py verify` 必须返回 `ok: true`。在评分表中填写各维度得分。
9. **交回**：把结论和 P3 后续项交回调用方技能用于交付说明。

## 工具与参数要点

- `scripts/qa_report.py`：子命令 `init / add / resolve / round / finalize / verify`，最后一行输出 JSON；`finalize` 在存在未修复 P0–P2 时返回 `failed`（退出码 1）。不要手工把结论改成 passed。
- `browser_automation`：截图前确认页面加载完成；模板原型可用 `#屏幕id`、`?state=empty` 直达状态。
- `view_image`：参考图与截图放在同一批调用里并排看；结论只基于实际看到的像素。
- `file_edit`：修复用小改动；每改一处记录在对应问题的 note 中。

## 质量检查

- 每个参考图都有同名截图，且视口一致。
- 每条问题都写清“参考是什么、实现是什么”。
- `verify` 通过；最终结论为 passed 时不存在未修复的 P0–P2。
- 报告中的评分与问题一致（有 P1 的维度不应打 5 分）。

## 失败回退

- 没有参考图（纯文字需求）：以屏幕与状态清单 + 细则中的“通用质量”项为基准，并在报告“参考来源”中注明。
- 参考图与实现视口无法一致（例如参考是 1170 宽截图）：换算为 CSS 视口（1170 → 390），在报告中注明换算。
- python3 不可用：按同样结构手写 `design-qa.md`（问题表 + 最后一行 `final result:`），并自行核对未修复 P0–P2 为 0 才写 passed。
- 连续 5 轮未通过：停止循环，结论保持 failed，向用户说明卡点并给出一个下一步。

## 交付格式

- 文件：`design/qa/design-qa.md`、`design/qa/screenshots/`。
- 返回给调用方（或用户）：结论一句（通过/未通过/受阻）+ 轮次 + 已修复数量 + P3 后续项列表。
