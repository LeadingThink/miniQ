# 只读验证修复指南

本模式回答一个问题：**给定的修复是否真正封闭了 finding 描述的安全边界，同时没有破坏合法行为？** 它与 `security-patch-risk` 不同：后者评估"合并后可能引起什么回归"，这里判断"漏洞是否还在"。

## 1. 只读边界

- 不创建、修改、删除仓库中的任何文件；不应用补丁、不提交、不改工单。
- 需要检出其他修订时，用 `shell_run` 在仓库外建临时工作树：`git worktree add /tmp/verify-<id> <sha>`，结束后 `git worktree remove`；或只用 `git show <sha>:<path>` 读取文件。
- 测试、复现脚本、日志放 `/tmp` 下，不写进仓库。
- 唯一例外：存在扫描目录且用户同意时，可更新 `security-scans/<scan_id>/findings-status.json`，并可新增 `fixes/<ID>/verify-report.md`。

## 2. 输入整理

| 输入 | 获取方式 |
| --- | --- |
| 原始 finding | `file_read` findings.json / 工单 / 报告；缺关键字段时 `ask_user` |
| 修复内容 | `git_diff`、`shell_run`：`git show <sha>`、`git diff <base>..<head>`、`gh pr diff <n>`、补丁文件 |
| 修复前代码 | `git show <base>:<path>` |
| 修复后代码 | 当前检出或 `git show <head>:<path>` |
| 原始复现 | `validation/<ID>/` 下的 PoC、测试或报告里的步骤 |

确认"当前检出确实包含修复"：用 `git merge-base --is-ancestor <fix_sha> HEAD` 或比对文件内容。仓库不匹配时直接 `inconclusive`。

## 3. 评估步骤

1. **重建原漏洞**：写出攻击者输入、前置条件、源到汇路径、被破坏的不变量、必须保留的合法行为。
2. **追踪当前实现**：沿原路径在修复后代码中逐跳检查。代码被移动、重命名、拆分时跟过去；文件消失、函数改名、行号变化都不是修复证据。
3. **原始攻击路径是否被阻断**：找到新增控制的位置，确认它位于所有到达 sink 的路径上，且在最终使用前生效（不是只在某一个入口）。
4. **变体与绕过**：至少检查以下类别中与本漏洞相关的项——编码/规范化变体、替代入口、同 sink 的其他调用者、校验后再变换（TOCTOU、二次解码）、失败即放行的默认分支、配置开关关闭时的行为、不同后端/平台差异。
5. **回归测试质量**：修复是否附带测试？测试是否以原始攻击输入调用真实边界、断言安全属性（拒绝、转义、无数据泄露）？修复前是否会失败（可在临时工作树中对 base 运行验证）？只断言"返回 200"或 mock 掉被测控制的测试不算保护。
6. **合法行为**：至少验证一个正常用例仍然工作；检查是否误伤默认输入、改变错误语义或公共 API。
7. **可运行的检查**：在不改仓库的前提下运行原始复现与相关测试；不能运行时保留精确的静态证据并在 `proof_gaps` 中说明。
8. **残余风险**：列出仍可能存在的风险（未覆盖的同类实例、依赖运行时配置、仅缓解未根除）。

以下都**不是**充分证据：工单已关闭、提交信息写着"fix"、不相关的测试通过、新一轮扫描没报出来、代码行数变少。

## 4. 结论取值

| verdict | 条件 |
| --- | --- |
| `effective` | 原路径被阻断，已检查的变体均被阻断，合法行为保持，且有可执行证据（测试/复现）或完整闭合的静态证据 |
| `partial` | 原始输入被阻断，但存在已证实可行的变体、遗漏的入口或同类实例 |
| `ineffective` | 原始攻击路径在修复后仍然可达（有证据） |
| `inconclusive` | 仓库不匹配、缺原始上下文、关键检查无法运行、合法行为未证实、或其他实质性证据缺口 |

不要通过放宽只读边界、替换成另一个漏洞、或隐藏证据缺口来得出更强的结论。

## 5. JSON 结论对象

每个被验证的 finding 一项，按用户给出的顺序：

```json
{
  "schema_version": "miniq-security-fix-verification/1",
  "verified_at": "2025-01-01T12:00:00Z",
  "repository_revision": "HEAD 提交号",
  "results": [
    {
      "id": "F-001",
      "fix_ref": "commit abc1234 / PR #42 / patch 文件名",
      "verdict": "effective",
      "original_path_blocked": "yes",
      "variants_checked": [
        {"variant": "双重 URL 编码 ..%252f", "result": "blocked", "evidence": "src/files.py:88 在规范化后比较前缀"}
      ],
      "sibling_instances": [
        {"location": "src/export.py:40", "status": "covered", "note": "同样调用 safe_join"}
      ],
      "regression_test": {"present": true, "asserts_security_property": true, "fails_before_fix": "yes", "ref": "tests/test_files.py::test_traversal_rejected"},
      "legitimate_behavior": {"checked": true, "evidence": "tests/test_files.py::test_nested_ok 通过"},
      "commands": [{"cmd": "pytest tests/test_files.py", "result": "pass"}],
      "residual_risk": ["符号链接依赖部署时的挂载选项，未验证"],
      "proof_gaps": [],
      "evidence": "一句话总结最关键的证据"
    }
  ]
}
```

字段取值：

- `verdict`：`effective` / `partial` / `ineffective` / `inconclusive`
- `original_path_blocked`：`yes` / `no` / `unknown`
- `variants_checked[].result`：`blocked` / `bypassed` / `untested`
- `sibling_instances[].status`：`covered` / `still_vulnerable` / `not_applicable` / `unknown`
- `regression_test.fails_before_fix`：`yes` / `no` / `unknown`
- `commands[].result`：`pass` / `fail` / `not_run`

一致性要求：`verdict = effective` 时不得有 `bypassed` 变体或 `still_vulnerable` 同类实例，`original_path_blocked` 必须为 `yes`；有 `bypassed` 或 `still_vulnerable` 时只能是 `partial` 或 `ineffective`。

## 6. 映射到 findings-status.json

| verdict | 写入 status | 其他字段 |
| --- | --- | --- |
| `effective` | `fixed` | `verify_verdict`, `commit`, `evidence`, `tests` |
| `partial` | 保持原状态 | `verify_verdict: partial`，`evidence` 写剩余路径 |
| `ineffective` | 保持原状态 | `verify_verdict: ineffective` |
| `inconclusive` | 保持原状态 | `verify_verdict: inconclusive`，`evidence` 写缺口 |

用 `python3 <本技能目录>/scripts/update_findings_status.py` 写入，脚本会拒绝与上表矛盾的组合。

## 7. Markdown 摘要模板

```markdown
## 修复验证：F-001 <标题>
- 结论：effective（原路径已阻断，3 个变体均被拒绝）
- 修复：commit abc1234
- 关键证据：…
- 回归测试：…（修复前失败 / 修复后通过）
- 同类实例：…
- 残余风险：…
- 证据缺口：无
```
