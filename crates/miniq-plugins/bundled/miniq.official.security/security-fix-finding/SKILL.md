---
name: security-fix-finding
displayName: 修复并验证安全 finding
description: "当用户明确要求修复某个已验证或疑似的安全 finding，或要求只读核实某个已有修复（提交/PR/diff）是否真正堵住漏洞时使用。不要用于全仓扫描、差异扫描、候选验证或一般代码评审；补丁回归风险评估转 security-patch-risk。"
version: 1
---

# 修复并验证安全 finding

本技能有两种互斥模式，开始前先判定用哪一种并在回复中说明：

- **修复模式**：用户要你改代码。目标是把一个 finding 变成最小、完整、可验证的补丁；如果证据表明当前代码已经安全，就证明它并且不改代码。
- **只读验证修复模式**：用户已有修复（提交、PR、diff、补丁文件或当前检出），要你判断它是否真正修复了 finding。此模式禁止修改仓库任何文件（`findings-status.json` 除外，且仅在存在扫描目录并经用户同意时写入）。

判断修复质量的优先级从高到低：①当前状态分类正确（有漏洞 / 已安全 / 未证实）→ ②补丁完整封闭被破坏的安全边界 → ③合法行为与兼容性不变 → ④相关检查通过 → ⑤符合仓库惯例 → ⑥改动范围最小。不得为了后面的目标牺牲前面的目标；"最小"指满足前五条的最小仓库原生改动，而不是行数最少。

## 触发场景

- "把 F-003 修掉"、"修这个 SQL 注入并加回归测试"、"按扫描报告修复高危项"。
- "帮我看看这个 PR 是否真的修好了 CVE/工单里的越权问题"、"验证提交 abc123 是否修复了 F-002"。
- 上游输入可以是 `security-scans/<scan_id>/findings.json` 中的条目、`security-triage-finding` 分诊结论、外部报告或用户口述（需补全为 finding 字段，见 `../security-scan/references/finding-schema.md`）。

不适用 / 应转交：

- 还不知道有没有漏洞、需要找问题 → `security-scan`、`security-diff-scan` 或轻量的 `security-review`。
- 候选尚未验证、需要 PoC 证明可利用性 → `security-validation`；严重度有争议 → `security-attack-path`。
- 只想知道补丁合并后会不会引起回归、能否自动合并 → `security-patch-risk`（本技能验证"是否修好"，它评估"合并风险"，两者可串联）。
- 同类问题反复出现、需要架构级方案 → `security-hardening`；本技能只修当前 finding，不做重构。
- 登记工单 → `security-track-findings`；写披露报告 → `security-writeup`。

## 前置条件

1. 有明确的 finding：至少包含标题、类别、位置（文件与行号）和攻击路径描述；缺失时用 `ask_user` 补齐，或先交给 `security-triage-finding`。
2. 仓库可读；修复模式需要写权限。用 `git_status` 确认工作区，记录用户已有未提交改动，绝不覆盖或回滚它们。
3. 验证模式需要能定位修复：提交号、分支、PR 链接或 diff 文件。PR 需要 `shell_run` 调 `git fetch` 或 `gh pr diff`（需用户已登录，不代为处理凭据）。
4. 运行测试或 PoC 前确认只在本地/自有环境执行，不对线上系统发起攻击流量。

## 分步流程

### A. 修复模式

1. **读取 finding 与上下文**：`file_read` 读取 `findings.json`、`validation/<ID>/notes.md`、`attack-paths/<ID>.md`（若有）；`file_read` 打开 sink 及其直接调用方、就近的校验/鉴权辅助函数、现有测试。
2. **修前调查**（详见 `references/patch-contract.md` 的"修前调查清单"）：写下攻击者输入、源到汇的具体路径、被破坏的安全不变量、必须保留的合法行为。用 `file_grep` 找同类实例：同一 sink 的其他调用者、同一辅助函数的复制品、别名/编码变体、其他入口（HTTP、CLI、消息队列、定时任务）。较大仓库可用 `agent_run`（`runInBackground: true`）派一个只读调查子代理独立追踪路径与兄弟实例，之后用 `process_output` 收集并与自己的结论对账。
3. **复现或确认**：能跑就用 `shell_run` 跑最小复现（已有 PoC 或单元测试），同时跑一个合法对照输入。若证据显示路径已安全，结论为 `no_change`，不做投机性修改。
4. **先写失败的回归测试**：用 `file_write`/`file_edit` 在仓库既有测试目录按其框架新增测试，覆盖原始攻击输入、至少一个变体、一个合法对照。用 `shell_run` 运行并确认它**在修复前失败**（记录命令与输出）。无法写自动化测试时说明原因并保留手工复现步骤。
5. **实施最小修复**：用 `file_edit` 在共享的执行边界（而不是某个调用点）修复根因，优先复用仓库已有的安全 API 与辅助函数。模式选择参考 `references/remediation-patterns.md`。同类实例若共用同一边界应一并覆盖；属于独立 finding 的，记入"未处理的同类实例"而非顺手修改。
6. **补丁自审**：检查被改函数的每个直接调用方、每个改动条件的两个分支；尝试绕过（编码、大小写、路径规范化、二次解析、竞争窗口、替代入口）；检查是否误伤普通/默认输入。发现问题即修正。条件允许时用 `agent_run` 起一个全新只读审查子代理，只给它 finding 与 `git_diff` 输出（不给你的理由与测试结论），让它报告具体绕过或回归；把它的结论当假设，用源码或执行确认后再处理，只做一轮。
7. **按序验证**：`git_diff` 检查最终改动 → `shell_run` 跑语法/类型/构建检查 → 重跑回归测试（现在应通过）与原始复现（应不再成立）→ 重跑合法对照与就近既有测试套件。
8. **记录结果**：有扫描目录时写 `security-scans/<scan_id>/fixes/<ID>/fix-report.md`，并用 `python3 <本技能目录>/scripts/update_findings_status.py` 更新 `findings-status.json`（不改写 `findings.json`）。

### B. 只读验证修复模式

按 `references/verify-fix-guide.md` 执行，要点：

1. 用 `git_diff`/`shell_run`（`git show <commit>`、`git diff <base>..<head>`）取得修复内容；`file_read` 取得原始 finding。
2. 在当前代码中重建原攻击路径；代码被移动或重命名时跟踪过去，"原行消失"不等于修复。
3. 逐项判断：原路径是否被阻断、变体与绕过、同类实例、回归测试是否真正断言安全属性、合法行为是否保持、残余风险。
4. 只在不改仓库的前提下运行测试/复现（临时文件放仓库外，如 `/tmp`）。
5. 输出结论契约（`effective` / `partial` / `ineffective` / `inconclusive`），经用户同意后更新 `findings-status.json`。

## 工具与参数要点

- `file_grep`：找同类实例时同时搜 sink 名、辅助函数名和危险模式（如 `execute\(.*\+`、`shell=True`、`innerHTML`），不要只搜 finding 中的那一行。
- `file_edit`：一次只改一个关注点，便于 `git_diff` 审阅；不改无关格式。
- `shell_run`：测试命令优先用仓库自带（`npm test -- <file>`、`pytest path::case`、`cargo test name`）；记录完整命令与退出码。
- `agent_run`：调查与审查子代理都设为只读，给明确输入（finding、仓库根、范围、diff），要求返回"事实 / 推断 / 未决问题"三栏。
- 状态脚本：`python3 <本技能目录>/scripts/update_findings_status.py --status-file <scan_dir>/findings-status.json --id F-001 --status fixed --evidence "…" --fix-outcome fixed --commit <sha> [--findings <scan_dir>/findings.json]`；验证模式用 `--verify-verdict effective|partial|ineffective|inconclusive`，回归测试用可重复的 `--test <测试引用>`；矛盾组合（如 partial 却写 fixed）会以退出码 1 拒绝；`--help` 查看全部参数。

## 质量检查

- 回归测试在修复前失败、修复后通过，且断言的是安全属性（被拒绝/被转义/无越权数据），而非仅"不报错"。
- 原始复现与至少一个变体均被阻断；合法对照与既有测试全部通过。
- 未削弱其他控制：没有放宽鉴权、租户隔离、输入校验、沙箱、日志、TLS 校验，没有为通过测试而跳过或删除测试。
- 公共 API、错误语义、默认行为保持兼容；有不兼容处已写明并征得同意。
- 所有同类实例已列出：已修 / 共用边界已覆盖 / 未修（附原因）。
- 结论中没有把"代码评审看起来没问题"当作"已验证"。

## 失败回退

- 缺少复现环境或依赖：结论 `blocked`，写明卡在哪条命令、缺什么证据；不要报 `fixed`。
- 修复需要产品决策（例如收紧会破坏既有客户端）：用 `ask_user` 给出 2-3 个选项及影响，未决时结论 `blocked`。
- 只能修一部分入口：结论 `partial`，列出仍可达的路径与后续计划。
- 修复后原复现仍成立或测试无法通过：结论 `not_fixed`，保留测试与分析，回滚自己引入的无效改动（不动用户改动）。
- 验证模式证据不足（仓库不匹配、缺原始上下文、测试无法运行）：结论 `inconclusive`，不得推断更强结论。

## 交付格式

修复模式最终回复（及 `fix-report.md`）包含：

- `outcome`：`fixed` / `partial` / `not_fixed` / `blocked` / `no_change`（含义见 `references/patch-contract.md`）
- 漏洞路径、安全不变量、必须保留的合法行为
- 所选修复策略及为何是最窄的完整方案；同类实例清单
- 改动文件、新增测试
- 按验证顺序分组的命令与结果（通过 / 失败 / 未知）
- 如何证明原问题不再复现、合法行为未受影响
- 残余风险与跳过的验证

验证模式输出 Markdown 摘要 + `references/verify-fix-guide.md` 定义的 JSON 结论对象。两种模式都在有扫描目录时更新 `findings-status.json`。
