# 分诊结论契约（triage.json）

本文件定义 `security-triage-finding` 的机器可读输出。`scripts/triage_rank.py` 按这里的规则校验与排序。位置、严重度、优先级、置信度的取值与共享契约 `../../security-scan/references/finding-schema.md` 保持一致，这样 `valid` 项可以直接转换成 finding 交给后续技能。

## 1. 顶层结构

```json
{
  "schema_version": "miniq-security-triage/1",
  "generated_at": "2025-03-02T08:00:00Z",
  "target": {"path": ".", "revision": "9f2c1e7", "note": "报告针对 v2.4.1，已用 git show v2.4.1:<path> 核对"},
  "intake": {"sources": ["github_code_scanning", "bug_bounty"], "query": "state=open", "total": 3, "unread": []},
  "results": []
}
```

- `schema_version`：固定 `miniq-security-triage/1`。
- `target.revision`：分诊时实际阅读的代码版本；未知写 `null` 并在 `note` 说明。
- `intake.unread`：读取失败、未进入判定的来源编号清单，防止“静默漏条”。
- `results`：每条输入报告一项，**保持输入顺序**；优先顺序用 `rank` 表达，不重排数组。

## 2. 单条结论字段

| 字段 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | `T-001` 起连续 | 本次分诊内唯一 |
| `title` | 是 | 字符串 | 用自己的话概括声明：谁能对什么做什么 |
| `source` | 是 | 对象 | 见第 3 节 |
| `claim` | 是 | 对象 | 报告人的原始声明（拆解后），见第 4 节 |
| `verdict` | 是 | `valid` / `invalid` / `duplicate` / `needs_info` / `out_of_scope` | 见第 5 节 |
| `confidence` | 是 | `high` / `medium` / `low` | 对**判定本身**的把握 |
| `severity` | 条件 | `critical` / `high` / `medium` / `low` / `info` / `null` | `valid` 必填非空；`needs_info` 可填“若成立”的预估；其余为 `null` |
| `priority` | 否 | `P0`–`P3` / `null` | critical→P0，high→P1，medium→P2，low→P3 |
| `impact` / `likelihood` | 否 | `high` / `medium` / `low` / `unknown` | 交给 `severity_calc.py` 的输入 |
| `category` | 否 | 字符串 | 如 `IDOR`、`SSRF` |
| `cwe` | 否 | 字符串数组 | 只写有把握的映射 |
| `duplicate_of` | 条件 | 字符串 | `duplicate` 必填：本批 `T-xxx`、已有 finding `F-xxx`、工单号或 CVE |
| `locations` | 条件 | 数组 | 同 finding-schema 的位置格式；`valid` 至少 1 项 |
| `boundary` | 是 | 对象 | 见第 6 节；未知字段写 `unknown` 而不是省略 |
| `rationale` | 是 | 字符串 | 1–3 句理由 |
| `evidence` | 是 | 字符串数组 | 支持判定的事实，带路径与行号 |
| `counterevidence` | 否 | 字符串数组 | 检查过的、指向相反结论的事实 |
| `proof_gaps` | 条件 | 字符串数组 | `needs_info` 必填：哪个未知事实会改变结论 |
| `rank_queue` / `rank` | 脚本生成 | `valid` / `needs_info` / `null`；正整数 / `null` | 见第 7 节 |
| `next_step` | 是 | 字符串 | 如“转 security-fix-finding”“请报告人提供请求样例” |
| `owner_hint` | 否 | 字符串 | 仅 `valid`，来自 CODEOWNERS 等明确证据；不确定就不写 |
| `fix_handoff` | 否 | 对象 | 仅 `valid`，见第 8 节 |
| `reply_draft` | 否 | 字符串 | 给报告人的回复草稿，不含内部细节 |

## 3. source

```json
{"type": "bug_bounty", "id": "H1-1834021", "url": "https://hackerone.com/reports/1834021", "reporter": "r***r", "reported_at": "2025-02-27", "reported_severity": "High (CVSS 8.1)", "query": null}
```

`type` 取值：`bug_bounty`、`ticket`（Jira/Linear 等工单）、`scanner`（本地扫描器输出）、`github_code_scanning`、`dependabot`、`github_advisory`、`github_issue`、`cve`、`miniq_finding`、`freeform`。除 `type` 外均可为 `null`。

## 4. claim

```json
{
  "component": "订单导出接口",
  "entry": "GET /api/orders/{id}/export",
  "attacker_input": "路径参数 id",
  "sink_or_control": "缺少订单归属校验",
  "preconditions": ["拥有任意普通账号"],
  "claimed_impact": "读取任意用户订单",
  "affected_versions": "unknown",
  "poc_provided": true
}
```

这里只记录报告人说了什么。我们验证后的结论写在 `verdict` / `evidence` / `locations` 中。两者不一致（例如影响被夸大）时在 `rationale` 说明。

## 5. 判定规则

判定针对**完整的声明链**：攻击者 → 输入 → 变换 → 控制 → 汇点/受保护操作 → 后果。附近的另一个弱点不能拿来替代。

### valid

以下全部有正面证据：

1. 声称的（或等价的）缺陷代码在目标版本中存在；
2. 发布/部署/文档化的路径在受支持的配置下能到达它；
3. 声称的攻击者能在关键控制之前影响输入；
4. 沿途的转义、校验、异常处理按**实际语义**评估后，后果仍然可能；
5. 路径跨越了项目承认的安全边界。

“可控输入 + 危险函数”不够；要说明数据如何变成可执行/可越权/可泄露的。报告人附带 PoC 但我们未运行时，结论仍是静态的，在 `evidence` 写“PoC 已阅读，未运行”。

### invalid

必须有正面反证，例如：组件/功能/版本不存在；所有受支持的调用方都使条件不可达；控制在所有路径上先于汇点生效且后续解析不会重新引入危险；失败路径在后果发生前终止；输入来源被证明是同权限可信输入。

不能作为反证的：“常见调用方有校验”“调用了名为 sanitize 的函数”“该选项默认关闭”“需要登录”——除非证明它们覆盖了全部受支持路径并阻断了声称的后果。

### duplicate

与已知项**同一根因且同一汇点/控制**。先对已知项作出判定再标重复；被重复的对象若本身是无效的，两条都按无效处理。同类别不同入口的是两个问题。

### needs_info

输入来源、控制语义、运行配置、路径覆盖、边界政策任一项静态无法确定。`proof_gaps` 写出最小的未决事实，如“生产环境是否启用 `ALLOW_LEGACY_TOKENS`”。不要用它来逃避责任——能静态闭合的就闭合。

### out_of_scope

问题可能属实，但不在本项目的安全承诺内：`SECURITY.md` 明确排除的类别（如自 XSS、缺少安全头、需要物理访问）；仅出现在测试/示例/开发工具且不随产品发布；属于第三方服务应转报上游；已停止支持的版本。`rationale` 必须引用依据。

### 置信度

- `high`：判定所需的每一环都有代码或文档证据。
- `medium`：主干成立，但有一环依赖合理推断（写在 `proof_gaps`）。
- `low`：多环依赖推断。`valid` + `low` 是危险信号，考虑改为 `needs_info`。

## 6. boundary

```json
{
  "surface": "service",
  "input_trust": "untrusted",
  "policy_basis": "SECURITY.md 说明多租户隔离在范围内",
  "crosses_boundary": "yes"
}
```

- `surface`：`service`（线上服务/路由）、`library`（对外库 API）、`cli`、`desktop`、`build`（构建/CI）、`dependency`、`example`、`test`、`docs`、`generated`、`unknown`。
- `input_trust`：`untrusted`（匿名或其他租户）、`low_privilege`（普通登录用户）、`operator`（运维/管理员配置）、`same_privilege`、`unknown`。不要只凭“这是配置项/命令行参数”就判为可信：要看谁能写入或间接影响它（下载的文件、共享存储、数据库记录、更低权限的管理员等）。
- `crosses_boundary`：`yes` / `no` / `unknown`。`valid` 必须为 `yes`；`unknown` 应导向 `needs_info`。

## 7. 排序与 rank

- 只有 `valid` 与 `needs_info` 进入排序队列，各自从 1 连续编号；其他判定 `rank_queue`/`rank` 为 `null`。
- 队列内按严重度（critical 最前，`null` 最后）→ 置信度（high 最前）→ 可利用性（`likelihood`）→ 输入顺序。
- 排序表整体顺序：`valid` → `needs_info` → `duplicate` → `out_of_scope` → `invalid`。
- 需要人工调整顺序时，改 `severity`/`likelihood` 并写理由，不要手工改 `rank`。

## 8. fix_handoff（仅 valid）

```json
{
  "input": "已登录用户可控的路径参数 id",
  "sink": "src/orders/export.py:export_order 直接按 id 查询",
  "invariant": "只有订单所属账号或管理员可导出",
  "fix_boundary": "在服务层 get_order_for_user 统一校验归属，而不是在单个路由里补丁",
  "open_gaps": ["批量导出接口是否复用同一函数尚未确认"]
}
```

## 9. 完整示例

```json
{
  "schema_version": "miniq-security-triage/1",
  "generated_at": "2025-03-02T08:00:00Z",
  "target": {"path": ".", "revision": "9f2c1e7", "note": null},
  "intake": {"sources": ["bug_bounty", "github_code_scanning"], "query": null, "total": 3, "unread": []},
  "results": [
    {
      "id": "T-001",
      "title": "普通用户可通过修改订单号导出他人订单",
      "source": {"type": "bug_bounty", "id": "H1-1834021", "url": null, "reporter": "r***r", "reported_at": "2025-02-27", "reported_severity": "High", "query": null},
      "claim": {"component": "订单导出", "entry": "GET /api/orders/{id}/export", "attacker_input": "id", "sink_or_control": "缺少归属校验", "preconditions": ["普通账号"], "claimed_impact": "读取任意订单", "affected_versions": "unknown", "poc_provided": true},
      "verdict": "valid",
      "confidence": "high",
      "severity": "high",
      "priority": "P1",
      "impact": "high",
      "likelihood": "high",
      "category": "IDOR",
      "cwe": ["CWE-639"],
      "duplicate_of": null,
      "locations": [{"path": "src/orders/export.py", "start_line": 31, "end_line": 38, "role": "control", "note": "只校验登录态"}],
      "boundary": {"surface": "service", "input_trust": "low_privilege", "policy_basis": "多租户隔离属于核心安全承诺", "crosses_boundary": "yes"},
      "rationale": "路由只要求登录，查询按 id 直取，未比较 owner_id。",
      "evidence": ["src/orders/export.py:31-38 仅有 login_required", "src/orders/repo.py:12 get_by_id 不带用户条件", "报告附带请求样例已阅读，未运行"],
      "counterevidence": ["前端隐藏了他人订单入口，但不影响直接调用 API"],
      "proof_gaps": [],
      "rank_queue": "valid",
      "rank": 1,
      "next_step": "转 security-fix-finding；可选转 security-validation 写越权测试",
      "owner_hint": "CODEOWNERS: src/orders/ @team-commerce"
    },
    {
      "id": "T-002",
      "title": "examples/ 目录中的演示脚本拼接 shell 命令",
      "source": {"type": "github_code_scanning", "id": "alert-57", "url": null, "reporter": null, "reported_at": null, "reported_severity": "error", "query": "state=open"},
      "claim": {"component": "examples/deploy.py", "entry": "unknown", "attacker_input": "命令行参数", "sink_or_control": "subprocess shell=True", "preconditions": [], "claimed_impact": "命令注入", "affected_versions": "unknown", "poc_provided": false},
      "verdict": "out_of_scope",
      "confidence": "high",
      "severity": null,
      "priority": null,
      "duplicate_of": null,
      "locations": [{"path": "examples/deploy.py", "start_line": 9, "end_line": 9, "role": "sink", "note": null}],
      "boundary": {"surface": "example", "input_trust": "same_privilege", "policy_basis": "pyproject 打包排除 examples/；参数由运行者本人提供", "crosses_boundary": "no"},
      "rationale": "脚本不随包发布，输入来自运行者自己。",
      "evidence": ["pyproject.toml:40 exclude = ['examples']"],
      "proof_gaps": [],
      "rank_queue": null,
      "rank": null,
      "next_step": "在扫描器中为 examples/ 加排除规则"
    }
  ]
}
```

## 10. 转换为 finding

`valid` 项需要进入跟踪或修复流程时，按以下映射生成 finding-schema 条目：`title`、`severity`、`priority`、`confidence`、`category`、`cwe`、`locations` 原样带过去；`summary` 取 `rationale`；`status` 静态闭合时为 `plausible`，完成动态验证后才是 `validated`；`validation` = `{"method": "static", "evidence": evidence 拼接, "proof_gaps": proof_gaps}`；`counterevidence` 原样；`references` 加入 `source.url`。指纹由 `security-scan/scripts/dedupe_candidates.py` 生成。
