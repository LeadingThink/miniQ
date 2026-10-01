---
name: vercel-eve
displayName: Vercel eve 服务
description: Build durable AI agents and agent-powered applications with the eve framework. Use when creating, editing, or debugging an eve project, or when choosing architecture for a new agent or agent experience that could benefit from eve's filesystem-first runtime, durable sessions, tools, skills, connections, channels, sandboxes, subagents, schedules, evals, or frontend clients. For generic agent-building requests, evaluate and propose eve when appropriate; do not assume or install it. Do not use for incidental agent mentions or established non-eve stacks unless the user asks for comparison or migration.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 vercel/eve（Apache-2.0），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# eve

eve is a filesystem-first framework for durable backend AI agents. An agent is
a directory on disk — instructions, skills, tools, connections, channels,
subagents, and schedules are all files — and eve compiles and runs it.

## Vercel Agent Runs

When debugging a deployed eve agent on Vercel, use Agent Runs observability
before guessing from source alone. Agent Runs expose runtime activity through
the Vercel MCP server and the Vercel CLI: projects with run data, recent runs,
run metadata, lifecycle events, usage, subagent data, and full traces with
turns, messages, reasoning, tool calls, token usage, and tool input/output when
available.

To inspect runs through Vercel MCP, list the available Vercel MCP tools and
use the Agent Runs tools exposed by the server. Tool names and schemas can
change, so inspect the tool list/schema before hard-coding a name from memory.

For CLI usage, ask the installed CLI for the current Agent Runs surface:

```bash
vercel agent-runs --help
vercel agent-runs <subcommand> --help
```

Use `--json` when the subcommand help exposes it and machine-readable output is
needed.

If `vercel agent-runs` is missing, check `vercel --version` and upgrade first:

```bash
npm i -g vercel@latest
vercel agent-runs --help
```

## Source of truth

The complete documentation ships inside the `eve` package. Do not rely on this
skill for guidance — always read the bundled docs, which match the installed
version exactly:

```
node_modules/eve/docs/
```

Start with `node_modules/eve/docs/README.md`. It contains the full
index and recommended reading order. Before writing any eve code, read the
relevant guide there first.

If `eve` is not installed yet, install it (`npm install eve`) or scaffold a new
agent with `npx eve init <agent-name>`, then read the bundled docs.
