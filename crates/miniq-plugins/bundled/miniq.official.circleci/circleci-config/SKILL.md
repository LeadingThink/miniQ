---
name: circleci-config
description: 当用户要新建或修改 .circleci/config.yml、引入 orb、配置缓存、并行或多工作流，并用 circleci config validate 校验时使用
origin: installed
requires:
  bins:
    - circleci
---

## 适用场景

从零为项目接入 CircleCI、优化现有配置（提速、缓存、并行测试、矩阵），或修复配置语法和校验错误。

## 前置条件

- 安装 CircleCI CLI（`shell_run`，执行前 `ask_user`）：
  - macOS / Linux：`brew install circleci`
  - 其他安装方式（apt、rpm、WinGet）见 https://cli.circleci.com/reference/
  - 用 `circleci version` 确认安装
- 校验公共 orb 不需要 token。私有或命名空间 orb 需要认证：
  - 由用户在自己的终端执行 `circleci auth login`（浏览器登录）
  - 或事先设置环境变量 `CIRCLE_TOKEN`
  - miniQ 不代为输入或回显 token

## 步骤

1. **了解项目**：
   - 用 `glob` / `file_read` 识别语言与包管理器，例如 `package.json`、lockfile、`pyproject.toml`、`go.mod`
   - 找出测试、lint、构建命令
   - 若已有 `.circleci/config.yml`，先读取
2. **起草配置**（`file_write` / `file_edit`），要点：
   - `version: 2.1`
   - 优先使用官方 orb，例如 `circleci/node`、`circleci/python`，版本号先用 `web_fetch` 查 `https://circleci.com/developer/orbs` 的当前版本，不要臆测
   - 使用 `cimg/*` 便利镜像，例如 `cimg/node:<版本>`
   - 缓存：`save_cache` / `restore_cache`，key 带 lockfile 校验和，例如 `deps-{{ checksum "package-lock.json" }}`
   - 测试结果与产物：`store_test_results` / `store_artifacts`
   - 并行测试：`parallelism: N` 配合 `circleci tests glob ... | circleci tests run --command=...`
   - `workflows` 中定义 job 依赖（`requires`）、分支过滤（`filters.branches`）、需要人工审批时加 `type: approval`
   - 机密通过 Project Settings 的环境变量或 Contexts 注入，配置中只写 `context: <name>`，不要写明文
3. **校验**（`shell_run`）：
   - 执行 `circleci config validate .circleci/config.yml --json`
   - `valid` 为 false 时，按 `errors` 用 `file_edit` 修正后重试
   - 使用私有 orb 时加 `--org gh/<org>`
   - 拆分目录形式的配置可用 `circleci config pack .circleci | circleci config validate --config -`
4. **展开检查**（`shell_run`）：执行 `circleci config process .circleci/config.yml > /tmp/processed.yml`，然后用 `file_read` 查看 orb 展开后的实际命令是否符合预期。
5. **在本地验证命令**（`shell_run`）：
   - 把配置中各 job 的 `run` 命令（安装依赖、lint、测试、构建）在本地依次执行一遍，确认可通过
   - 并行测试的切分命令只能在 CircleCI 上验证
6. **提交与观察**：
   - 提示用户提交并推送（git 操作需用户确认）
   - 然后用 `circleci-pipeline-status` 查看首次运行结果

## 注意事项 / 安全

- 配置中不得出现明文 token 或密码。发现已有的明文机密时提醒用户轮换。
- 第三方（非 `circleci/`）orb 等同于执行外部代码，引入前向用户说明来源并确认。
- 修改 `resource_class` 或 `parallelism` 会影响额度消耗，需告知用户。

## 如何确认完成

`circleci config validate --json` 返回 `valid: true`，`config process` 展开结果符合预期。若已推送，首次 pipeline 运行成功或失败原因已明确。
