# 检测规则与误报研判

本文件说明 `scripts/scan_secrets.py` 的规则、输出字段、阈值调优，以及如何把一条命中研判为"真实 / 疑似 / 误报"。

## 1. 内置规则一览

| 规则 ID | 检测对象 | 默认严重度提示 | 典型形态 | 说明 |
| --- | --- | --- | --- | --- |
| `aws-access-key-id` | AWS 访问密钥 ID | high | `AKIA` / `ASIA` + 16 位大写字母数字 | 单独的 ID 不足以调用 API，但通常与密钥成对出现，应顺查附近行 |
| `aws-secret-access-key` | AWS 秘密访问密钥 | critical | 40 位 base64 字符，附近有 `aws` 与 `secret` 字样 | 仅靠上下文关键字识别 |
| `github-token` | GitHub 经典令牌 | high | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` 前缀 | 前缀即类型：个人/OAuth/用户到服务器/应用安装/刷新 |
| `github-fine-grained-pat` | GitHub 细粒度 PAT | high | `github_pat_` | |
| `gitlab-token` | GitLab PAT | high | `glpat-` | |
| `slack-token` / `slack-webhook` | Slack | high / medium | `xoxb-` 等；`hooks.slack.com/services/…` | Webhook 可被滥用发消息、钓鱼 |
| `anthropic-api-key` | Anthropic | high | `sk-ant-` | 先于 OpenAI 规则匹配，避免重复 |
| `openai-api-key` | OpenAI 风格 | high | `sk-`、`sk-proj-` 等 | 很多厂商沿用 `sk-` 前缀，研判时确认签发方 |
| `google-api-key` | Google API Key | medium | `AIza` + 35 位 | 很多是前端公开 key，需看是否限制了来源与 API |
| `stripe-secret-key` | Stripe 生产密钥 | critical | `sk_live_` / `rk_live_` | `pk_live_` 是可公开的可发布密钥，不在规则中 |
| `twilio-api-key` / `sendgrid-api-key` / `npm-token` / `pypi-token` / `telegram-bot-token` | 各平台 | high/medium | 平台前缀 | npm/PyPI 令牌泄露可导致供应链投毒，优先处理 |
| `azure-storage-key` | Azure 存储账户密钥 | critical | 连接串中的 `AccountKey=` | |
| `private-key` | 私钥 PEM 块 | critical | `-----BEGIN … PRIVATE KEY-----` | 打码值只显示 `----`；需看是否加密（`ENCRYPTED`） |
| `jwt` | JWT | medium | `eyJ….eyJ….…` | 可能已过期；解码载荷（本地、不联网）看 `exp` 与权限 |
| `connection-string-password` | 数据库/队列连接串中的口令 | high | `postgres://user:pass@host` | 打码对象是口令部分 |
| `basic-auth-url` | URL 中的账号口令 | medium | `https://user:pass@host` | |
| `generic-secret-assignment` | 通用赋值 | medium | `password = "…"`、`api_key: '…'` | 噪声最大的规则，需逐条看 |
| `high-entropy-string` | 高熵字符串 | low | 引号或赋值后 ≥24 位、混合字母数字 | 兜底检测，默认低置信度 |
| `sensitive-filename` | 敏感文件名 | medium | `.env`、`*.pem`、`id_rsa`、`credentials.json` 等 | `.example`/`.sample`/`.template`/`.pub` 结尾的不报 |

同一位置被多条规则命中时只保留第一条（规则表的顺序即优先级），高熵检测不会重复报告已被规则命中的片段。

## 2. 扩展线索（脚本未内置，可用 `file_grep` 补查）

| 目标 | 正则线索 |
| --- | --- |
| 阿里云 AccessKey ID | `LTAI[0-9A-Za-z]{12,20}` |
| 腾讯云 SecretId | `AKID[0-9A-Za-z]{32}` |
| 华为云 AK | 结合 `access_key`/`AK` 上下文的 20 位大写字母数字 |
| Azure AD 客户端密钥 | `client_secret` 附近 34–40 位含 `~` `.` `_` 的字符串 |
| GCP 服务账号 | `"type": "service_account"` 且同文件有 `"private_key"` |
| Heroku | `heroku.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` |
| Docker 认证 | `"auths"` + `"auth": "` （`.docker/config.json`） |
| Kubernetes Secret | `kind: Secret` 且 `data:` 下有 base64 值 |
| Terraform 状态 | `*.tfstate` 文件本身（常含明文输出） |
| 企业微信/钉钉/飞书 Webhook | `qyapi.weixin.qq.com/cgi-bin/webhook/send\?key=`、`oapi.dingtalk.com/robot/send\?access_token=`、`open.feishu.cn/open-apis/bot/v2/hook/` |

## 3. 研判流程

对每条命中依次回答：

1. **值是真的吗？**
   - 占位符特征：`xxxx`、`****`、`<…>`、`${VAR}`、`{{ var }}`、`changeme`、`example`、`your_…`、全 0、连续数字。脚本用 `placeholder_like` 标记，但仍需人看。
   - 厂商文档中公开的示例值（如 AWS 文档示例 key 通常以 `EXAMPLE` 结尾）→ 误报。
   - 格式校验：长度、字符集、前缀是否符合该厂商规范；截断或含空格的通常不是。
2. **它在哪里？**
   - 测试夹具、示例、文档（`in_test_path=true`）：若是专为测试生成的假值 → 误报；若测试里放了真实凭据（常见于集成测试）→ 仍然是真实泄露。
   - 生产代码、配置、部署文件、CI 配置 → 高优先级。
   - 生成文件、打包产物 → 找到源头文件再报告。
3. **它能做什么？**
   - 标识 vs 凭据：可公开的标识（Stripe `pk_live_`、Firebase Web 配置、Sentry DSN、带来源限制的地图 key）通常不是漏洞，但要确认没有超出设计的权限。
   - 权限范围：只读/读写/管理员；单一资源/整个账号；是否可签发新凭据。
   - 有效期：JWT `exp`、临时凭据（`ASIA` 开头的 AWS 临时 key）可能已过期，但仍需确认。
4. **谁能看到？**
   - 公开仓库或曾经公开 → 视为已泄露，必须轮换，历史清理只是次要措施。
   - 内部仓库 → 看有多少人/系统有读权限（含 CI、镜像仓库、fork）。
   - 仅本地未提交 → 提醒加入 `.gitignore`，风险低。

### 研判结论

| 结论 | 含义 | finding 状态 |
| --- | --- | --- |
| 真实凭据 | 格式与上下文都指向真实可用凭据 | `plausible`（用户确认有效后 `validated`） |
| 疑似 | 无法判断真假或有效性 | `plausible`，置信度 `low`/`medium`，写 `proof_gaps` |
| 占位符/测试假值 | 明确不可用 | `rejected`，`counterevidence` 写依据 |
| 公开标识 | 设计上可公开 | `rejected` 或 `info` 级提示（如缺少来源限制） |
| 误报 | 不是凭据（哈希、UUID、校验和、base64 图片等） | `rejected` |

### 严重度参考

- critical：生产云账号根/管理员密钥、支付生产密钥、签名私钥、包发布令牌，且仓库公开或广泛可读。
- high：生产服务令牌、数据库口令，内部仓库。
- medium：权限受限的令牌、Webhook、测试环境但与生产共享的凭据。
- low：已过期、仅本地、权限极小或可疑但无法确认。

最终严重度可交给 `../../security-attack-path/scripts/severity_calc.py` 按 impact × likelihood 计算。

## 4. 常见误报与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 锁文件、`go.sum` 大量高熵 | 完整性哈希 | 默认已排除；其他类似文件用 `--exclude` |
| 32/40/64 位十六进制 | git 提交号、MD5/SHA 摘要 | 十六进制使用单独的较低熵阈值且要求 ≥32 位；看变量名判断 |
| base64 图片/字体 | 内嵌资源 | 排除对应目录或提高 `--min-length` 无效时用 `--no-entropy` |
| UUID | 标识符 | 通常不报；若变量名是 `secret`/`token` 则要看 |
| `password = "password"` 等 | 测试或示例 | 占位符判定 |
| i18n 文案中的 "password" | 键名匹配 | 通用规则要求值 ≥8 位且无空格，仍有残余，人工排除 |

## 5. 基线与豁免

- 基线文件（`--write-baseline`）只存指纹，不存值。指纹 = sha1(规则|路径|sha256(值)) 的前 16 位，值或路径变化都会产生新指纹。
- `--baseline` 接受三种格式：指纹数组、本脚本 `json` 输出（读 `results[].fingerprint`）、本脚本 `finding` 输出（读 `references` 中的 `secret-fingerprint:`）。
- 行内豁免只用于确认无害的固定值，并写注释说明原因；不要用豁免掩盖真实凭据。
- 基线需要定期复核：凭据被轮换后删除对应指纹。

## 6. 输出字段（`--format json`）

| 字段 | 说明 |
| --- | --- |
| `rule_id` / `rule_name` | 规则 |
| `severity_hint` | 规则默认严重度，研判后可调整 |
| `confidence` | 结合占位符与测试路径自动降级 |
| `path` / `line` / `column` | 相对扫描根的路径，1 起始行列 |
| `masked` / `length` | 前 4 位 + `****`，原值长度 |
| `fingerprint` | 基线用 |
| `in_test_path` / `placeholder_like` | 研判辅助 |
| `entropy` | 仅高熵规则 |

`stats` 给出扫描文件数、跳过的二进制/大文件/不可读文件、结果数、基线忽略数，用于在报告中说明覆盖。
