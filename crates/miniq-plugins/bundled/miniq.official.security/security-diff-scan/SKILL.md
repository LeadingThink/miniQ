---
name: security-diff-scan
description: "对 PR、提交、分支对比或未提交改动做安全复审：先确定差异范围与受影响上下文，再只报告由本次改动引入或暴露的问题。全仓扫描请用 security-scan，修复补丁的回归风险评估请用 security-patch-risk。"
version: 1
---

# 差异安全复审（security-diff-scan）

以"这次改动让系统变得更不安全了吗"为唯一问题。范围是差异，但判断必须结合差异之外的调用方、配置和鉴权层；报告只收录**由本次改动引入、放大或暴露**的问题，既有问题另列。

## 触发场景

- "帮我审一下这个 PR / 这个提交 / 我这个分支和 main 的差异 / 我还没提交的改动有没有安全问题"。
- 合并前的安全门禁、发版前对比两个标签。

不适用（转交）：

- 全仓或目录级审计 → `security-scan` / `security-deep-scan`。
- 评估一个**安全修复补丁**是否修对、有没有回归 → `security-fix-finding` 的验证修复模式或 `security-patch-risk`。
- 差异里只有依赖版本变化、想看供应链风险 → 仍用本技能，但重点走"依赖变更"检查项。

## 前置条件

- 本地有 git 仓库，且能拿到基线：PR 需要 `gh` 已登录或用户提供 diff 文件；远程分支需要已 `git fetch`。
- 已读 `../security-scan/references/finding-schema.md` 与 `../security-scan/references/scan-artifacts.md`。
- 不切换用户当前分支、不改动工作区；需要 PR 代码时用 `git worktree add` 到临时目录或只读取 diff。

## 分步流程

### 第一步：设置（确定范围与上下文）

1. **识别差异来源**（shell_run），规则见 `references/diff-sources.md`：
   - PR：`gh pr view <n> --json baseRefName,headRefName,headRefOid,files,title,body` 与 `gh pr diff <n>`。
   - 提交：`git show --stat <sha>`，`git diff <sha>^!`。
   - 分支/标签对比：`git diff --merge-base <base> <head>`（旧版 git 用 `<base>...<head>`）。
   - 未提交改动：`git diff HEAD`，加上 `git ls-files --others --exclude-standard` 列出的新文件。
   - 来源不明确时用 `ask_user` 让用户选择，默认"当前分支相对默认分支 + 未提交改动"。
2. **建立扫描目录**：`scan_id` 为 `YYYYMMDD-HHMMSS-diff`，manifest 的 `mode` 为 `diff`，`target.diff_base` 写基线引用与解析后的 SHA。
3. **生成范围清单**：

```bash
python3 <插件目录>/security-scan/scripts/list_scope_files.py <仓库根> --changed-since <base> \
  -o security-scans/<scan_id>/inventory.json
```

   未提交改动或 PR diff 文件无法用 `--changed-since` 时，手工写 inventory（同一 schema，`source` 写 `diff`）。
4. **差异分级**：把改动文件分为 ① 安全相关（鉴权、会话、输入处理、序列化、文件/进程/网络、加密、权限配置、CI、依赖清单）② 行为相关 ③ 无关（纯文档、格式化、测试夹具）。① 必须逐行审，② 看数据流是否受影响，③ 只抽查。
5. **扩展上下文**：对 ① 中每个改动的函数，用 `file_grep` 找调用方与被调用方，至少向外一层；记录需要额外阅读的非差异文件（在 coverage 中 `note: context`）。
6. **差异威胁模型**：简要写 `threat-model.md`——本次改动新增/修改了哪些入口、信任边界、权限、数据流；若仓库已有威胁模型，只写增量。

### 第二步：复审（发现 → 验证 → 定级 → 报告）

1. **发现**：按 `references/diff-review-checklist.md` 逐项检查，并参考 `security-finding-discovery` 的门槛。每个候选必须回答"它与本次改动的关系"：`introduced`（新引入）、`exposed`（既有缺陷因本次改动变得可达/更严重）、`preexisting`（与改动无关但在上下文中看到）。写入候选的 `reasoning` 开头，例如 `[introduced] …`。
2. **去重校验**：`dedupe_candidates.py … --renumber -o candidates.json`，`validate_findings.py candidates.json`。
3. **验证**：按 `security-validation` 执行。能在 PR 分支 worktree 里跑测试或 PoC 时优先动态验证；并尝试在基线上复现，用来确认"引入"关系（基线不可复现而改动后可复现 = introduced）。
4. **定级**：按 `security-attack-path` 执行。`preexisting` 问题不计入本次门禁结论。
5. **报告**：生成 `findings.json`（`target.diff_base` 必填）、`report.md`，报告分三节：本次引入、本次暴露、既有问题（附录）。需要时导出 SARIF 供 PR 注释使用。
6. **门禁结论**：给出 `阻止合并` / `修复后合并` / `可以合并` 之一，规则：有 introduced/exposed 的 high 及以上 → 阻止合并；只有 medium → 修复后合并（或用户接受风险）；其余 → 可以合并。

## 工具与参数要点

- `gh pr diff <n> --patch` 可取带提交信息的补丁；大 PR 用 `gh pr view <n> --json files` 先看文件列表再分批阅读。
- `git diff -U10` 提供更多上下文；`git log -p --follow <file>` 查看敏感文件的近期历史，判断是否反复修改同一安全控制。
- 删除的代码同样重要：被删除的校验、鉴权装饰器、转义调用、测试用例都可能是回退，用 `git diff --diff-filter=D` 与 `-` 行专门检查。
- 重命名/移动文件用 `git diff -M` 避免误判为新增。
- 在 PR 上发表评论属于写外部系统，需要用户同意后再用 `gh pr review` / `gh pr comment`。

## 质量检查

- [ ] 差异来源、基线 SHA、头部 SHA 均已记录在 manifest。
- [ ] 所有安全相关改动文件在 coverage 中为 `reviewed`，并记录了读过的上下文文件。
- [ ] 每条 finding 标明 introduced/exposed/preexisting，并有依据（最好有基线对比）。
- [ ] 被删除的安全控制已单独检查。
- [ ] 门禁结论与 findings 严重度一致；`validate_findings.py --strict` 通过。

## 失败回退

- 拿不到 PR（无 `gh` 或未登录）：请用户提供 `git fetch origin pull/<n>/head:pr-<n>` 权限或直接粘贴/保存 diff 文件，按"diff 文件"模式审查，并注明无法运行代码。
- 基线不可用（浅克隆）：`git fetch --deepen` 或 `--unshallow` 前先征得同意；否则只基于 diff 静态审查，引入关系标注为"推断"。
- 差异过大（>3000 行或 >100 文件）：先只审安全相关分级，其余标 `skipped` 并建议拆分 PR 或改用 `security-scan`。
- 无法判断是否由改动引入：标 `exposed` 或 `preexisting` 并在 proof_gaps 说明，不强行归入 introduced。

## 交付格式

聊天中给出：

1. 差异来源（PR 号/提交/分支）、基线与头部 SHA、改动文件数与安全相关文件数。
2. **门禁结论**（一句话 + 理由）。
3. 本次引入/暴露的问题列表：编号、严重度、标题、`文件:行`、一句话修复建议。
4. 既有问题数量（详情见附录）与审查局限。

完整产物在 `security-scans/<scan_id>/`。用户同意后可把 findings 作为 PR 审查评论逐行发布（每条评论附编号与修复建议）。
