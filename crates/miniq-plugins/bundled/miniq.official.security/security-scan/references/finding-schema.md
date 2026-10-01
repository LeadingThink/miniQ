# finding 字段定义（miniQ 安全插件通用契约）

本文件是整个 `miniq.official.security` 插件共享的数据契约。所有技能产出或消费 finding 时都遵守这里的字段；`security-scan/scripts/validate_findings.py` 按本文件做机器校验。

## 顶层结构：findings.json

```json
{
  "schema_version": "miniq-security-findings/1",
  "scan_id": "20250101-120000-standard",
  "target": {"path": ".", "revision": "git 提交号或 null", "scope": "扫描范围描述", "diff_base": null},
  "generated_at": "2025-01-01T12:30:00Z",
  "findings": []
}
```

- `schema_version`：固定为 `miniq-security-findings/1`。
- `scan_id`：与 `scan-manifest.json` 中一致。
- `target.diff_base`：差异扫描时填写基线（如 `origin/main`），否则为 `null`。
- `findings`：数组，可以为空；空数组表示"已完整审查，未发现可报告问题"，不代表"未扫描"。

## 单条 finding

| 字段 | 必填 | 类型 / 取值 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | 字符串，形如 `F-001` | 同一次扫描内唯一，按最终排序连续编号 |
| `title` | 是 | 字符串，≤120 字 | 写"谁能对什么做什么"，不要只写漏洞类别 |
| `severity` | 是 | `critical` / `high` / `medium` / `low` / `info` | 最终严重度，按 `security-attack-path` 的严重度矩阵得出 |
| `priority` | 否 | `P0`–`P3` | critical→P0，high→P1，medium→P2，low→P3；info 不填 |
| `confidence` | 是 | `high` / `medium` / `low` | 证据强度，见下文"置信度" |
| `status` | 是 | `validated` / `plausible` / `rejected` / `fixed` / `accepted_risk` | 生命周期状态 |
| `category` | 是 | 字符串 | 具体漏洞类别，如 `SQL 注入`、`IDOR`、`路径穿越` |
| `cwe` | 否 | 字符串数组，形如 `CWE-89` | 无对应时给空数组 |
| `locations` | 是 | 数组，至少 1 项 | 见"位置" |
| `summary` | 是 | 字符串 | 2–4 句，说明问题与后果 |
| `root_cause` | 否 | 字符串 | 缺少了哪个控制、错在哪一层 |
| `attack_path` | 否 | 字符串数组 | 以攻击者视角编号的步骤：入口 → 传播 → 汇点 → 影响 |
| `preconditions` | 否 | 字符串数组 | 攻击者需要的前置条件 |
| `impact` | 否 | `high` / `medium` / `low` / `ignore` / `unknown` | 影响评级 |
| `likelihood` | 否 | `high` / `medium` / `low` / `ignore` / `unknown` | 可能性评级 |
| `severity_override` | 否 | 对象 | `{"severity": "…", "reason": "…", "by": "…"}`，人工覆盖矩阵结果时必须写理由；`severity_calc.py --apply` 不会改动带此字段的条目 |
| `validation` | 否 | 对象 | `{"method": "poc|test|dynamic|static|none", "evidence": "…", "proof_gaps": ["…"]}` |
| `counterevidence` | 否 | 字符串数组 | 已检查过、可能削弱结论的证据 |
| `remediation` | 否 | 字符串 | 最小安全修复建议 |
| `fingerprint` | 否 | 字符串 | 去重指纹，由脚本生成：`类别|主位置路径|汇点行号区间` 的 sha1 前 16 位 |
| `references` | 否 | 字符串数组 | 相关文档、CVE、内部链接 |
| `tracking` | 否 | 对象数组 | 已登记的外部跟踪，如 `{"provider": "github-issue", "url": "…"}` |

### 位置（locations[]）

```json
{"path": "src/api/user.py", "start_line": 42, "end_line": 48, "role": "sink", "note": "直接拼接 SQL"}
```

- `path`：仓库相对路径，禁止写本机绝对路径。
- `start_line` / `end_line`：正整数，`end_line >= start_line`；只知道单行时两者相同。
- `role`：`entry`（入口）/ `source`（攻击者输入）/ `control`（应有或失效的防护）/ `sink`（危险汇点）/ `other`。
- 至少应有一个 `sink` 或 `control` 位置；SARIF 导出以第一个 `sink`（没有则第一项）作为主位置。

## 置信度

- `high`：有复现（PoC、测试、运行日志）或源码证据完整闭合（入口→控制→汇点→影响），无未解决的可达性阻断。
- `medium`：源码证据支持问题存在，但运行时配置、部署暴露或角色可达性仍有缺口。
- `low`：证据薄弱；只有用户明确要求保留"待跟进候选"时才出现在最终报告。

## 状态流转

`plausible`（候选，已有证据但未闭合）→ `validated`（验证通过）或 `rejected`（有反证，写入 `counterevidence`）→ 修复后 `fixed`（由 `security-fix-finding` 的修复验证步骤确认，状态记入 `findings-status.json`）。团队接受风险时标 `accepted_risk` 并在 `references` 或 `remediation` 写明决策依据。

## 写作规则

- 所有字段写可核对的事实：文件、行号、函数名、请求参数；推断必须标明"推断"。
- 不写入完整密钥、令牌、个人信息；需要时只保留前 4 位并打码。
- 同一漏洞的多个独立可利用实例（不同文件/不同汇点）分别成条；同一根因的纯重复调用合并，并在 `locations` 中列全。
