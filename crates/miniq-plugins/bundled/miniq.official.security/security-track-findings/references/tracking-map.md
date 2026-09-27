# tracking.json 映射文件

tracking.json 记录“哪个 finding 指纹已经在哪个平台登记成哪张工单”，是跨多次扫描去重与状态同步的依据。默认路径是 `security-scans/tracking.json`，与扫描产物放在一起，可纳入版本控制（其中不含漏洞细节）。

## 1. 格式

```json
{
  "schema_version": "miniq-security-tracking/1",
  "updated_at": "2025-03-02T10:15:00+00:00",
  "entries": [
    {
      "fingerprint": "d18fca2da7db9233",
      "finding_id": "F-001",
      "title": "订单导出缺少归属校验",
      "provider": "github-issue",
      "target": "acme/shop",
      "key": "acme/shop#212",
      "url": "https://github.com/acme/shop/issues/212",
      "visibility": "private",
      "state": "open",
      "finding_status": "validated",
      "created_at": "2025-03-02T10:14:51+00:00",
      "last_synced_at": "2025-03-02T10:15:00+00:00",
      "last_seen_scan": "scan-20250301",
      "history": [
        {"at": "2025-03-02T10:14:51+00:00", "event": "created", "by": "miniq"}
      ]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `fingerprint` | 是 | 与 finding 的 `fingerprint` 一致（16 位十六进制）；是去重主键 |
| `provider` | 是 | `github-issue` / `ghsa` / `jira` / `csv` |
| `key` | 是 | 平台内唯一标识：`owner/repo#号`、`GHSA-xxxx-xxxx-xxxx`、`SEC-123`、CSV 的 `文件名:行` |
| `target` | 是 | 仓库、Jira 站点+项目或 CSV 文件路径 |
| `url` | 否 | 可点击链接；CSV 为空 |
| `finding_id` | 否 | 最近一次扫描中的 id；不同扫描 id 可能变化，所以不用作主键 |
| `visibility` | 是 | `public` / `private` / `private-draft` / `security-level:<名称>` |
| `state` | 是 | 平台状态归一：`open` / `closed` / `draft` / `published` / `unknown` |
| `finding_status` | 是 | 最近一次看到的 finding 状态；复扫未出现时写 `missing` |
| `last_seen_scan` | 否 | 最近一次包含该指纹的扫描 id |
| `history` | 否 | 事件列表：`created`、`linked_existing`、`commented`、`closed`、`reopened`、`state_synced` |

同一指纹在不同 provider 各有一条（例如同时有 Jira 单与 GHSA）；同一 provider 下指纹唯一。`build_tickets.py --tracking` 只按“同 provider 下的指纹”跳过。

## 2. 写入时机

- 平台写入成功并回读确认后**立即**追加一条，不要等整批结束——中途失败时已创建的单不会丢失记录。
- 平台搜索发现已有工单（人工开的或历史遗留）时追加一条 `linked_existing` 记录。
- CSV 导出完成后为每行追加 `provider: csv` 记录（`key` 为 `文件名:行号`），避免重复导出；如果用户希望每次全量导出则不要登记。
- 使用 `file_edit` 或 python 读改写整个 JSON，写前备份为 `tracking.json.bak`，写后用 `python3 -m json.tool` 校验。

## 3. 同步规则

输入：最新 findings、tracking.json、平台上各工单的当前状态（只读查询）。

| finding（最新扫描） | 工单状态 | 建议操作 |
| --- | --- | --- |
| 存在，validated/plausible | open | 无；更新 `last_seen_scan` |
| 存在，validated/plausible | closed | 建议重开并评论“在 <版本> 复现”（需确认） |
| status 为 fixed，或复扫未出现（`missing`） | open | 建议评论复扫结果并关闭（需确认）；未出现可能是扫描范围变化，先核对扫描范围 |
| fixed / missing | closed | 无；记录 `finding_status` |
| rejected / accepted_risk | open | 建议评论结论（需确认），是否关闭由用户决定 |
| 存在但 tracking 中无记录 | — | 视为新 finding，走正常登记流程 |
| tracking 有记录但平台返回 404 | — | 标记 `state: unknown`，报告给用户，不自动重建 |

“复扫未出现”只有在两次扫描范围覆盖同一文件时才算修复证据；可用 `python3 <插件目录>/security-scan/scripts/check_coverage.py` 核对。只修改 tracking.json 的本地更新无需确认；任何评论、关闭、重开都要先预览再确认。

## 4. 回写 findings

用户需要时，把登记结果写回 findings 的 `tracking` 字段（契约见 `../../security-scan/references/finding-schema.md`）：

```json
"tracking": [{"provider": "github-issue", "url": "https://github.com/acme/shop/issues/212"}]
```

这样下游报告（`findings_report.py`）可以直接显示工单链接。

## 5. 损坏与重建

1. 备份损坏文件；
2. 在每个已用过的平台上按 `miniq-fp:` 标签或文本搜索全部工单（GitHub：`gh issue list --label security --state all --json number,url,labels,state`；Jira：`labels = security AND text ~ "miniq-fp"`；GHSA：列出各状态公告并在描述中匹配）；
3. 从标签/正文中解析指纹，重建 entries，`history` 写一条 `rebuilt`；
4. 向用户展示重建结果和无法匹配的工单。
