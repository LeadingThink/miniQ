---
name: security-scan
displayName: 标准安全扫描（security-scan）
description: "对整个仓库或指定子目录做一次标准的单轮安全扫描：范围清单、威胁模型、候选发现、验证、攻击路径与严重度、落盘台账与报告。审查 PR 或差异请用 security-diff-scan，多轮深挖请用 security-deep-scan。"
version: 1
---

# 标准安全扫描（security-scan）

本技能是 miniQ 安全插件的总编排：按固定阶段把一次仓库扫描做完整，产物全部落盘到 `security-scans/<scan_id>/`，后续的修复、跟踪、写报告技能都从这里取数。各阶段的细节由对应技能负责，本技能负责顺序、交接、台账与收尾。

## 触发场景

- 用户说"扫一下这个仓库/这个目录的安全问题""做一次安全审计""出一份漏洞报告"。
- 需要可复查的产物（清单、覆盖台账、findings.json、SARIF），而不只是一段聊天回复。

不适用（转交）：

- 只看某个 PR、提交、分支差异或未提交改动 → `security-diff-scan`。
- 用户要求"多轮""深度""尽量找全"或仓库很大且关键 → `security-deep-scan`（它会多次调用本技能的流程）。
- 只想快速看几个文件、不需要台账 → `security-review`。
- 只要威胁模型 / 只扫密钥 / 处理外部报告 → `security-threat-model` / `security-secret-scan` / `security-triage-finding`。

## 前置条件

- 目标目录可读；若是 git 仓库，记录 `HEAD` 版本，扫描期间不切换分支。
- `python3` 可用（共享脚本只依赖标准库）。
- 用户授权：默认只读分析 + 在本地一次性环境里运行 PoC/测试；任何需要联网攻击目标、访问生产环境、安装新依赖的动作都先 `ask_user`。
- 先读 `references/finding-schema.md` 与 `references/scan-artifacts.md`，它们是全插件共享契约。

## 分步流程

### 0. 准备（shell_run / file_glob / ask_user）

1. 确认范围：全仓还是子目录；是否排除测试、示例、第三方代码。范围不明确且仓库大于约 2000 个源文件时用 `ask_user` 确认，否则按"全仓、排除第三方与生成物"默认执行，并在报告里写明。
2. 生成 `scan_id`（`YYYYMMDD-HHMMSS-standard`），`shell_run` 创建 `security-scans/<scan_id>/`，写入初始 `scan-manifest.json`（全部阶段 `pending`）。
3. 并发保护：若 `security-scans/` 下已有 `status=running` 且修改时间在 2 小时内的扫描，先问用户是继续那一次、放弃它，还是新开一次；不要两次扫描写同一目录。
4. 查找安全策略：`file_glob` 搜 `SECURITY.md`、`.github/SECURITY.md`、`docs/**/security*.md`、各子包的 `SECURITY.md`。找到的写入 manifest 的 `policy_files`，后续严重度与"是否可报告"以它为准；没有时按 `../security-attack-path/references/severity-policy.md` 的默认策略。

### 1. 范围清单（shell_run）

```bash
python3 <本技能目录>/scripts/list_scope_files.py <仓库根> -o security-scans/<scan_id>/inventory.json \
  [--include src/] [--exclude 'tests/*']
```

查看 `summary`：文件数、行数、`sensitive` 数量。安全敏感文件（鉴权、会话、上传、执行、模板、webhook、CI 工作流等）是覆盖率硬指标。manifest 标 `inventory: done`。

### 2. 威胁模型（按 security-threat-model 执行）

- 仓库已有威胁模型（如 `docs/threat-model.md`）且与当前代码一致 → 引用并补充差异。
- 否则按 `security-threat-model` 的"扫描内模式"产出 `threat-model.md`：组件、入口、信任边界、资产、攻击者画像，以及**攻击面清单**（每个攻击面 = 入口 + 相关文件 + 需要检查的风险类别）。攻击面清单直接作为第 3 步的分派单位，并写进 `coverage.json` 的 `surfaces`（初始 `result` 留空）。

### 3. 候选发现（按 security-finding-discovery 执行）

- 规模小（安全敏感文件 ≲ 30）时由主代理逐个攻击面审查。
- 规模大时用 `agent_run`（`runInBackground: true`）按攻击面分组并行分派 2–4 个调查员子代理，每个子代理拿到：攻击面描述、文件列表、风险类别、可报告门槛、输出格式（candidates 片段写到 `passes/` 或 `discovery/<agent>.json`）。用 `process_output` 收齐全部结果，失败的分组单独重试，不得静默丢弃。
- 合并去重：

```bash
python3 <本技能目录>/scripts/dedupe_candidates.py discovery/*.json --renumber -o candidates.json
python3 <本技能目录>/scripts/validate_findings.py candidates.json
```

- 同步更新 `coverage.json`：每个审查过的文件记 `reviewed`/`partial`/`skipped`（后两者写原因）。

### 4. 验证（按 security-validation 执行）

对每个 `open` 候选建立验证标准，选择最强可行的验证方式（PoC / 测试 / 本地动态 / 静态闭合），证据写入 `validation/<候选ID>/`。结论写回候选：`validated` 或 `rejected`（附反证）；证据不足但仍可疑的保留 `open` 并记录证据缺口。候选多时可按候选并行分派子代理，但同一个候选只给一个子代理。

### 5. 攻击路径与严重度（按 security-attack-path 执行）

对每个 `validated`（以及用户要求保留的高价值 `open`）候选：追踪入口→控制→汇点→影响，逐条检查反证清单，按策略矩阵给出 impact/likelihood，再用脚本计算严重度：

```bash
python3 <插件目录>/security-attack-path/scripts/severity_calc.py findings.json --apply --explain
```

### 6. 生成 findings.json 与报告（file_write / shell_run）

1. 把保留的候选转成 finding（字段见 `references/finding-schema.md`），按严重度排序编号 `F-001…`，写 `findings.json`。
2. 校验并导出：

```bash
python3 <本技能目录>/scripts/validate_findings.py findings.json --strict
python3 <本技能目录>/scripts/check_coverage.py --inventory inventory.json --coverage coverage.json --findings findings.json
python3 <本技能目录>/scripts/findings_report.py findings.json --format markdown -o report.md
python3 <本技能目录>/scripts/findings_report.py findings.json --format sarif -o findings.sarif   # 可选
```

3. 用 `file_edit` 补写 `report.md` 的"执行摘要"和"覆盖范围与局限"（结构见 `references/report-format.md`）。
4. manifest 标 `report: done`，写 `completed_at`，`status` 设为 `completed`（有跳过或覆盖缺口时设为 `partial` 并写 `limitations`），最后再跑一次 `validate_findings.py scan-manifest.json`。

## 工具与参数要点

- `file_grep` 做离线源码搜索：先搜入口（路由装饰器、`app.get(`、`@RequestMapping`、`http.HandleFunc`、CLI 参数解析、消息消费者），再搜危险汇点（`exec`、`eval`、`subprocess`、`Runtime.exec`、`innerHTML`、原生 SQL、`pickle.loads`、`yaml.load`、文件路径拼接、出站 HTTP）。高频模式清单见 `../security-review/references/vulnerability-checklist.md`。
- 依赖漏洞：若锁文件存在且工具已安装，可用 `shell_run` 跑 `npm audit --json`、`pip-audit -f json`、`cargo audit --json`、`govulncheck ./...`；只把**确实可达**的依赖漏洞升为 finding，其余在报告附录列出。未安装的工具不要擅自安装，写入局限。
- `agent_run` 分派时给每个子代理**不重叠**的文件/攻击面，统一输出格式和门槛；主代理负责合并与复核，不直接采信子代理结论。
- 长扫描中每完成一个阶段就更新 manifest，便于中断后续跑。

## 质量检查

- [ ] `validate_findings.py --strict` 对 findings.json、candidates.json、scan-manifest.json 全部通过。
- [ ] `check_coverage.py` 通过：安全敏感文件 100% 登记，`partial`/`skipped` 都有原因；每个攻击面都有结论。
- [ ] 每条 high/critical 都有完整攻击路径、至少一条已检查的反证、明确的验证方式。
- [ ] 报告中没有明文密钥、令牌、个人数据；路径均为仓库相对路径。
- [ ] 报告区分"已验证"与"待确认"，不把推断写成事实。
- [ ] 零发现时，报告明确写出审查了什么、为什么认为没有可报告问题。

## 失败回退

- 目录太大无法在一轮内审完：优先覆盖安全敏感文件和外部入口，其余标 `skipped`（原因：时间预算），manifest 设 `partial`，并建议用户改用 `security-deep-scan` 或分子目录扫描。
- 无法运行代码（缺依赖、需要外部服务）：退回静态闭合验证，confidence 最高 `medium`，在 `validation.proof_gaps` 写明缺什么。
- 子代理失败或超时：只重试失败分组；两次失败则主代理自己审该分组或标记 `needs_follow_up`。
- 脚本报错：先按错误信息修正 JSON；不要为了通过校验而删除字段或降低证据要求。
- 用户中途取消：manifest 设 `canceled`，保留已产出的文件。

## 交付格式

聊天中给出简短摘要：

1. 扫描范围、版本、`scan_id` 与产物目录。
2. 严重度统计表 + 前 3–5 个最重要问题（编号、标题、位置、一句话影响）。
3. 覆盖率与局限（未覆盖部分及原因）。
4. 建议的下一步：`security-fix-finding` 修复、`security-track-findings` 登记、`security-writeup` 写详细报告。

完整内容在 `security-scans/<scan_id>/report.md` 与 `findings.json`（可选 `findings.sarif`，映射规则见 `references/sarif-mapping.md`）。
