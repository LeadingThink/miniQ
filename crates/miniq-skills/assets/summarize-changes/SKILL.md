---
name: summarize-changes
description: 汇总一个 git 仓库最近的改动(状态、diff、未提交工作),生成一份 markdown 变更摘要
origin: bundled
requires:
  bins:
    - git
---

## 适用场景

用户想知道"这个项目最近改了什么"、"帮我总结一下当前的改动"、"写一份变更说明",且工作区是 git 仓库。

## 步骤(写明每步用哪个工具)

1. 用 `git_status` 查看当前分支与改动文件列表;若 `clean: true` 且用户关心历史,用 `shell_run` 执行 `git log --oneline -20` 看最近提交。
2. 对改动文件,用 `git_diff` 查看工作区 diff;需要看暂存区时传 `staged: true`。
3. 大文件的 diff 很长时,用 `git_diff` 的 `path` 参数逐个文件查看,不要一次拉全部。
4. 按"新增 / 修改 / 删除 / 未跟踪"分组,写出每个文件改动的一句话说明。
5. 用 `file_write` 把摘要写为 `CHANGES-SUMMARY.md`(需要用户审批),或按用户要求直接在回复中给出。

## 注意事项(真实踩过的坑)

- `git_status` 的 `files[].status` 是 porcelain 两字符码:`??` 未跟踪、`M` 修改、`A` 新增、`D` 删除,报告里翻译成人话。
- 未跟踪的新文件不会出现在 `git_diff` 里,要用 `file_read` 看内容(只在必要时)。
- 不要执行任何写入型 git 命令(commit/add/push),这个技能只做只读汇总。

## 如何确认完成

摘要覆盖了 status 列出的全部文件,分组正确,且明确写出当前分支名。
