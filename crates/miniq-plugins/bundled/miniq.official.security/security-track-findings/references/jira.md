# Jira

仅在目标为 `jira` 时阅读。适用于 Jira Cloud（REST v3，描述用 ADF）与 Jira Server/Data Center（REST v2，描述用纯文本或 wiki 标记）。

## 1. 确定站点、项目与认证

- 站点：`https://<site>.atlassian.net`（Cloud）或自建地址。以用户给出的为准，不猜测。
- 项目 key 与问题类型：必须由用户确认。常见做法是安全项目 `SEC`，类型 `Bug` 或 `Security Vulnerability`（自定义类型）。
- 认证：Cloud 用邮箱 + API token 的 Basic 认证；Server 用个人访问令牌（Bearer）。从环境变量读取（如 `JIRA_EMAIL`、`JIRA_API_TOKEN`、`JIRA_PAT`），命令中用 `$变量`，不在对话、文件、日志中回显。没有凭证时告诉用户需要设置什么，然后停下。
- 没有 API 权限时可以用 `browser_automation` 在已登录的网页上填写表单，规则不变：先预览、再确认、提交后核对。

## 2. 读取项目元数据（只读）

```
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/issue/createmeta/<项目KEY>/issuetypes"
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/issue/createmeta/<项目KEY>/issuetypes/<类型ID>"
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/priority"
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/project/<项目KEY>/securitylevel"
```

据此确认：问题类型名、必填字段（包括自定义字段 `customfield_xxxxx`）、优先级名称、可用的安全级别。必填自定义字段脚本不会生成，需要在预览前手工补进载荷，并在预览中标出。

## 3. 字段映射

| Jira 字段 | 来源 | 说明 |
| --- | --- | --- |
| `project.key` | `--jira-project` | 必填 |
| `issuetype.name` | `--jira-issuetype`（默认 Bug） | 必须在 createmeta 中存在 |
| `summary` | `[安全][严重度] finding.title`，截到 250 字符 | Jira 上限 255 |
| `description` | ADF 文档（`--jira-format adf`）或 Markdown 文本（`text`） | 见第 4 节 |
| `labels` | `security`、`miniq-fp:<指纹>`、`severity:<级别>`、`--label` | 标签不能含空格，脚本会把空白换成 `-` |
| `priority.name` | 由 P0–P3 映射 | 见第 5 节 |
| `security.name` | `--jira-security-level` | 限制谁能看到这张单；安全问题强烈建议设置 |
| 组件、修复版本、指派人 | 不由脚本生成 | 用户要求时手工补并重新预览；指派人在 Cloud 需要 `accountId` |

## 4. 描述格式

- **REST v3（Cloud）**：`description` 必须是 ADF 对象（`{"type":"doc","version":1,"content":[...]}`），传字符串会 400。脚本把自身生成的 Markdown 简化转换为 ADF：`##` → 三级标题，`- ` → 无序列表，`> ` → 引用，`---` → 分隔线，其余为段落，行内的粗体与代码标记被去掉。
- **REST v2（Server/DC 或 Cloud 的 v2 端点）**：`description` 是字符串，Jira 会按 wiki 标记渲染。脚本输出的 Markdown 在 wiki 里可读但不完全美观；需要时可把 `## ` 替换为 `h3. `、反引号替换为 `{{ }}`。
- 两种格式末尾都保留 finding id 与 `miniq-fp:<指纹>`，便于全文检索。

## 5. 优先级映射

默认映射（可用 `--jira-priority-map P0=Blocker,P1=Critical,P2=Major,P3=Minor` 覆盖）：

| finding 优先级 | 来自严重度 | 默认 Jira 优先级 |
| --- | --- | --- |
| P0 | critical | Highest |
| P1 | high | High |
| P2 | medium | Medium |
| P3 | low / info | Low |

finding 已有 `priority` 时优先使用；否则由严重度推导。映射后的名称必须出现在 `/rest/api/3/priority` 的结果中，否则会 400。某些项目使用优先级方案，只允许部分优先级，也要核对。

## 6. 去重

```
curl -s -G -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/search/jql" \
  --data-urlencode 'jql=project = SEC AND labels = "miniq-fp:<指纹>"' --data-urlencode 'fields=key,status,summary'
```

（旧版站点使用 `/rest/api/2/search`。）命中即为重复，包括已解决的单；已解决但 finding 仍存在时建议重开，需确认。未命中时再用 `text ~ "<标题关键词>" AND labels = security` 找人工开过的单，疑似重复交给用户判断。

## 7. 创建与回读

```
python3 -c "import json;d=json.load(open('security-scans/tickets-jira.json'));json.dump(d['tickets'][0]['payload'],open('security-scans/jira-0.json','w'),ensure_ascii=False)"
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Content-Type: application/json" \
  -X POST "https://<site>/rest/api/3/issue" --data @security-scans/jira-0.json
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>/rest/api/3/issue/<KEY>?fields=summary,labels,priority,security,status"
```

逐条串行执行；每条回读确认后写入 tracking.json（`provider: jira`，`key: SEC-123`，`url: https://<site>/browse/SEC-123`）。完成后删除单条载荷临时文件。

## 8. 状态同步

- 读状态：`GET /rest/api/3/issue/<KEY>?fields=status,resolution`，把 `status.statusCategory.key`（`new`/`indeterminate`/`done`）写入 tracking.json 的 `state`。
- 建议操作（都需确认）：finding 已修复 → 添加评论并按项目工作流转换（`GET /rest/api/3/issue/<KEY>/transitions` 找到对应的 transition id）；单已完成但 finding 复现 → 评论并重开。
- 不修改别人写的描述或评论。

## 9. 常见错误

| 响应 | 原因 | 处理 |
| --- | --- | --- |
| 400 `description` | v3 端点传了字符串 | 改用 `--jira-format adf` 重新生成 |
| 400 `priority` / `issuetype` | 名称不存在或不在方案中 | 从元数据选择合法值，更新映射后重新预览 |
| 400 `customfield_…` 必填 | 项目要求自定义字段 | 向用户询问取值，补入后重新预览 |
| 401 / 403 | 凭证无效或无创建权限 | 停止并告知用户 |
| 429 | 限流 | 按 `Retry-After` 等待，不要连续重试 |
