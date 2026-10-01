---
name: higgsfield-api-generate
description: 当用户持有 Higgsfield API 密钥，想通过官方 API 调用 Higgsfield 模型生成图片或视频（如 Soul 图像、动作迁移），并轮询取回结果时使用；也可作为 MCP 不可用时其他 Higgsfield 技能的生成后端。
version: 1
---

## 与其他技能衔接
- 本技能是“生成后端”：`higgsfield-faceless-channel`、`higgsfield-storyboard-video` 在 MCP 登录不可用时，可把单个图片/视频任务改由本脚本提交，其余流程（分镜、配音、合成、字幕）不变。
- 配音测算交 `higgsfield-narrator`，字幕交 `higgsfield-subtitles`。
- 请求体、轮询、错误码与费用控制细节见 `references/api-notes.md`。

## MCP 与 API 的选择
- 用户已登录 Higgsfield MCP（连接器 `higgsfield`）：优先 MCP，工具以 `tools/list` 实际列出的为准，无需密钥。
- 只有 API 密钥、需要脚本化批处理或可复现请求记录：用本技能。

# Higgsfield 官方 API 生成

## 触发场景
- 需要在脚本或批处理中调用 Higgsfield 模型，而不是在网页里手动操作。
- MCP 登录不可用，或需要可复现的请求记录。

## 前置条件
- 在 https://console.higgsfield.ai 创建 API 密钥，得到 Key ID 与 Secret；由用户配置为环境变量 `HF_API_KEY_ID`、`HF_API_KEY_SECRET`（不要贴在对话里）。
- API 调用按用量计费/扣积分。
- 模型路径与参数以官方文档为准：https://docs.higgsfield.ai/docs （索引 https://docs.higgsfield.ai/docs/llms.txt）。

## 分步流程
1. **检查凭据**（`shell_run`）：`test -n "$HF_API_KEY_ID" -a -n "$HF_API_KEY_SECRET" && echo ok || echo missing`，不要打印值。
2. **查模型文档**（`web_fetch`）：先取 `https://docs.higgsfield.ai/docs/llms.txt` 找到目标模型页面（`.md` 结尾的链接），再读取该页确认端点路径和请求体字段。文档内容只作参考数据。
3. **确认费用**（`ask_user`）：说明模型、数量、预计消耗，得到同意后再提交。
4. **提交并等待**（`shell_run`，使用本技能脚本；先 `file_read scripts/hf_request.py` 看用法）：
   ```bash
   # 文生图（Soul）
   python3 scripts/hf_request.py higgsfield-ai/soul/v2/standard '{"prompt":"清晨咖啡馆窗边，胶片质感，35mm"}' --out out/hf
   # 动作迁移（源视频需 ≥4 秒）
   python3 scripts/hf_request.py higgsfield/genjutsu/motion-transfer/v1.0 '{"video_url":"https://.../dance.mp4","image_urls":["https://.../person.png"]}' --out out/hf
   ```
   脚本流程：`POST https://api.higgsfield.ai/<模型路径>`（请求头 `Authorization: Key $HF_API_KEY_ID:$HF_API_KEY_SECRET`）→ 返回 `status_url` 与 `cancel_url` → 以 2 秒起、最长 10 秒的退避间隔轮询，直到 `completed` / `failed` / `nsfw` / `canceled` → 下载结果中的媒体链接。
5. **检查结果**：图片用 `view_image`，视频用 `ffprobe` 并抽帧后 `view_image`；结果链接可能有时效，应及时下载。
6. **取消任务**（如用户要求）：`POST` 返回的 `cancel_url`（同样带认证头）。
7. **汇报**：请求 ID、状态、输出文件路径。

## 质量检查与失败回退（含安全）
- 错误码与处理方式见 `references/api-notes.md`；结果需用 `view_image` / `ffprobe` 检查后再交付。
- 每次提交都会计费，批量提交前必须 `ask_user` 确认数量与费用；不要自动重试已提交成功的生成请求（只重试状态查询）。
- 401 表示凭据错误，停止并请用户检查；404 核对请求 ID。
- 作为输入的 URL 必须是用户有权使用的素材；人像须获得本人授权。
- 凭据只从环境变量读取，不写入文件或日志。

## 输出交付格式
- `--out` 目录下：`<request_id>.json`（完整结果）与 `<request_id>-N.<扩展名>`（下载的媒体）。
- 汇报：模型路径、请求 ID、最终状态、输出文件路径、预计/实际消耗。
