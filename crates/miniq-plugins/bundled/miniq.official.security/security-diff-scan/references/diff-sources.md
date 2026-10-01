# 差异来源识别与命令

| 用户说法 | 来源类型 | 基线 | 取差异命令 |
| --- | --- | --- | --- |
| "PR #123"、PR 链接 | pr | PR 的 base 分支合并基点 | `gh pr diff 123`；需要代码时 `gh pr checkout 123` 到临时 worktree |
| "这个提交 abc123" | commit | `abc123^` | `git diff abc123^!`（合并提交用 `git diff abc123^1 abc123`） |
| "最近 3 个提交" | range | `HEAD~3` | `git diff HEAD~3 HEAD` |
| "我的分支"、"和 main 比" | branch | `git merge-base <默认分支> HEAD` | `git diff --merge-base <默认分支> HEAD` |
| "v1.2 到 v1.3" | tags | `v1.2` | `git diff v1.2 v1.3` |
| "还没提交的改动" | worktree | `HEAD` | `git diff HEAD` + `git ls-files --others --exclude-standard` |
| 用户给了 .diff/.patch 文件 | patch | 未知 | 直接读取；如能 `git apply --check` 则可在临时 worktree 应用 |

## 默认分支判定

依次尝试：`git symbolic-ref refs/remotes/origin/HEAD`、`gh repo view --json defaultBranchRef`、存在的 `main`/`master`。都失败时询问用户。

## 临时 worktree

```bash
git worktree add --detach /tmp/miniq-diff-<scan_id> <head-sha>
# 审查、运行测试……
git worktree remove /tmp/miniq-diff-<scan_id>
```

结束后务必移除，并在报告中记录使用过的 SHA。不要在用户的工作目录里 checkout 其他分支。

## 记录到 manifest

```json
"target": {
  "path": ".",
  "revision": "<head-sha>",
  "diff_base": "<base-ref>@<base-sha>",
  "scope": "pr#123"
}
```
