# 外部会话导入

miniQ 可以从本机发现并导入 Codex、Claude Code 和 OpenCode 会话。扫描只会在用户打开“导入会话”后执行，不会在应用启动时自动读取或修改外部数据。

## 支持范围

| 来源 | 默认位置 | 可覆盖配置 | 当前续聊方式 |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` | `CODEX_HOME` | `recreate_only` |
| Claude Code | `~/.claude/projects` | `CLAUDE_CONFIG_DIR` | `recreate_only` |
| OpenCode | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` | `OPENCODE_DATA_DIR`、`OPENCODE_DB` | `recreate_only` |

`recreate_only` 表示导入的历史会进入 miniQ 的会话上下文，后续消息由 miniQ 当前配置的模型和工具运行。它不表示 miniQ 已恢复原供应商进程中的原生 session。数据库同时保留外部 session ID 和完整原始事件，后续增加原生 `RuntimeAdapter` 时不需要重新导入历史。

OpenCode 仅支持当前 SQLite `session/message/part` 数据库。旧版 `storage/*.json` 已由 OpenCode 自身迁移，不提供旧格式兼容分支。

Codex 标题优先读取 `CODEX_HOME` 中最高版本 `state_<n>.sqlite` 的 `threads.title`，不存在时使用完整首条真实用户消息。Claude Code 的 `subagents/agent-*.jsonl` 是主会话内部执行记录，不作为独立会话展示。

## 数据流

```text
SessionConnector
  -> externalSession.scan (仅返回全量摘要)
  -> 用户选择来源会话和目标 workspace
  -> externalSession.import (按 source_path 精确加载)
  -> 单个 SQLite 事务
       sessions / messages            UI 与 miniQ runtime 投影
       external_session_links          来源与同步身份
       external_session_events         完整原始事件 JSON
```

连接器只负责发现和解析供应商数据，不依赖 `ModelProvider`。`ModelProvider` 继续只处理 miniQ 的模型调用，原生 miniQ 会话不经过连接器。

## 一致性

- `(provider, external_id)` 唯一标识一个外部会话。
- 重复导入只写入尚未出现的事件和消息，不覆盖用户在 miniQ 中产生的后续消息。
- 外部消息按供应商事件顺序排列；miniQ 后续消息始终位于导入历史之后。
- 每条外部事件的完整结构化 JSON 会写入 `external_session_events.payload_json`，UI 消息只是可重建投影。
- Codex 注入的 `AGENTS.md`、`environment_context`，Claude Code 本地命令提示和所有供应商 system 消息不会进入可续聊投影，但仍完整保存在原始事件中。
- Claude Code 的纯 `tool_result` 使用 `tool` 角色，`tool_use` / `function_call` 保留工具名称，避免把工具输出伪装成用户输入。
- OpenCode 使用只读 SQLite 事务直接读取数据库和 WAL，不复制单独的 `.db` 文件。
- 重复导入会刷新供应商标题；外部来源新增的消息会排在 miniQ 已有续聊之前，且不会把会话更新时间写回旧值。

## 目标项目

用户可以为所选会话显式指定已有 miniQ 项目。未指定时，miniQ 根据外部会话的 cwd 自动解析：

- 普通 Git 仓库中的子目录归入最近的仓库根目录。
- linked worktree 通过 `.git` 的 `gitdir` / `commondir` 元数据映射回主 checkout。
- 非 Git 目录使用其规范化绝对路径。
- 用户 home 和 Codex 的 `~/Documents/Codex/**` 临时目录不会被自动注册；必须显式选择 miniQ 项目。
- cwd 缺失或目录已不存在时，也必须显式选择 miniQ 项目。

Windows 路径统一去掉 `\\?\` 前缀并使用 `/` 分隔，避免与 miniQ 已有项目重复。

## 新增连接器

新的来源实现 `miniq_session_connectors::SessionConnector`：

- `scan` 返回所有可导入会话的摘要，不返回或截取原始事件。
- `load` 根据扫描得到的 `external_id + source_path` 精确加载完整快照。
- `load` 必须验证 `source_path` 属于连接器自己的数据根目录或数据库。
- 供应商原始数据写入 `ExternalSessionEvent.payload`；已知文本内容投影为 `ExternalSessionMessage`。
- 供应商的系统提示、运行环境和子代理记录不得伪装成用户消息；过滤只发生在投影层，原始 payload 不得修改。

新增 provider 时必须同步更新 Rust 协议枚举、JSON Schema、TypeScript 类型和 SQLite `CHECK` 约束。
