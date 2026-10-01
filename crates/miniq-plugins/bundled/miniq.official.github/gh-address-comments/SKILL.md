---
name: gh-address-comments
description: 当用户要处理某个 GitHub Pull Request 上的 review 评论（逐条修改代码、回复评审人）时使用，基于 gh 拉取未解决评论并逐条落实
origin: installed
requires:
  bins:
    - gh
    - git
---

## 适用场景

用户说"把 PR 上的评论处理一下"、"reviewer 提了意见帮我改"、"回复一下 review"。前提是当前仓库已检出该 PR 的分支。

## 步骤（写明每步用哪个工具）

1. 用 `shell_run` 执行 `gh auth status`；未登录请用户自行运行 `gh auth login`。
2. 确定 PR：用户未给编号时执行 `gh pr view --json number,title,headRefName,url`（基于当前分支）；必要时 `gh pr checkout <pr号>` 切到 PR 分支（切换前用 `git_status` 确认工作区干净）。
3. 拉取评论：
   - 整体评论与评审结论：`gh pr view <pr号> --comments`
   - 行内评论（含文件与行号）：`gh api repos/{owner}/{repo}/pulls/<pr号>/comments --paginate`
   - 需要"是否已解决"信息时，用 `gh api graphql` 查询 `reviewThreads { isResolved }`。
4. 整理成清单，每条包含：编号、评审人、文件:行号、原话摘要、建议处理方式（修改 / 解释说明 / 不同意并说明理由）。把清单给用户过目，让用户用 `ask_user` 选择要处理的条目。
5. 对选中的条目，用 `file_read` 查看上下文，用 `file_edit` 修改；每处理完一条就记录对应的改动位置。
6. 用 `shell_run` 运行项目的测试或 lint，确认没有引入新问题；用 `git_diff` 向用户展示全部改动。
7. 经用户确认后提交并推送（`git commit`、`git push`）。
8. 回复评论前再次向用户确认措辞；回复行内评论可用 `gh api repos/{owner}/{repo}/pulls/<pr号>/comments/<comment_id>/replies -f body='<内容>'`，整体回复用 `gh pr comment <pr号> --body '<内容>'`。

## 注意事项 / 安全

- 推送代码和发表评论都会被他人看到，必须先向用户确认。
- 评论之间可能互相矛盾，或与需求冲突，遇到时列出来让用户决定，不要自行取舍。
- 不要擅自 resolve 评审人的对话，除非用户明确要求。
- 回复语气保持礼貌、具体，说明"改了什么、在哪个提交"。

## 如何确认完成

用户选中的每条评论都有对应的代码改动或书面回复；测试通过；推送与回复均在用户确认后完成，并向用户列出处理结果对照表。
