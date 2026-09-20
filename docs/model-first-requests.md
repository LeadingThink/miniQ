# 模型请求先发送 model

miniQ 0.1.43 在 HTTP JSON 序列化边界先写顶层 `model`，再写其他字段。JSON 规范不要求对象字段顺序；这是对当前 OneAPI 渠道路由只解析请求头部的兼容修复。无需等待服务端修改，也不依赖输入长度限制。

## 原因与证据

Rust 默认的 `serde_json::Value` 对象按键名排序，Responses 的 `input` 因而出现在 `model` 前面。包含图片或长历史时，渠道在有限前缀内无法读到完整输入及后面的模型字段，可能返回 `parse error: premature EOF`。仅在 `json!` 代码中把 `model` 写在第一行不能改变实际 HTTP 顺序。

2026-09-20 的真实 OneAPI 对照试验使用同一份 13,288,625 字节请求，唯一调整为顶层 `model` 前移；两份内容深度 JSON 比较相等：

| 请求顺序 | HTTP 结果 | 终止事件 | 用时 |
| --- | --- | --- | --- |
| 原键序，input 在前 | 500，premature EOF | 无 | 1.807 秒 |
| model 在前 | 200 | response.completed | 49.356 秒 |

成功调用模型为 `gpt-6-astra`，上游报告输入 44,287、输出 318 tokens。此请求从失败 checkpoint、8 张图片、24 对工具调用/结果和 45 个工具定义重构，较服务端原失败记录少 98 字节；原始 HTTP 报文已清除，因此这是完整重构请求的真实 A/B 验证，不能称原报文逐字节回放。模型返回的工具没有执行；私有输入、图片和凭据不进入仓库。本次复核了既有请求哈希、结果元数据与 SSE 完成事件，没有重复付费回放。

## 范围与数据保留

`miniq_models::ModelFirstRequest` 借用已有 JSON 值，并通过 `SerializeMap` 直接序列化到 HTTP 请求。它只调整根对象顺序，不复制或裁剪历史，不修改任何嵌套值，不修改模型、工具声明、图片、reasoning 密文、Claude 签名、采样参数或 token 限制。不得先将包装器转回 `Value` 再发送，否则排序会再次丢失。

- Responses、Chat Completions、Anthropic Messages 三个生产适配器统一使用它；任务、子 agent、重试、标题及上下文压缩沿用这些发送路径。
- 图片生成、语音合成、视频和音乐生成的 JSON 请求同样使用它。
- 图片编辑和语音识别使用 multipart，现有实现已把 `model` 放在第一部分。
- 移动端直接问答的 `JSON.stringify({ model, messages, stream })` 原本就是 model 优先；手机远程调用使用升级后的桌面 daemon。
- 通用 HTTP 工具保留调用者的原始请求，不擅自解析或重写第三方请求。

## 回归验证

自动化检查实际 HTTP 原始字节以 `{"model":` 开头，覆盖三个聊天适配器与四个多媒体 JSON 接口，同时验证正常 SSE 完成、鉴权头、输出参数及完整长文本。序列化回归另覆盖超过 1 MB 的多模态内容、Unicode/转义、工具调用、嵌套 model 字段和不含 model 的请求，确认转换前后内容及字节数相同。

这修复的是渠道前缀解析失败；不能将网络断流、上游过载或其他所有 HTTP 500 都归因为字段顺序。图片历史优化继续独立减少重复传输。
