# OneAPI 问答模型兼容性实测（2026-09-03）

## 方法

数据来自 `https://oneapi.zaiwenai.com/v1/models` 的实时返回。排除向量、图片、视频、音乐和语音模型后，共测试 43 个问答候选。每个模型执行：

1. 512 token 上限的 OpenAI-compatible SSE 文本请求，验证 HTTP、非空正文、终态和 `[DONE]`；
2. SSE `file_read` 工具调用，验证 `finish_reason=tool_calls` 以及分片参数合并后 JSON 可解析。

测试是低成本可用性与协议兼容检查，不代表模型质量排名，也不是并发容量压测。

## 应剔除或降级

| 模型 | 文本结果 | 工具结果 | 原因 |
|---|---|---|---|
| `claude-fable-5`（Chat Completions） | `content_filter`、空正文 | `content_filter` | 旧的 OpenAI-compatible 路径不适合作为该模型的能力判断；原生 Messages 路径已于 2026-09-04 通过 |
| `gemini-3.5-flash` | HTTP 200 但正文声明模型已停用 | 未调用工具 | 业务失败被伪装成成功响应 |
| `gpt-5.1-codex-mini` | HTTP 400 | HTTP 400 | requested operation unsupported |
| `grok-4` | HTTP 503 | HTTP 503 | 无可用渠道 |
| `grok-4.1-fast-non-reasoning` | HTTP 503 | HTTP 503 | 无可用渠道 |

此外，`gemini-3.1-pro` 在扩大抽样中出现 2 次“HTTP 200、消耗 completion token、空正文 + stop”，工具调用约 4/6 成功。它本次单轮表格通过，但不应作为 miniQ 长任务默认模型。

## 通过文本与工具协议的模型

| 系列 | 模型 | 文本总耗时 | 工具总耗时 |
|---|---|---:|---:|
| Claude | `claude-haiku-4.5` | 1.70s | 2.18s |
| Claude | `claude-opus-4.5` | 2.30s | 2.40s |
| Claude | `claude-opus-4.6` | 2.46s | 3.79s |
| Claude | `claude-opus-4.7` | 2.26s | 2.36s |
| Claude | `claude-opus-4.8` | 2.82s | 2.68s |
| Claude | `claude-opus-5` | 2.00s | 3.53s |
| Claude | `claude-sonnet-4.5` | 2.14s | 2.43s |
| Claude | `claude-sonnet-4.6` | 5.70s | 9.54s |
| Claude | `claude-sonnet-5` | 2.57s | 2.43s |
| Auto | `codex-auto-review` | 1.85s | 3.81s |
| DeepSeek | `deepseek-v3.1` | 7.56s | 3.36s |
| DeepSeek | `deepseek-v3.2` | 9.28s | 5.13s |
| DeepSeek | `deepseek-v4-flash` | 1.74s | 2.17s |
| DeepSeek | `deepseek-v4-flash-vision-exp` | 1.81s | 1.87s |
| DeepSeek | `deepseek-v4-pro` | 3.01s | 2.25s |
| Gemini | `gemini-3-flash` | 1.61s | 1.20s |
| Gemini | `gemini-3.1-flash-lite-preview` | 1.57s | 1.24s |
| Gemini | `gemini-3.1-pro` | 4.65s | 4.74s |
| Gemini | `gemini-3.7-flash` | 2.57s | 2.81s |
| Gemini | `gemini-3.8-flash` | 2.09s | 2.49s |
| GLM | `glm-5.2` | 4.17s | 3.43s |
| GPT | `gpt-4o` | 1.46s | 2.03s |
| GPT | `gpt-5-nano` | 6.76s | 5.73s |
| GPT | `gpt-5.1` | 1.84s | 1.79s |
| GPT/Codex | `gpt-5.3-codex` | 2.37s | 5.24s |
| GPT | `gpt-5.4` | 1.74s | 2.71s |
| GPT | `gpt-5.4-mini` | 1.64s | 2.51s |
| GPT | `gpt-5.5` | 3.41s | 3.32s |
| GPT | `gpt-5.6-luna` | 1.74s | 3.36s |
| GPT | `gpt-5.6-sol` | 2.60s | 3.56s |
| GPT | `gpt-5.6-terra` | 2.27s | 3.29s |
| OSS | `gpt-oss-120b` | 3.20s | 1.76s |
| Grok | `grok-4.3` | 2.83s | 3.28s |
| Grok | `grok-4.5` | 2.62s | 2.85s |
| Grok | `grok-4.6` | 19.11s | 7.92s |
| Grok | `grok-build-0.1` | 2.95s | 3.57s |
| Kimi | `kimi-k2-thinking` | 2.74s | 6.19s |
| Kimi | `kimi-k2.5` | 1.76s | 5.36s |

单次耗时受上游排队影响。`grok-4.6` 的另外 3 次工具抽样为 3/3 成功，总耗时 3.19–4.72 秒；`gemini-3.7-flash` 与 `gemini-3.8-flash` 各追加 3 次，均为 3/3 成功。

## miniQ 当前推荐

长时间 agent 任务优先 `gpt-5.6-sol` / `gpt-5.6-terra` / `grok-4.6`；低延迟任务可用 `gpt-5.6-luna`、`deepseek-v4-flash`、`gemini-3.7-flash`。旧探针失败的型号应按其原生协议重新验证后再决定是否下线；尤其不能再根据 Chat Completions 失败把 Claude 模型直接判为不可用。

## miniQ 三协议兼容层（2026-09-04）

miniQ 不再把所有模型强制塞进 Chat Completions。设置中的“API 协议”默认使用 `auto`，也可以手动固定协议：

| 模型/协议族 | 首选入口 | miniQ 已处理的原生能力 |
|---|---|---|
| Claude | `/v1/messages` | `text`、图片、`tool_use` / `tool_result`、分片 `input_json_delta`、thinking/signature 原样回传、citations、流式错误和输出上限 |
| GPT、o 系列、Codex | `/v1/responses` | `input` / `output` items、图片、函数调用参数分片、并行函数调用、reasoning encrypted context 回传、refusal、incomplete/failed 终态 |
| Gemini、Grok、DeepSeek、GLM、Kimi 等兼容模型 | `/v1/chat/completions` | 文本、图片、现代 `tool_calls`、旧式 `function_call`、多调用参数合并和完整 SSE 终态校验 |

`auto` 会先读取 `/v1/models/{model_id}` 的 `preferred_api_protocol`。OneAPI 同时公开 `supported_api_protocols`，使客户端无需猜测自定义模型别名；元数据暂时不可用时，miniQ 才按 Claude、GPT/o/Codex 和其他模型族回退。设置页可手动选择 `anthropic_messages`、`responses` 或 `chat_completions` 以覆盖自动结果。

模型发起工具调用后，miniQ 会保存供应商原生上下文并在下一步完整回传。这样 Responses 的 reasoning items，以及 Claude 的 signed thinking 和 `tool_use` 内容块，不会在“工具执行 -> 返回结果 -> 继续回答”之间丢失。持久化前仍会递归清理工具参数中的 API Key、token、密码等敏感字段。

本地对照版本为 ChatGPT Desktop `26.810.41047` 和 Claude Code `2.1.234`。实现重点对齐这两类 agent 客户端依赖的流式事件、工具调用和跨轮上下文形态，而不是把客户端专属工具名映射成 miniQ 工具。

真实 miniQ daemon 端到端结果：

- `claude-fable-5` + `anthropic_messages`：模型调用 `file_read` 读取 `README.md`，工具成功，随后返回正确一级标题，`turn_completed`。
- `gpt-5.6-luna` + `responses`：模型调用 `file_read` 读取同一文件，工具成功，reasoning/function items 被保存，随后返回正确一级标题，`turn_completed`。

OpenAI Responses 的实现依据官方 [Function calling](https://developers.openai.com/api/docs/guides/function-calling) 和 [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) 文档：函数调用输出用 `call_id` 关联，推理模型的 reasoning items 与工具结果一起回传，并分别聚合 `response.output_item.*` 与 `response.function_call_arguments.*` 事件。

## 工具名兼容与故障恢复

OneAPI 背后的模型可能带有原供应商 agent 环境的工具先验，例如 Claude 系模型偶尔会尝试调用 `Bash`、`Read`、`Write` 或 `ToolSearch`。这些名称不是 miniQ 当前请求实际声明的工具；直接映射执行会绕过各工具自己的参数校验和风险语义，因此 miniQ 不做隐式别名执行。

miniQ 会在每次请求中明确要求模型只使用已声明工具及其精确名称。模型仍发出未知名称时，该调用会作为失败工具调用进入会话记录与审计，并返回 `unknown_tool`、原始名称、当前全部可用工具名和恢复说明，让模型在下一轮改用 `shell_run`、`file_read` 等实际工具。若同一错误调用持续重复，现有重复调用保护会终止循环并向用户报告，而不会假装工具通道整体失效。

OpenAI-compatible SSE 解析同时兼容 UTF-8 字符跨网络分片、LF/CRLF/CR 事件边界、多行 `data:`、旧式 `function_call` 和缺失调用 ID；流内错误、缺失函数名及不完整 JSON 参数都会在执行前明确失败。
