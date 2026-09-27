---
name: dropbox-cleanup
description: 当用户要清理 Dropbox 空间时使用：找出重复、过期、临时和大文件，生成带证据的清理清单，经用户逐项审阅确认后才删除或归档，并说明恢复方式。
version: 1
---

# Dropbox 内容清理

## 触发场景
- “Dropbox 快满了，帮我清理”“删掉重复的照片”“清理一下旧的临时文件和安装包”“把三年前的项目归档”。

## 前置条件
- 插件启用后会自动接入 MCP 服务器 `dropbox`（`mcp-remote` → `https://mcp.dropbox.com/mcp`）。首次调用时会在浏览器中弹出 Dropbox OAuth 授权，请用户登录并授权后重试。
- 先执行 `mcp_call {server:"dropbox", tool:"tools/list"}` 确认可用工具和参数 schema，工具名以返回结果为准。
- MCP 不可用时，按 `references/mcp-and-rest.md` 的顺序退回：先用本地同步目录（`~/Library/CloudStorage/Dropbox*` 或 `~/Dropbox`），再用 HTTP API（需要用户自行在环境变量中设置 `DROPBOX_ACCESS_TOKEN`，miniQ 不索要、不回显）。
- 删除是不可逆性最强的操作：必须先生成清单，经用户审阅并明确确认。

## 分步流程
1. **确定范围**：目标目录、判断规则（重复、早于某日期、临时文件、大于某大小），以及处置方式（删除或移到 `/归档`）。默认建议**归档**而不是删除。
2. **收集清单**：用 `list_folder` 递归列出范围内的条目（设置上限，分目录进行），把原始 JSON 保存到 `/tmp/miniq-dropbox/listing.json`。
3. **分析**：`shell_run` 执行 `python3 <本技能目录>/scripts/dropbox_dupes.py /tmp/miniq-dropbox/listing.json --older-than 2022-01-01 --min-size-mb 100`（先用 `file_read` 阅读脚本头部用法），输出重复组（同 content_hash，没有哈希时退而用同名同大小）、临时或垃圾文件、陈旧文件和大文件。
4. **人工复核**：对重复组，建议保留路径最规范或修改时间最新的那一份，并说明理由。共享文件夹中的文件、他人拥有的文件、最近 30 天修改过的文件，默认不纳入删除。
5. **审阅清单**：`ask_user` 展示清单（路径 | 大小 | 原因 | 建议动作）和总计释放空间；用户可以逐项剔除。条目很多时提供 `/tmp/miniq-dropbox/cleanup-plan.md` 供用户查看。
6. **执行**：归档用 `move`（按 `dropbox-organize` 的流程），删除用 `delete`，逐条执行并记录结果；批量任务用 `check_job_status` 轮询。执行过程中不新增清单外的条目。
7. **回读**：用 `list_folder` 或 `get_file_metadata` 确认已删除或已移动。
8. **汇报与恢复说明**：已删除文件可以在网页端的“已删除文件”中恢复，保留期取决于套餐；MCP 目前没有恢复工具。

## 工具与参数要点
- 临时文件模式：`~$*`、`*.tmp`、`.DS_Store`、`Thumbs.db`、`*.part`、`*.crdownload`、`*冲突副本*`/`*conflicted copy*`。
- 重复判定以 content_hash 为准；同名同大小只能算“疑似重复”，要单独标注。
- 不删除文件夹本身，除非它已为空且用户明确要求。

## 质量检查
- 每个删除项都有原因和用户确认；执行数量与确认清单一致。
- 保留一份执行记录（`/tmp/miniq-dropbox/cleanup-log.md`）。

## 失败回退
- 列表过大：按子目录分批处理。
- 删除失败（权限或锁定）：跳过该项并报告。
- MCP 不可用：使用同步目录（删除本地文件会同步到云端，同样要确认），或 HTTP `files/delete_v2`。

## 交付格式
- 清理前：汇总（重复 N 组 / 临时 N 个 / 陈旧 N 个 / 大文件 N 个，可释放 X GB）+ 明细表。
- 清理后：结果表（路径 | 动作 | 状态）、实际释放空间、恢复方式说明。
