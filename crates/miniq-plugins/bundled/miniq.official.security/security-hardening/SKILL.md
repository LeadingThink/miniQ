---
name: security-hardening
description: "当用户希望基于已有 findings、威胁模型和代码证据，找出系统性安全薄弱点并形成加固机会组合与设计提案时使用（只读，产出文档）。不要用于修复单个漏洞（转 security-fix-finding）或首次查找漏洞（转 security-scan）。"
version: 1
---

# 安全加固提案

把零散的漏洞记录上升为系统层面的改进：找出**同类问题反复出现**、**缺失集中控制**、**威胁模型与实现不符**、**不安全默认值**、**不变量无法验证**等系统性薄弱点，形成一个经过排序的加固机会组合（portfolio），并为选定的机会撰写可落地的设计提案。本技能只读代码，只写提案文档。

## 触发场景

- "我们反复出现越权问题，从架构上怎么根治？"、"根据这次扫描结果给出加固路线图"、"为 SSRF 防护写一个设计提案"。
- 一次或多次扫描（`security-scan`、`security-deep-scan`）完成后，用于规划下一阶段安全工作。
- 已有威胁模型，想检查其声明的边界是否都有集中的执行点。

不适用 / 应转交：

- 修复某个具体 finding → `security-fix-finding`。
- 还没有任何 findings 或威胁模型 → 先 `security-threat-model` 和/或 `security-scan`；用户坚持时可仅凭代码证据做，但须在组合中写明证据基础薄弱。
- 评估某个已写好的加固 PR 的合并风险 → `security-patch-risk`。
- 制定组织级安全策略文档 → `security-policy`。

## 前置条件

1. 至少具备以下之一，最好兼有：扫描目录 `security-scans/<scan_id>/`（`findings.json`，可含 `findings-status.json`）、威胁模型（仓库内文档或扫描目录下 `threat-model.md`）、用户提供的事故或审计记录。
2. 仓库可读，能用 `file_grep` 做统计性搜索以估计覆盖面。
3. 了解硬约束：上线窗口、能否引入新服务或依赖、语言与框架、合规要求。不清楚且影响方案取舍时，用 `ask_user` 一次性询问（给出默认假设）。

## 分步流程

1. **收集输入**：用 `file_glob` 找 `security-scans/*/findings.json`、`findings-status.json`、`threat-model*.md`、`docs/**/threat*`；用 `file_read` 读取。只把 `status` 为 `validated`、`fixed` 的 finding 当作强证据，`plausible` 为弱证据，`rejected` 排除（规则见 `references/proposal-format.md` 第 2 节，字段含义见 `../security-scan/references/finding-schema.md`）。
2. **归并根因**：按 `category`、`cwe`、`root_cause`、`locations[].role == "control"` 把 findings 分组；每组写一句"缺失或失效的是哪一层的哪个控制"。有现成脚本输出时可先用 `python3 <插件目录>/security-scan/scripts/findings_report.py` 生成概览，但分组结论须人工确认。
3. **在代码中确认系统性**：对每个候选薄弱点，用 `file_grep` 统计同类调用点（例如所有 ORM 查询、所有出站 HTTP 客户端、所有 `innerHTML`、所有文件路径拼接），用 `file_read` 抽查，确认安全职责由谁、在哪一层履行，是否一致。统计命令写入证据表以便复现。模块多时用 `agent_run`（`runInBackground: true`）按薄弱点或模块分派 2–4 个只读子代理，给每个子代理相同的输出格式（证据编号草案、调用点计数、失效模式），各自写到不同的临时文件，再用 `process_output` 收集合并、统一编号。
4. **对照威胁模型**：逐条检查威胁模型声明的信任边界与资产，找出没有集中执行点或执行点可被绕过的边界。
5. **立项与排序**：按 `references/proposal-format.md` 第 2.2 节判定机会，孤立 bug 剔除并建议转 `security-fix-finding`。按现状风险、消除的问题类别广度、代价量级、依赖关系排序，给出每项建议（立即立项 / 下个周期 / 顺手完成 / 观察 / 不做）。
6. **写组合文档**：用 `file_write` 写 `security-scans/hardening-<YYYYMMDD>/portfolio.md`（格式见 proposal-format 第 3 节），证据多时另写 `evidence.md`。
7. **选择要深入的机会**：默认为排名前 1–2 的机会写提案；若用户未指定且机会较多，用 `ask_user` 让用户选择（给出默认选项）。
8. **写单个提案**：对每个选定机会，先写期望不变量，再设计 2–4 个实质不同的方案（含最小改动基线），按 `references/tradeoff-dimensions.md` 做权衡表，然后完成 proposal-format 第 4 节规定的全部 14 个小节，包括前后两张 Mermaid 架构图。用 `file_write` 写到 `proposals/H-xx-<短名>.md`。
9. **自审**：对照 proposal-format 第 5 节自检清单逐项检查；可用 `agent_run` 启动一个独立只读审阅子代理，要求其专门挑战推荐方案（找绕过路径、遗漏入口、低估的迁移代价），把有效意见并入残余风险或开放问题。
10. **交付**：向用户汇报组合要点、提案路径、待决策事项。

## 工具与参数要点

- `file_grep`：统计调用点时限定 `glob`（如 `*.py`）并排除测试与第三方目录；记录模式与结果数作为统计证据。
- `file_read`：抽查时读足上下文（整个函数及其调用方），避免只凭一行下结论。
- `file_write`：只写到加固产出目录；不改动源代码、findings.json 或其他技能的产物。
- `agent_run`：子代理只读，明确输入路径、负责范围、输出文件路径（各不相同）；结束后用 `process_output` 逐个收集，合并时去重并统一证据编号。
- `web_search` / `web_fetch`：仅在需要核实框架或库的安全特性（如某 ORM 是否支持全局作用域过滤）时使用，引用作为"文档"类证据。
- Mermaid：节点 ID 用 ASCII，标签可用中文；前后图节点命名一致。

## 质量检查

- 每个机会至少 2 条证据，且至少 1 条来自代码或已验证 finding；统计证据可复现。
- 薄弱点描述的是"控制缺失或失效的层次"，而不是简单罗列漏洞。
- 不变量可检验，验证计划逐条覆盖；方案实质不同、包含最小改动基线。
- 推荐正面回应了自身 `−−` 维度并写明决策翻转条件。
- 残余风险列出未被方案关闭的 findings 与入口。
- 严重度与状态沿用来源记录，不自行拔高；事实、推断、假设清晰区分。
- 全程未修改源代码。

## 失败回退

- findings 太少、无法证明"反复出现"：改为从代码统计与威胁模型出发；证据仍不足的机会标为"观察"，并给出补证计划（例如对某模块运行 `security-deep-scan`）。
- 威胁模型缺失：在组合中声明，按代码推断主要信任边界并标为假设；建议后续运行 `security-threat-model`。
- 约束未知且影响方案选择：保留多个方案并在开放问题中列出决定因素，不强行推荐。
- 子代理失败或结果不一致：保留成功结果，仅对失败范围重新分派或本地补做，并在局限中说明。
- 仓库过大无法全面统计：限定到与 findings 相关的模块，在"覆盖与局限"写明范围。

## 交付格式

写入 `security-scans/hardening-<YYYYMMDD>/`：

- `portfolio.md`：结论速览、证据基础、约束、机会清单表、排序理由、待决策事项。
- `evidence.md`（可选）：证据编号总表。
- `proposals/H-xx-<短名>.md`：决策、执行建议、证据、现有设计与失效模式、期望不变量、约束与非目标、前后架构、多方案对比、推荐、残余风险、迁移与发布、验证计划、实施工作包、开放问题。

对话中的回复：用 3–6 条要点概述最重要的机会与建议、列出文件路径、列出需要用户决策的事项。后续可衔接 `security-fix-finding`（逐个修复）、`security-track-findings`（登记工作包）、`security-patch-risk`（评估实施 PR）。
