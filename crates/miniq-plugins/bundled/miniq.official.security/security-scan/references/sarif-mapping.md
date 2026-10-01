# findings → SARIF 2.1.0 映射

`findings_report.py --format sarif` 的映射规则，便于上传到 GitHub Code Scanning 等支持 SARIF 的平台。

## 结构

- 一次导出 = 一个 `run`，`tool.driver.name = "miniq-security"`，`version` 为插件版本。
- **rule**：按"主 CWE + 类别"聚合。`ruleId` 形如 `miniq/cwe-89/sql`（类别含非 ASCII 字符时用 sha1 前 8 位代替 slug）。`properties.tags` 含 `security` 与 CWE；有 CWE 时 `helpUri` 指向 CWE 定义页。同一 rule 下取最高严重度作为 `security-severity`。
- **result**：每条 finding 一个。

| finding 字段 | SARIF 位置 |
| --- | --- |
| `title` + `summary` | `message.text` |
| `severity` | `level`（critical/high→error，medium→warning，low/info→note）与 `properties.security-severity`（9.5/8.0/5.5/3.0/0.0） |
| 主位置（第一个 sink，否则第一个 control，否则第一项） | `locations[0].physicalLocation`，`uriBaseId = %SRCROOT%` |
| 其余 `locations` | `relatedLocations`，`message` 为角色与备注 |
| `attack_path` | `codeFlows[0].threadFlows[0].locations[].location.message` |
| `fingerprint` | `partialFingerprints["miniqFinding/v1"]`；缺失时用"类别+路径+起始行"的 sha1 前 16 位 |
| `id`、`confidence`、`status` | `properties.miniq-id` / `confidence` / `status` |
| `target.revision` | `versionControlProvenance[0].revisionId` |

## 使用注意

- 默认只导出 `validated` 与 `plausible`；`rejected` 不应上传，`fixed` 仅在需要关闭告警历史时用 `--include-status all`。
- 上传 GitHub：`gh api -X POST repos/<owner>/<repo>/code-scanning/sarifs -f commit_sha=<sha> -f ref=refs/heads/<branch> -f sarif=$(gzip -c findings.sarif | base64 | tr -d '\n')`。上传属于写外部系统，先征得用户同意。
- 平台按 `partialFingerprints` 追踪同一告警，修复后重新扫描上传即可自动关闭；不要每次改变指纹算法。
- SARIF 中路径必须是仓库相对路径，否则平台无法关联源码。
