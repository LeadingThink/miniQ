# Higgsfield API 使用要点

## 请求生命周期
1. `POST https://api.higgsfield.ai/<模型路径>`，JSON 请求体，认证头 `Authorization: Key <KEY_ID>:<KEY_SECRET>`。
2. 返回 `request_id`、`status`、`status_url`、`cancel_url`。
3. 轮询 `status_url`，状态流转大致为 queued → in_progress → completed / failed / nsfw / canceled（以官方文档为准）。
4. 完成后结果 JSON 中包含媒体链接；链接可能有时效，立即下载。

`scripts/hf_request.py` 已实现：提交 → 2 秒起、×1.5、上限 10 秒的带抖动退避轮询 → 保存结果 JSON → 下载所有媒体链接到 `--out`。

## 请求体准备
- 字段名以模型文档页为准（先读 `https://docs.higgsfield.ai/docs/llms.txt` 找到模型页）。常见字段：`prompt`、`aspect_ratio`、`image_url(s)`、`video_url`、`duration`、`seed`。
- 输入图片/视频必须是可公网访问的 URL；本地文件需先上传到用户有权使用的存储，或改用 MCP 的上传工具。
- JSON 用单引号包裹传给脚本；含中文与引号时建议先写入文件再 `"$(cat body.json)"`。

## 费用控制
- 提交即计费：先用 1 个请求试跑确认参数与效果，再批量。
- 批量时每个请求单独调用脚本、串行或小并发（≤3），记录 `request_id` 到台账，避免重复提交。
- 失败后**只重试状态查询**；生成失败需要重提时先告知用户会再次计费。

## 错误处理
| 情况 | 处理 |
|---|---|
| 401/403 | 凭据错误或无权限，停止，请用户检查环境变量 |
| 404（提交） | 模型路径写错，回文档核对 |
| 422/400 | 请求体字段错误，按返回信息修正 |
| 429 | 限流，等待后再提交，降低并发 |
| 5xx / 网络错误（轮询中） | 脚本自动退避重试 |
| `nsfw` | 内容被拦截，改写提示词或更换素材，不要原样重提 |
| 超时 | 稍后用保存的 `status_url` 继续查询，不重新提交 |

## 与频道流程配合
无出镜频道需要的“10 秒 5 镜头视频块”“音色锁定配音”等能力主要在 MCP 侧；API 适合补生成单张素材或单个视频块。生成结果按编号命名（如 `blocks/block07.mp4`）后交回原流程合成。
