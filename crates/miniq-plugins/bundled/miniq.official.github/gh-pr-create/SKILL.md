---
name: gh-pr-create
description: 当用户想把当前分支的改动整理成 GitHub Pull Request（写标题、描述、选择目标分支并创建）时使用
origin: installed
requires:
  bins:
    - gh
    - git
---

## 适用场景

用户说"帮我提个 PR"、"把这些改动整理一下发 PR"。适用于 GitHub 仓库；本技能负责梳理改动、生成描述并在确认后创建 PR。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `gh auth status` 确认登录；未登录请用户自行在终端运行 `gh auth login`。
2. 用 `git_status` 查看当前分支和未提交改动。若当前在 `main`/`master` 等默认分支上，建议新建分支（如 `git switch -c feat/<简述>`），先征得用户同意。
3. 确定目标分支：`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`，用户另有指定则以用户为准。
4. 梳理改动：
   - 已提交部分：`git log --oneline <base>..HEAD` 与 `git diff <base>...HEAD --stat`
   - 未提交部分：用 `git_diff` 查看，问用户是否一并提交。
5. 检查仓库是否有 PR 模板：用 `file_glob` 查找 `.github/pull_request_template.md`、`.github/PULL_REQUEST_TEMPLATE/*.md`，有则按模板填写。
6. 起草 PR：
   - 标题：简洁说明做了什么，遵循仓库已有的提交风格（如 Conventional Commits）。
   - 描述：背景/动机、主要改动（列表）、测试方式、风险与回滚、关联 issue（如 `Closes #123`，仅在用户确认编号时写）。
   - 用 `file_write` 写到临时文件（如 `/tmp/pr-body.md`），给用户预览。
7. 可选：用 `shell_run` 运行测试/lint，把结果写进"测试方式"。
8. 用户确认后：`git push -u origin <分支>`，再执行 `gh pr create --base <base> --title '<标题>' --body-file /tmp/pr-body.md`；用户希望先草稿时加 `--draft`。
9. 把 `gh pr create` 输出的 PR 链接告诉用户，可用 `gh pr checks` 查看检查状态。

## 注意事项 / 安全

- 推送与创建 PR 都是对外可见的操作，必须先向用户确认标题、描述和目标分支。
- 提交前用 `git_diff` 检查是否误带密钥、`.env`、大文件或调试代码。
- 不要擅自添加 reviewer、label 或 assignee，除非用户要求。
- 不要使用 `git push --force`，除非用户明确要求并理解影响。

## 如何确认完成

PR 已创建并返回链接，描述包含改动说明与测试方式，目标分支正确。
