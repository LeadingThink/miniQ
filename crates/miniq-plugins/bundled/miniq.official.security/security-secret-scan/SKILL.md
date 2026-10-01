---
name: security-secret-scan
displayName: 硬编码密钥扫描
description: "检查仓库、目录或 git 历史中是否有硬编码的密钥、令牌、密码、私钥等凭据时使用；只报告位置并打码，给出研判与轮换处置。不用于通用漏洞扫描（转 security-scan）或运行时密钥管理设计（转 security-hardening）。"
version: 1
---

# 硬编码密钥扫描

目标：找出仓库（及经同意的 git 历史）中暴露的凭据，逐条研判真伪与影响，给出可执行的轮换与清理方案。**任何输出都不得出现完整密钥。**

## 触发场景

- "开源前扫一下敏感信息""看看有没有把密钥提交进去""`.env` 有没有泄露""CI 里加个密钥检查"。
- 作为 `security-scan` / `security-diff-scan` 的补充检查：把结果以 `--format finding` 合入本次扫描的 `findings.json`。
- 对已知泄露事件做影响面盘点（哪些提交、哪些文件、是否已推送）。

不适用 / 应转交：

- 通用漏洞审计 → `security-scan`；只看某次改动 → `security-diff-scan`（它可以调用本技能的脚本）。
- 外部报告称"某密钥泄露"需要判断真伪与优先级 → `security-triage-finding`。
- 设计密钥管理体系、短期凭据、工作负载身份等架构改造 → `security-hardening`。
- 修改代码把密钥移出 → `security-fix-finding`（本技能只给建议，除非用户明确要求顺带修改）。

## 前置条件

- 确认范围：工作区当前文件（默认），是否包含 git 历史、其他分支、子模块。扫描历史前用 `ask_user` 确认。
- 本技能只读、离线：**不得**用发现的凭据调用任何服务去"验证有效性"；有效性由用户在签发平台自行确认。
- 结果文件默认写到工作区外或 `security-scans/<scan_id>/`，提醒用户不要把扫描结果提交进仓库。

## 分步流程

1. **确定范围与模式**（`ask_user`、`git_status`、`shell_run`）：用 `shell_run` 执行 `git rev-parse --show-toplevel` 与 `git ls-files | wc -l` 了解规模；询问是否扫描历史、是否有既有基线（如 `secrets-baseline.json`）。
2. **优先使用专用工具**（`shell_run`）：检查 `gitleaks version`、`trufflehog --version`、`detect-secrets --version`。存在时：
   - `gitleaks detect --source . --redact --report-format json --report-path <输出目录>/gitleaks.json`（历史扫描是 gitleaks 默认行为；只扫工作区加 `--no-git`）。
   - 未安装时不擅自安装，继续第 3 步，并在交付里说明可安装专用工具获得更全面覆盖。
3. **内置脚本扫描**（`shell_run`）：
   - `python3 <本技能目录>/scripts/scan_secrets.py <路径> -o <输出目录>/secrets.json`
   - 已有基线：追加 `--baseline <基线文件>`，只看新增。
   - 需要合入扫描台账：`--format finding --scan-id <scan_id> -o <输出目录>/secret-findings.json`，再用 `python3 <插件目录>/security-scan/scripts/validate_findings.py <文件> --kind findings` 校验。
   - 规则、阈值与误报处理见 `references/rules-and-triage.md`。
4. **敏感文件检查**（`file_glob`、`shell_run`）：`file_glob` 查 `**/.env*`、`**/*.pem`、`**/*.key`、`**/*.p12`、`**/id_rsa*`、`**/*credentials*.json`；用 `shell_run` 跑 `git ls-files -- <文件>` 与 `git check-ignore -v <文件>` 判断是否被跟踪、是否被忽略规则覆盖。
5. **历史扫描**（用户同意后，`shell_run`）：没有 gitleaks 时，对第 3 步命中的前缀执行 `git log --all --oneline -S '<前4位前缀>'` 定位引入/删除提交；用 `git log --all --diff-filter=D --name-only -- '*.pem' '*.env'` 找被删除但仍在历史里的敏感文件。命令输出中如出现明文，只摘取提交号与路径。
6. **逐条研判**（`file_read`、`file_grep`）：读命中行上下文（只取必要片段），按 `references/rules-and-triage.md` 第 3 节判定为 真实凭据 / 疑似 / 占位符或测试夹具 / 公开可发布标识 / 误报，并评估权限范围与暴露面（公开仓库、已推送、内部仓库、仅本地）。
7. **处置方案**（本地推理）：按 `references/rotation-playbook.md` 为每个真实或疑似凭据给出：吊销与轮换步骤、代码改造方向、历史清理是否必要、需要通知谁。改写历史、强制推送、删除文件都必须先 `ask_user` 取得同意。
8. **交付**（`file_write`）：写报告（见"交付格式"）；需要时把确认为误报的指纹写进基线（`--write-baseline`），并说明基线文件应纳入版本控制、定期复核。

## 工具与参数要点

- `scan_secrets.py` 常用参数：`--exclude-dir`（可重复）、`--exclude`（glob）、`--max-size`（默认 1 MiB）、`--no-entropy`（高熵噪声过大时）、`--entropy`/`--hex-entropy`/`--min-length`（调阈值）、`--fail-on-findings`（CI 中有结果返回 1）。
- 行内豁免标记：`miniq-secret-allow`、`gitleaks:allow`、`pragma: allowlist secret`；使用豁免必须在报告中说明理由。
- 脚本输出只含前 4 位打码值与指纹；研判时如必须看原文，用 `file_read` 读取但**不得**在回复、报告、日志中复述。
- `file_grep` 可补充脚本未覆盖的厂商格式（见 `references/rules-and-triage.md` 第 2 节的扩展线索）。

## 质量检查

- 报告、JSON、回复、命令行参数中没有完整密钥（可用 `shell_run` 对输出文件 grep 已知原文前缀以外的部分做抽查）。
- 每条结果都有研判结论和理由；"占位符/测试"的判定写出依据（值形态、文件位置、是否被生产代码引用）。
- 区分"当前代码中仍存在"与"仅存在于历史"；区分"已推送/公开"与"仅本地"。
- 说明扫描覆盖：文件数、跳过的二进制/大文件数量、排除目录、是否含历史、是否用了专用工具。
- 未扫到不等于没有：写明局限（二进制、加密文件、外部配置中心、CI 变量、容器镜像层未覆盖）。

## 失败回退

- 仓库过大脚本太慢：按顶层目录分批扫描，或用 `agent_run`（`runInBackground=true`）分目录并行，最后合并；也可先 `--no-entropy` 跑规则再对重点目录开熵检测。
- 高熵噪声太多：提高 `--entropy` 或 `--min-length`，排除生成文件目录，并在报告中注明调整。
- 非 git 目录：跳过历史步骤并说明。
- 专用工具报错：记录错误，回退到内置脚本，不反复重试。

## 交付格式

`secret-scan-report.md`（或在回复中给出同样结构）：

1. 摘要：范围、是否含历史、工具、文件数、结果数（按研判结论分组）。
2. 需要立即处置：表格 `编号 | 类型 | 位置（路径:行 或 提交号） | 打码值 | 暴露面 | 研判 | 处置`。
3. 待确认 / 疑似：同上，附需要用户确认的问题。
4. 已判定误报或可接受：简述理由，并给出是否加入基线。
5. 处置建议与时间线：引用 `references/rotation-playbook.md` 的步骤。
6. 局限与未覆盖。

合入扫描时另交付 `secret-findings.json`（通过 `validate_findings.py`），finding 字段见 `../security-scan/references/finding-schema.md`；研判为误报的条目状态改为 `rejected` 并写 `counterevidence`。
