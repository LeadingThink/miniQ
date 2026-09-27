# 扫描产物与台账格式

所有扫描类技能（`security-scan`、`security-deep-scan`、`security-diff-scan`）把产物写到同一目录结构，后续技能（验证、攻击路径、修复、跟踪、写报告）只从这里读取。

## 目录

默认位置：`<仓库根>/security-scans/<scan_id>/`（提醒用户把 `security-scans/` 加入 `.gitignore`，或按用户要求改到工作区外）。

`scan_id` 格式：`YYYYMMDD-HHMMSS-<standard|deep|diff>`。

```
security-scans/<scan_id>/
├── scan-manifest.json      # 扫描元数据与阶段状态
├── inventory.json          # 范围内文件清单（list_scope_files.py 生成）
├── threat-model.md         # 本次扫描使用的威胁模型（或引用仓库已有模型）
├── discovery/<分组>.json   # 可选：并行调查员各自输出的候选片段
├── candidates.json         # 发现阶段的候选（dedupe_candidates.py 去重排序）
├── coverage.json           # 覆盖台账（check_coverage.py 校验）
├── validation/<候选ID>/    # 每个候选的 PoC、输入、日志、结论 notes.md
├── attack-paths/<候选ID>.md# 攻击路径事实与严重度计算
├── findings.json           # 最终 finding（validate_findings.py 校验）
├── report.md               # 人读报告（findings_report.py 生成骨架后补写）
└── findings.sarif          # 可选：SARIF 2.1.0 导出
```

深度扫描额外有 `passes/pass-<n>/`，每轮一个独立子目录，结构同上但不含 `report.md`。

## scan-manifest.json

```json
{
  "schema_version": "miniq-security-scan/1",
  "scan_id": "20250101-120000-standard",
  "mode": "standard",
  "target": {"path": ".", "revision": "abc123", "scope": ["src/"], "diff_base": null},
  "started_at": "2025-01-01T12:00:00Z",
  "completed_at": null,
  "status": "running",
  "phases": {
    "inventory": "done",
    "threat_model": "done",
    "discovery": "running",
    "validation": "pending",
    "attack_path": "pending",
    "report": "pending"
  },
  "policy_files": ["SECURITY.md"],
  "limitations": []
}
```

- `status`：`running` / `completed` / `partial` / `failed` / `canceled`。只有全部阶段完成且 `findings.json` 通过校验才能写 `completed`；时间或权限不足时写 `partial` 并在 `limitations` 说明。
- 阶段取值：`pending` / `running` / `done` / `skipped`（`skipped` 必须在 `limitations` 写原因）。

## candidates.json

```json
{
  "schema_version": "miniq-security-candidates/1",
  "candidates": [
    {
      "id": "C-001",
      "title": "…",
      "category": "SQL 注入",
      "severity_hint": "high",
      "confidence": "medium",
      "locations": [{"path": "src/db.py", "start_line": 10, "end_line": 12, "role": "sink"}],
      "source": "HTTP 参数 q",
      "sink": "cursor.execute 字符串拼接",
      "control": "无参数化",
      "reasoning": "为什么可疑",
      "found_by": "pass-1/agent-auth",
      "status": "open"
    }
  ]
}
```

`status`：`open`（待验证）/ `validated` / `rejected` / `merged`（被去重合并，`merged_into` 指向保留项）。

## coverage.json（覆盖台账）

```json
{
  "schema_version": "miniq-security-coverage/1",
  "files": [
    {"path": "src/api/user.py", "status": "reviewed", "reviewer": "agent-api", "notes": "检查了鉴权与查询"},
    {"path": "vendor/x.js", "status": "skipped", "reason": "第三方代码，范围外"}
  ],
  "surfaces": [
    {"name": "HTTP API", "risk_classes": ["注入", "越权"], "result": "reported", "finding_ids": ["F-001"]},
    {"name": "文件上传", "risk_classes": ["路径穿越"], "result": "no_issue"}
  ]
}
```

- 文件 `status`：`reviewed` / `partial` / `skipped`；`partial` 与 `skipped` 必须带 `reason`。
- 攻击面 `result`：`reported`（产生 finding）/ `no_issue`（审查后无问题）/ `rejected`（候选被反证排除）/ `not_applicable` / `needs_follow_up`（有具体阻碍，写 `notes`）。
- `check_coverage.py` 会对照 `inventory.json` 报告未登记文件、覆盖率和缺少原因的条目。

## 放置规则

- 产物里的路径一律仓库相对路径。
- PoC、日志只放在 `validation/<候选ID>/`，不写进仓库源码目录。
- 不在任何产物中写入明文密钥；截取证据时打码。
- 已完成（`completed`）的扫描目录视为只读：后续修复、跟踪只能新增文件（如 `tracking.json`、`fixes/`），不改写 `findings.json` 原有字段，状态变化另记在 `findings-status.json`（`{"F-001": {"status": "fixed", "evidence": "…", "at": "…"}}`）。
