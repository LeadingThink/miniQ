# GitHub 私有草稿安全公告（GHSA）

仅在目标为 `ghsa` 时阅读。本技能只负责**创建私有草稿**；发布、关闭、申请 CVE、邀请协作者、创建临时私有分叉都由维护者在 GitHub 页面上手工完成。

## 1. 适用前提

逐项确认，任一不满足就停止并说明原因：

| 检查 | 方法 | 不满足时 |
| --- | --- | --- |
| 是开源包的**源仓库**（不是 fork、不是镜像） | `gh repo view <owner>/<repo> --json isFork,parent,visibility,url` | 改用该包真正的源仓库，或改走 Jira/私有 Issue |
| 当前身份有管理员或安全管理员权限 | `gh repo view <owner>/<repo> --json viewerPermission`（需要 `ADMIN`，或组织授予的 security manager 角色） | 生成载荷文件交给维护者手工提交 |
| finding 为 `validated` 且严重度不是 info | 脚本会校验 | 先完成验证 |
| 有证据支持的受影响版本范围 | 来自 `security-writeup` 的版本追溯或维护者确认 | 不要从扫描的那个提交推测范围；先追溯 |
| 源码版本与 finding 位置一致 | `git rev-parse HEAD` 与 findings `target.revision` 比对，逐个 `file_read` 位置 | 重新扫描或修正 finding |

每次 API 调用都显式写出 `owner/repo`，并用 `--hostname github.com`（或用户指定的 GHES 主机）固定目标，不依赖环境里默认的仓库或主机。

## 2. 端点

只使用以下三个端点，统一带请求头 `Accept: application/vnd.github+json`：

- `GET /repos/{owner}/{repo}/security-advisories?state=<triage|draft|published|closed>`：去重。
- `POST /repos/{owner}/{repo}/security-advisories`：创建草稿（默认 `state` 为 draft，无需也不应指定别的状态）。
- `GET /repos/{owner}/{repo}/security-advisories/{ghsa_id}`：创建后回读。

不调用 `PATCH`（修改或发布）、`/cve`（申请 CVE）、`/forks`（临时私有分叉）、`/reports`（私有漏洞报告）。

## 3. 载荷字段

| 字段 | 必填 | 来源与规则 |
| --- | --- | --- |
| `summary` | 是 | finding.title，≤1024 字符，不写利用方式 |
| `description` | 是 | 脚本生成的完整 Markdown；有 `security-writeup` 报告时可替换为报告的执行摘要 + 漏洞细节 + 修复建议 + 受影响版本 |
| `vulnerabilities[]` | 是 | 每个受影响的包一项 |
| `vulnerabilities[].package.ecosystem` | 是 | `npm`、`pip`、`maven`、`nuget`、`composer`、`go`、`rust`、`rubygems`、`erlang`、`actions`、`pub`、`swift`、`other` 之一 |
| `vulnerabilities[].package.name` | 是 | 包管理器里的规范名，不是仓库名；从 `package.json`/`pyproject.toml`/`go.mod` 等读取 |
| `vulnerabilities[].vulnerable_version_range` | 是 | 如 `>= 2.3.0, < 2.5.2`；必须有版本追溯证据 |
| `vulnerabilities[].patched_versions` | 否 | 只有修复版本**已经发布**才填，否则为 null |
| `vulnerabilities[].vulnerable_functions` | 否 | 确定时填写限定名，帮助下游可达性分析 |
| `severity` / `cvss_vector_string` | 二选一 | 有经过逐项论证的 CVSS 向量才用向量；否则用 finding.severity（critical/high/medium/low）。不要从分数或文字反推向量 |
| `cwe_ids` | 否 | 只放与根因高度匹配的 CWE，形如 `CWE-639` |
| `cve_id`、`credits`、`start_private_fork` | 不填 | 由维护者后续处理 |

受影响包信息可放在 finding 的扩展对象里，脚本优先读取：

```json
"advisory": {
  "ecosystem": "pip",
  "package": "shop-server",
  "vulnerable_version_range": ">= 2.3.0, < 2.5.2",
  "patched_versions": null,
  "cvss_vector_string": null,
  "vulnerable_functions": ["shop.orders.export.export_order"]
}
```

也可以用命令行 `--ecosystem --package --vulnerable-range --patched` 统一提供（仅限单包单公告场景）。

## 4. 描述内容

草稿是私有的，但**终将公开**。描述写：影响、受影响版本、前置条件、足以理解的技术说明、修复或缓解方式、仓库相对路径位置、finding id 与指纹。不写：凭证、签名 URL、内部系统名、真实用户数据、超出必要的完整利用载荷。在预览中提醒用户：指纹与 finding id 会随发布一起公开，可以在发布前手工删除。

## 5. 去重

```
gh api --hostname github.com "/repos/<owner>/<repo>/security-advisories?state=draft&per_page=100" --paginate \
  --jq '.[] | select(.description | contains("miniq-fp:<指纹>")) | {ghsa_id,state,html_url}'
```

对 `triage`、`draft`、`published`、`closed` 四种状态都查一遍。按指纹命中即为重复；未命中时再按包名 + CWE + 摘要关键词人工比对，疑似重复列给用户判断。

## 6. 创建与回读

一次只建一个公告，不批量：

```
gh api --hostname github.com --method POST /repos/<owner>/<repo>/security-advisories \
  -H "Accept: application/vnd.github+json" --input security-scans/ghsa-F-001.json --jq '{ghsa_id,state,html_url}'
gh api --hostname github.com /repos/<owner>/<repo>/security-advisories/<ghsa_id> --jq '{state,severity,vulnerabilities}'
```

确认 `state` 为 `draft`、包与范围正确后写入 tracking.json（`provider: ghsa`，`key: <ghsa_id>`，`visibility: private-draft`）。

## 7. 常见错误

| 响应 | 原因 | 处理 |
| --- | --- | --- |
| 403 | 权限不足或组织禁止 | 停止，交付载荷文件给维护者 |
| 404 | 仓库名错误或无权看到安全公告 | 核对 owner/repo 与身份 |
| 422 `ecosystem`/`package` | 生态值或包名不规范 | 从清单文件重新确认包名后重新预览 |
| 422 `severity` 与 `cvss_vector_string` 冲突 | 两者同时提供 | 只保留一个，重新预览 |
