---
name: secret-scan
description: 当用户想检查代码仓库或目录中是否有硬编码的密钥、令牌、密码、私钥等敏感信息（包括 git 历史）时使用，只报告位置并打码，不回显完整密钥
origin: installed
---

## 适用场景

用户说"看看有没有把密钥提交进去"、"开源前扫一下敏感信息"、"检查 .env 有没有泄露"。

## 步骤（写明每步用哪个工具）

1. 确认范围：当前工作区文件，以及是否需要扫描 git 历史（用 `ask_user` 确认）。
2. 优先使用专用工具（存在时）：用 `shell_run` 检查 `gitleaks version` 或 `trufflehog --version`。
   - gitleaks：`gitleaks detect --source . --redact --report-format json --report-path /tmp/gitleaks.json`（`--redact` 避免输出明文）。
   - 未安装时不强制安装，改用下面的手工扫描，并告诉用户可以自行安装专用工具获得更全面结果。
3. 手工扫描：用 `file_grep`（排除 `node_modules`、`dist`、`target`、`.git`、锁文件）搜索常见模式：
   - 云厂商与平台密钥前缀：`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{36}`、`github_pat_`、`sk-[A-Za-z0-9]{20,}`、`xox[baprs]-`、`AIza[0-9A-Za-z_-]{35}`
   - 私钥：`-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
   - 通用赋值：`(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"]{8,}`（忽略大小写）
   - 连接串：`(postgres|mysql|mongodb(\+srv)?|redis)://[^:\s]+:[^@\s]+@`
4. 检查敏感文件：用 `file_glob` 找 `.env*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`credentials*.json`；用 `shell_run` 执行 `git ls-files` 与 `git check-ignore -v <文件>` 判断它们是否被跟踪或被忽略。
5. 扫描历史（用户同意时）：`git log -p --all -S '<可疑前缀>' --oneline` 或 gitleaks 的默认历史扫描。
6. 逐条研判，排除误报：测试夹具、示例占位符（如 `your-api-key-here`）、公开的可发布密钥（如前端公开 key）要标注说明。
7. 输出报告（回复中或用 `file_write` 写 `secret-scan-report.md`）：类型、文件:行号（或提交哈希）、打码值（只保留前 4 位，如 `ghp_****`）、是否仍在当前代码中、建议处理。
8. 给出处置建议：立即在对应平台吊销并轮换密钥；把值移到环境变量或密钥管理服务；把文件加入 `.gitignore`；如需清理历史，说明 `git filter-repo` 等方案及其影响。

## 注意事项 / 安全

- 任何输出（回复、报告、日志）都不得包含完整密钥；读取文件内容时也只摘取必要片段。
- 不要尝试用发现的密钥去调用任何服务来"验证有效性"。
- 改写 git 历史、强制推送、删除文件都必须先向用户确认，并提醒一旦推送过，仅清理历史不足以补救，必须轮换密钥。

## 如何确认完成

范围内全部文件（以及经确认的历史）已扫描，每条发现都已研判真伪并给出处置建议，报告中无明文密钥。
