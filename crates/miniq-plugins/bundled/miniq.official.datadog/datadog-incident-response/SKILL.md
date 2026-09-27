---
name: datadog-incident-response
description: 当用户要在 Datadog 中推进 incident 或采取处置行动时使用：汇总 incident 与时间线、触发 Bits AI 调查、创建或更新 Case 并关联 Jira、执行工作流与远程只读诊断，所有写操作先确认。
version: 1
---

# Datadog 事件响应与处置

## 触发场景
- “总结一下当前进行中的 incident”“给这个问题建个 case 并关联 Jira”“让 Bits AI 查一下这个告警”“执行重启工作流”“在这台主机上看一下磁盘占用”“写复盘草稿”。

## 前置条件
- 插件启用后自动接入 MCP 服务器 `datadog`（`mcp-remote` → `https://mcp.datadoghq.com/v1/mcp`，US1 站点，默认只开 `core` 工具集）。首次调用会在浏览器弹出 OAuth 授权，请用户完成后重试。
- 非 US1 站点、需要额外工具集（URL 追加 `?toolsets=...`）或 MCP 不可用时，按 `references/toolsets-and-sites.md` 处理；REST 退路需要用户自行在环境变量中配置 `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`，miniQ 不索要、不回显。
- 工具集：`core`（incident 只读）、`cases`（Preview，默认不开）、`investigator`（Preview）、`workflows`、`remote-actions`（Preview，需申请）、`notebooks`。

## 分步流程
1. **发现工具**：`mcp_call {server:"datadog", tool:"tools/list"}`，并告诉用户当前能执行和不能执行的动作。
2. **态势汇总**：用 `search_datadog_incidents` 列出进行中的 incident（严重级别、状态、负责人、开始时间）；用 `get_datadog_incident` 取详情和时间线；用 `get_investigations_from_incident_id` 查看已有的调查。
3. **补充证据**：调用 `datadog-investigate` 的流程查日志、指标和 trace，补全根因证据。
4. **自动调查（可选）**：确认后调用 `trigger_incident_investigation`/`trigger_bits_ai_investigation`；用 `get_bits_ai_investigation` 轮询结果，用 `steer_bits_ai_investigation` 补充方向。结论要经人工复核。
5. **工单**：用 `search_datadog_cases` 查重；确认后用 `create_datadog_case`（标题、优先级、项目用 `list_datadog_case_projects` 查询、负责人用 `search_datadog_users` 查询）；进展用 `add_comment_to_datadog_case` 记录，状态用 `update_datadog_case` 更新，关联 Jira 用 `link_jira_issue_to_datadog_case`。
6. **工作流处置**：用 `list_datadog_workflows` → `get_datadog_workflow` 确认输入参数和影响；`ask_user` 展示将执行的工作流、参数和影响范围后，才调用 `execute_datadog_workflow`；用 `get_datadog_workflow_instance` 跟踪结果。新建或修改工作流前，要先 `validate_datadog_workflow` 再确认。
7. **主机诊断（可选）**：`datadog_remote_action_restricted_shell_run_command` 只用于只读诊断（df、ps、tail 日志）。每条命令都要单独确认，并注明目标主机。
8. **复盘草稿**：按 `references/postmortem-template.md` 生成，可在确认后用 `create_datadog_notebook` 写入 Datadog，或用 `file_write` 保存到本地。
9. **收尾**：汇报已执行的动作和结果，以及待办和负责人。

## 工具与参数要点
- incident 状态修改、严重级别调整、对外通报不在 MCP 默认工具中；需要时指导用户在 UI 操作，或用 REST（需确认）。
- 所有写操作都遵循“展示 → 确认 → 执行 → 回读”四步。
- 工作流可能触发重启、扩缩容、回滚等高影响动作，要逐项确认，不做批量自动执行。

## 质量检查
- 时间线完整（检测、响应、缓解、恢复），每个节点都有时间和来源。
- 所有写操作都有确认记录，且回读验证了结果。
- 复盘草稿中不做人员归责，行动项有负责人和截止时间（负责人由用户填写）。

## 失败回退
- 缺少 cases/workflows 工具集：输出工单或处置步骤草稿，让用户手动执行，或提示开启对应工具集。
- 远程动作不可用：给出建议命令，由用户在自己的终端执行。

## 交付格式
- incident 态势表、时间线、已执行动作表（动作 | 目标 | 结果 | 确认时间）、Case/Jira 链接、复盘草稿路径或笔记本链接。
