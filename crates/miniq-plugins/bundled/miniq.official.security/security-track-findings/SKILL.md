---
name: security-track-findings
displayName: 安全 finding 工单登记与跟踪
description: "把已确认的安全 finding 登记到 GitHub Issues、GitHub 私有草稿安全公告、Jira 或本地 CSV，按指纹去重并维护 tracking.json 状态同步。任何外部写入均先预览再确认。找漏洞或写报告不用本技能。"
version: 1
---

# 安全 finding 工单登记与跟踪

目标：把 `security-scan` 等技能产出的 finding（`miniq-security-findings/1`，见 `../security-scan/references/finding-schema.md`）变成可跟踪的工单，并保证三件事：**不重复**（指纹去重）、**不泄露**（公开渠道不出现利用细节）、**不擅自写**（每次外部写入都先展示精确载荷并得到用户确认）。本技能不重新判断漏洞真伪，也不写详细报告。

## 触发场景

- 扫描/验证完成后，把 validated（可选 plausible）finding 开成 GitHub Issue、Jira 问题或导出 CSV 给别的系统导入。
- 为开源包中已确认的漏洞创建 **私有草稿** GitHub Security Advisory（GHSA）。
- 再次扫描后同步：哪些工单对应的 finding 已修复、哪些是新增、哪些工单已被人工关闭。

不适用 / 应转交：

- 还没有 finding 或不确定真伪 → `security-scan` / `security-validation` / `security-triage-finding`。
- 需要完整披露报告正文 → 先用 `security-writeup`，再把报告作为 GHSA 描述来源。
- 修复代码 → `security-fix-finding`；发布/关闭公告、申请 CVE、修改已有公告 → 不在本技能范围，告诉用户在平台上手工完成。
- 密钥泄露类 finding：先轮换密钥（`security-secret-scan` 的流程），工单里只写打码后的值。

## 前置条件

1. 合法的 findings 文件：先运行 `python3 <插件目录>/security-scan/scripts/validate_findings.py <findings.json>`（如存在），失败则先修数据。
2. 目标与身份明确：GitHub 需 `owner/repo` 与已登录的 `gh`（或 token）；Jira 需站点 URL、项目 key、认证方式。凭证由用户环境提供，本技能不索要、不记录、不回显凭证。
3. 可见性已确认：目标仓库/项目是否公开（见第 3 步）。
4. 映射文件位置：默认 `security-scans/tracking.json`，格式见 `references/tracking-map.md`。

## 分步流程

1. **读取与筛选**（`file_read`、`shell_run`）。读 findings，默认只登记 `status` 为 validated / plausible 的项；rejected、fixed、accepted_risk 不开新单。向用户确认范围（全部 / 指定 id / 最低严重度）。GHSA 只接受 validated，且一次只建一个公告。
2. **选定目标**（`ask_user`）。用户未指定时询问：github-issue / ghsa / jira / csv。按目标阅读对应参考：`references/github-issues.md`、`references/github-security-advisory.md`、`references/jira.md`。
3. **确认可见性**（`shell_run` + `ask_user`）。GitHub 用 `gh repo view <owner>/<repo> --json visibility,isPrivate`；Jira 询问是否有安全级别（security level）。公开仓库的 Issue 只能用公开安全版本（`--visibility public`，默认值）；即使如此也要 `ask_user` 确认“要在公开仓库披露这个问题的存在吗”，并建议高危项改走 GHSA 私有草稿。
4. **生成载荷**（`shell_run`）。
   ```
   python3 <本技能目录>/scripts/build_tickets.py <findings.json> --target <github-issue|ghsa|jira|csv> \
     --tracking security-scans/tracking.json -o security-scans/tickets-<目标>.json
   ```
   脚本只生成文件、不发送任何请求；为每条加指纹标签 `miniq-fp:<16位>`，跳过 tracking.json 中同平台已登记的指纹，并对常见凭证形态打码。退出码 1 表示数据不合格（未写文件），按错误信息修正。
5. **平台侧去重**（`shell_run` / `http_request`，只读）。tracking.json 可能不全，对每条载荷按 `dedupe_query` 在平台搜索指纹（也搜标题关键词以发现人工开过的单）。命中则从待写列表移除，并把已有工单补登到 tracking.json。
6. **预览并确认**（`ask_user`）。对将要执行的每一次写入展示：平台与精确目标（`owner/repo`、Jira 站点与项目）、方法与端点、标题、正文全文、标签/优先级、可见性、对应 finding 与指纹、跳过项及原因。正文较长时写到文件并给出路径，摘要显示在对话中。用户确认的是这一批精确内容；内容有任何改动都要重新确认。
7. **发送前复核**（`shell_run`）。确认后、发送前再做一次指纹搜索，防止确认期间别人已开单；确认目标仓库/项目未变。
8. **串行写入并验证**（`shell_run` 调用 `gh api` / `curl`，或 `http_request`）。逐条发送，不并发；每条成功后立即回读（GET）确认标题、标签、可见性正确，再写入 tracking.json（`file_edit`）。任一条失败就停下，报告已成功与未执行的条目，不自动重试写操作（重试前先搜索确认上一次是否其实已创建）。
9. **状态同步**（按需）。按 `references/tracking-map.md` 的同步规则，对比最新 findings 与平台工单状态，生成“建议操作”列表（评论、关闭、重开），同样先预览再确认。只更新 tracking.json 的本地操作不需要确认。

## 工具与参数要点

- `build_tickets.py` 常用参数：`--ids F-001,F-003`；`--status validated`；`--min-severity medium`；`--label team-payments`（可重复）；`--visibility public|private`（仅 github-issue，public 省略行号、攻击路径、验证证据，标题使用 `public_title` 或类别，概要优先用 `public_summary`）；`--ecosystem/--package/--vulnerable-range/--patched`（GHSA，或在 finding 里加 `advisory` 对象）；`--jira-project SEC --jira-format adf|text --jira-priority-map P0=Blocker --jira-security-level <名称>`。`python3 <本技能目录>/scripts/build_tickets.py --help` 查看全部。
- 输出 JSON 每条含 `method`、`endpoint`（含 `{owner}/{repo}` 占位）、`payload`、`dedupe_query`、`fingerprint`、`finding_id`。发送时只替换占位，不要改 payload——改了就重新预览。
- GitHub 写入优先 `gh api --method POST <endpoint> --input <单条payload.json>`（用 `python3 -c` 从输出文件抽取单条），避免在命令行拼接正文。
- Jira 写入用 `http_request` 或 `curl`，认证从环境变量读取；命令与输出中不出现 token。
- 即使是私有工单也要确认不含完整密钥（只保留前 4 位）。脚本的打码只覆盖常见格式，预览时仍要人工看一遍。
- 网页端操作（无 API 权限时）可用 `browser_automation`，但同样先预览、确认，并在提交前核对表单内容。

## 质量检查

- 每条工单恰好对应一个指纹；同指纹多个 finding 合并为一单。
- 公开渠道内容不含行号级定位、载荷、请求样例、绕过方法、内部主机名、凭证。
- GHSA：生态、包名、受影响范围都有证据（不是从扫描提交推测）；`patched_versions` 仅在该版本已发布时填写；severity 与 cvss_vector_string 只给一个。
- Jira：优先级名称在目标项目中存在；必填自定义字段已通过 createmeta 确认。
- 写入后均有回读验证；tracking.json 与平台实际状态一致，写回 findings 的 `tracking` 字段（如需）。
- 没有在用户确认之外发生任何创建、评论、关闭、标签修改。

## 失败回退

- `gh`/Jira 未认证或权限不足：停止，告诉用户需要的权限（GHSA 需要仓库管理员或安全管理员），改为生成 CSV 或载荷文件供人工提交。
- 422/400 字段错误：读取错误体，调整字段后重新预览；不要在未确认的情况下去掉字段重发。
- 网络中断或超时：先按指纹搜索确认是否已创建，再决定是否重发。
- 限流：暂停并报告进度，不要快速重试。
- 仓库未启用私有漏洞报告或不是包的源仓库：GHSA 不适用，改走私有 Jira 或私有仓库 Issue。
- tracking.json 损坏：备份后按平台搜索结果重建（见 `references/tracking-map.md`）。

## 交付格式

- 文件：`security-scans/tickets-<目标>.json` 或 `.csv`（载荷预览）、更新后的 `security-scans/tracking.json`。
- 对话回复表格：finding id | 指纹 | 平台 | 结果（已创建/已存在/跳过/失败/未执行）| 链接或原因。
- 明确列出：本次实际执行的外部写入数量、待用户手工完成的操作（如发布 GHSA、申请 CVE）。
