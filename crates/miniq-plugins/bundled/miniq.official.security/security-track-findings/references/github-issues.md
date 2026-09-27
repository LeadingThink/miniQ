# GitHub Issues

仅在目标为 `github-issue` 时阅读。

## 1. 先判断能不能用 Issue

Issue 在公开仓库里对所有人可见，且会被搜索引擎与镜像站收录，删除也无法撤回已被抓取的内容。

```
gh repo view <owner>/<repo> --json nameWithOwner,visibility,isPrivate,hasIssuesEnabled,viewerPermission
```

| 情况 | 做法 |
| --- | --- |
| `visibility` 为 `PRIVATE` / `INTERNAL` | 可用 `--visibility private` 生成完整版本；仍需确认读者范围合适 |
| `PUBLIC`，finding 为 low/info 或已修复未发布前不敏感 | `--visibility public`（默认），`ask_user` 确认后才能写 |
| `PUBLIC`，finding 为 critical/high/medium 且未修复 | 不建议开公开 Issue。建议改用 GHSA 私有草稿、私有仓库或 Jira；用户坚持时只开公开安全版本 |
| `hasIssuesEnabled=false` | 不能写，改其他目标 |
| `viewerPermission` 低于 `TRIAGE` | 可以创建但不能打标签/指派；告知用户标签会被忽略，指纹改为写在正文末尾用于搜索 |

确认问题示例（`ask_user`）：“`acme/shop` 是公开仓库。将创建 2 个只包含概要、文件名和修复建议的 Issue，不含行号和利用步骤。这会公开这两个问题的存在。是否继续？”

## 2. 公开安全版本写什么

允许：类别与 CWE、严重度、涉及文件（不带行号）、高层概要、修复方向、指纹。
禁止：行号、攻击路径、请求/载荷样例、绕过方式、验证输出、内网地址、用户数据、凭证（哪怕已失效）。

`summary` 往往已包含触发方式。公开前在 finding 中补充 `public_title` 与 `public_summary`（脚本会优先使用；公开模式下缺少 `public_summary` 时，正文只放占位说明，不会带出原 `summary`），例如：

```json
{"public_title": "订单导出权限校验加固", "public_summary": "订单导出功能的权限校验需要加强，详情请联系安全团队。"}
```

预览时人工逐字检查正文；脚本的过滤是字段级的，不理解语义。

## 3. 载荷字段（`POST /repos/{owner}/{repo}/issues`）

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `title` | `[安全][严重度] finding.title`；公开版本用 `public_title` 或类别 | 长度适中，避免在标题写利用方式 |
| `body` | 脚本生成的 Markdown | 末尾带 `miniq-fp:<指纹>` 与 finding id |
| `labels` | `security`、`miniq-fp:<指纹>`、`severity:<级别>`、`--label` | 仓库中不存在的标签会被自动创建（需要写权限），这也是一次外部写入，预览中要列出 |
| `assignees` | `--assignee` | 可选 |
| `milestone` | 不由脚本生成 | 用户要求时手工添加并重新预览 |

仓库有 Issue 模板或标签规范时（`gh api /repos/{owner}/{repo}/contents/.github/ISSUE_TEMPLATE`、`gh label list`），优先遵守仓库规范，在预览里说明调整。

## 4. 去重

```
gh search issues --repo <owner>/<repo> "miniq-fp:<指纹>" --json number,url,state,title --limit 5
gh issue list --repo <owner>/<repo> --label "miniq-fp:<指纹>" --state all --json number,url,state
```

- 按指纹命中（含已关闭）即为重复。已关闭但 finding 仍存在时不要新开，建议重开或评论（同样需要确认）。
- 再按标题关键词 + `security` 标签搜一次，发现人工开的同类单；疑似重复时列给用户判断，不要自动归并。
- 搜索有延迟（索引几分钟），所以标签列表是更可靠的一路。

## 5. 写入与验证

```
python3 -c "import json,sys;d=json.load(open('security-scans/tickets-github-issue.json'));json.dump(d['tickets'][0]['payload'],open('security-scans/issue-0.json','w'),ensure_ascii=False)"
gh api --method POST /repos/<owner>/<repo>/issues --input security-scans/issue-0.json --jq '{number,html_url}'
gh api /repos/<owner>/<repo>/issues/<number> --jq '{title,state,labels:[.labels[].name]}'
```

每条成功后立即登记 tracking.json（`provider: github-issue`，`key: <owner>/<repo>#<number>`）。临时的单条载荷文件在完成后删除。

## 6. 同步与关闭

- finding 变为 `fixed` 且工单仍开启：建议评论“在 <版本/提交> 复扫未再发现”并关闭（`gh issue close <n> --comment ...`），需确认。
- 工单已关闭但 finding 复现：建议重开并评论复现版本，需确认。
- 不要编辑别人写的评论或正文。
