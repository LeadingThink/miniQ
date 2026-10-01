---
name: gh-fix-ci
description: 当用户说 GitHub Actions / CI 挂了、PR 检查不通过、想知道流水线为什么失败并修复时使用，基于 gh 拉取失败日志、定位根因并在本地修复
origin: installed
requires:
  bins:
    - gh
    - git
---

## 适用场景

用户的仓库托管在 GitHub，某个分支或 PR 的 Actions 检查失败，希望 miniQ 找出原因并给出修复。纯本地测试失败（与 CI 无关）不适用本技能。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `gh auth status` 确认已登录；未登录时请用户自己在终端运行 `gh auth login`，不要索要令牌。
2. 用 `git_status` 确认当前分支名 `<b>` 与工作区是否干净；有未提交改动时先告知用户，避免与修复混在一起。
3. 找到失败的运行：
   - 按分支：`gh run list --branch <b> --limit 5`
   - 按 PR：`gh pr checks <pr号>`，从中拿到失败的 job 链接或 run id。
4. 拉取失败日志：`gh run view <id> --log-failed`。日志很长时重定向到临时文件（如 `gh run view <id> --log-failed > /tmp/ci-<id>.log`），再用 `file_grep` 搜 `error`、`FAIL`、`Traceback`、`exit code` 等关键字。
5. 用 `file_read` 查看 `.github/workflows/` 下对应的工作流文件，弄清失败 step 实际执行的命令、运行环境和版本矩阵。
6. 判断失败类型并说明给用户：
   - 代码/测试问题：在本地用 `shell_run` 复现同一条命令（如 `npm test`、`cargo test`、`pytest`）。
   - 环境问题：依赖版本、缓存、缺少 secret、runner 镜像变化。
   - 偶发（flaky）：同一提交重跑可过，建议 `gh run rerun <id> --failed`（重跑前先问用户）。
7. 用 `file_edit` 做最小修复，再用 `shell_run` 在本地重跑失败命令验证通过；用 `git_diff` 展示改动。
8. 需要推送时，先向用户确认，再执行 `git add`、`git commit`、`git push`；推送后用 `gh run watch` 或 `gh pr checks <pr号> --watch` 观察结果。

## 注意事项 / 安全

- 推送、重跑工作流、修改工作流中的权限或 secret 引用，都必须先向用户确认。
- 不要为了让 CI 变绿而删除测试、加 `continue-on-error` 或跳过检查，除非用户明确同意并理解后果。
- 日志中可能出现 token 或内部地址，引用日志时只摘取与错误相关的几行，敏感内容打码。
- 缺少 secret 导致的失败无法在本地修复，应说明需要仓库管理员在 GitHub 设置中配置。
- 来自 fork 的 PR 可能没有 secret 权限，这是 GitHub 的安全设计，不要试图绕过。

## 如何确认完成

能说清失败的根因；本地复现命令已通过，或已明确给出无法本地修复的原因；推送后的新一次 CI 运行结果已向用户汇报。
