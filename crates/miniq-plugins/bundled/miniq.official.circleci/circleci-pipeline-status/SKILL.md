---
name: circleci-pipeline-status
displayName: CircleCI 流水线状态
description: 当用户想查看 CircleCI 流水线、工作流、作业的当前状态或最近运行记录，或需要重跑、取消工作流时使用
origin: installed
---

## 适用场景

"main 分支最近的 CircleCI 过了没？""我刚推的提交跑到哪了？""把失败的 workflow 重跑一下。"

## 前置条件

- 与 `circleci-build-triage` 相同：`circleci` MCP（OAuth2）
- 或 CircleCI CLI：`circleci run list`、`circleci run watch`、`circleci workflow rerun`、`circleci workflow cancel`，参数以 `--help` 为准
- 或环境变量 `CIRCLE_TOKEN` 配合 REST API v2
- 需要项目 slug，例如 `gh/acme/web`

## 步骤

1. **定位项目**（`shell_run`）：用 `git remote get-url origin` 推出 slug。分支默认为当前分支。
2. **列出最近运行**：
   - `mcp_call`：先 `tools/list`，然后调用 `list_runs`（带分支过滤）
   - REST 备选（`http_request`，头 `Circle-Token`）：`GET https://circleci.com/api/v2/project/{slug}/pipeline?branch=<branch>`
3. **展开详情**：
   - 对最新的 1–3 个 pipeline 调用 `list_workflows`，失败或运行中的再调用 `list_jobs`
   - REST 备选：
     - `GET /api/v2/pipeline/{id}/workflow`
     - `GET /api/v2/workflow/{id}/job`
4. **汇报**：用表格列出每行的以下信息，并给出 CircleCI 网页链接：
   - pipeline 编号
   - 提交（短 SHA 和标题）
   - workflow 名称
   - 状态：success / failed / running / on_hold / canceled
   - 耗时
5. **需要人工审批的 on_hold 工作流**：只报告，不代为审批，除非用户明确要求并经 `ask_user` 确认。
6. **重跑或取消**（必须先 `ask_user`）：
   - MCP：`rerun_workflow`（可选 `from_failed`）/ `cancel_workflow`
   - REST 备选：
     - `POST https://circleci.com/api/v2/workflow/{id}/rerun`，body `{"from_failed": true}`
     - `POST https://circleci.com/api/v2/workflow/{id}/cancel`
7. **跟踪**（可选）：
   - 每隔 30–60 秒重新查询一次，直到终态
   - 超过 15 分钟仍未结束时停止轮询并告知用户
   - 失败时转入 `circleci-build-triage`

## 注意事项 / 安全

- 查询是只读的。重跑、取消、审批会产生费用或影响团队，每次都需要确认。
- 不要在输出中回显 `CIRCLE_TOKEN`。

## 如何确认完成

用户得到目标分支最近运行的状态表。若执行了重跑或取消，已确认 API 返回成功，并报告了新的运行状态。
