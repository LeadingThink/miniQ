# 媒体生成参数与渠道刷新

miniQ 的图片、视频、音乐和语音合成工具使用配置的模型服务。聊天模型与媒体模型独立选择。

## 模型可见的参数契约

四类工具同时提供 JSON Schema 和按模型生成的简短说明。说明包含可用参数、范围、默认模型、条件要求和能力快照时间。Chat Completions 和 Anthropic 兼容层可能删除 `if/then`，所以条件要求也写入工具 description。Responses 保留完整 Schema。三种协议的最终 HTTP 请求体均有回归测试。

省略或传入 null 的 `model` 使用当前会话的配置默认值。默认模型不在渠道目录中时，使用能力目录中的可执行候选。显式指定不可用模型会报错，不会自动替换并提交付费任务。工具只公开已实现的执行参数。新协议或新参考素材类型仍需要适配代码。

模型的参数范围可能大于渠道通用范围。顶层 Schema 使用各模型范围的并集，按模型的条件分支保留具体范围。执行前按选中的模型校验。默认值先解析再校验，不再只校验用户显式传入的字段。

## 语音合成

`synthesize_speech` 调用 `POST /audio/speech`。当前默认模型是 `grok-tts`。

| 字段 | 当前 Grok 契约 |
|---|---|
| input | 非空文本，原样发送。渠道未公开确切字符上限 |
| model | 可省略，默认 grok-tts |
| voice | 当前 26 个音色，默认 eve |
| response_format | mp3 或 wav，默认 mp3 |
| speed | 当前只支持 1.0 |

Grok 的语音控制标签放在 input 中，不作为独立 API 字段发送。即时标签使用方括号，例如 `[pause]`、`[laugh]`、`[breath]`。包裹标签使用尖括号，例如 `<whisper>...</whisper>`、`<slow>...</slow>` 和 `<emphasis>...</emphasis>`。包裹标签必须正确匹配，嵌套时按相反顺序关闭。标签作用于完整短语，避免密集堆叠。普通括号文字保持为文字。

工具 Schema 包含全部当前标签及基线作用说明。已解析的渠道文档可以更新即时标签和包裹标签列表。miniQ 不把渠道页面的任意文字当成模型指令，只提取受限格式的字段和值。新标签的名称和闭合规则可刷新；新的语义或协议仍可能需要代码适配。

例如：

```text
你好，欢迎使用 miniQ。[pause] <soft><slow>我们一步一步来。</slow></soft>
```

语音工具按所选模型检查音色、格式、速度、文本长度和已知标签匹配。自定义 TTS 模型不继承 Grok 的音色和标签限制。未知范围交给渠道校验。音频读取上限为 64 MiB，支持取消。MP3 返回 audio/mpeg，WAV 返回 audio/wav。

渠道元数据中的 `max_duration` 是输出时长提示。`max_tokens` 不解释为字符数。本工具没有聊天朗读入口的 1500 字符界面限制。Gemini 原生 TTS 需要 generateContent，当前工具不宣称支持这个协议。

## 刷新范围和时机

能力获取增加 `models/details?model_type=audio_tts`、OpenAPI 的 `/audio/speech` 请求结构，以及在问文档 `docs/guide/api-audio` 的 Grok 合成章节。图片、视频和音乐保留原有目录与定义获取。

daemon 启动和运行期间检查缓存，TTL 为 24 小时。实际使用媒体工具时也检查是否需要刷新。应用关闭时不联网，下次启动补查。旧版缓存缺少 TTS 定义时会补抓。刷新失败保留上次成功快照并退避重试。模型收到的工具说明标明 stale 或 partial，不把缺失字段推断为已知范围。

每个 Agent step 和 tool_search 都重新装饰声明，主任务与子任务共享能力目录。已经开始的模型请求不会在中途改参数。实时更新是重新读取渠道公布的数据，不是渠道推送，也不自动增加未实现的 API 字段。

## 图片生成

在问的 GPT 图片模型通过 sub2api 转接 Codex。该链路忽略原生 `size` 和 `quality` 字段。

miniQ 保留这两个字段作为兼容输入。仅在已确认的在问 GPT 图片链路上，miniQ 把字段转换为 prompt 中的构图和质量说明，不再将它们作为上游控制参数发送。这是构图引导，不保证精确像素尺寸。其他图片渠道继续接收原生参数。

建议把目标画幅写进 prompt，例如：

```text
生成横版 16:9 产品海报。目标画布接近 1920×1080。保留左右安全边距。
```

## 视频生成

当前在问文档描述 `grok-imagine-video-1.5` 的范围：

| 字段 | 当前范围 |
|---|---|
| duration | 1–15 秒。省略时使用渠道默认值 |
| resolution | 480p、720p |
| aspect_ratio | 16:9、9:16、1:1、4:3、3:4、3:2、2:3 |
| image_path | 一张本地 JPEG、PNG 或 WebP 起始图 |
| reference_images | 1–7 张本地 JPEG、PNG 或 WebP 参考图 |

`image_path` 与 `reference_images` 不能同时使用。工具把授权范围内的本地图片转成 data URL。不会修改源文件。

MiniMax H3 使用独立接口 `/v1/videos/std/generations`。可选模型为 `minimax-h3-768p` 和 `minimax-h3-2k`。分辨率由模型 ID 决定。

| 工具字段 | H3 请求字段 | 当前范围 |
|---|---|---|
| prompt | prompt | 1–7000 字符 |
| duration | seconds | 4–15 秒。省略时使用 8 秒 |
| aspect_ratio | ratio | 21:9、16:9、4:3、1:1、3:4、9:16 |
| image_path | reference_images | 单张本地图片，映射为一张参考图 |
| reference_images | reference_images | 1–5 个 HTTP(S) URL 或本地图片路径 |
| reference_videos | reference_videos | 1–3 个 HTTP(S) URL 或本地视频路径 |
| reference_audios | reference_audios | 1–3 个 HTTP(S) URL 或本地音频路径 |

H3 上游引用仍使用 URL 字符串数组。miniQ 对授权的本地媒体先检查全部素材，再上传发送副本。`image_path` 与 `reference_images` 不能同时使用。源文件保持不变。H3 不接收 `resolution`。data URL 不受支持。

本地上传使用 `POST /miniq-relay/provider-media/ticket`。服务通过 OneAPI 的 `/v1/auth/key` 验证 Key。daemon 直接向七牛私有桶上传，不经过聊天 WebSocket，也不要求开启远程控制。只有 `https://oneapi.zaiwenai.com` 渠道启用此默认上传服务。自定义渠道继续使用已有 HTTP(S) URL，不把 Key 发送到默认服务。

本地限制为图片 20 MiB、视频 200 MiB、音频 50 MiB、单次总计 300 MiB。daemon 最多同时上传 2 个文件。服务每个账户每分钟预留最多 512 MiB。格式通过文件内容检查；这些本地限制不代表 H3 上游一定接受所有格式或大小。

对象使用独立 `provider-media/` 前缀。签名 GET 和 PUT URL 有效 15 分钟。链接持有者在有效期内可读素材，因此只将 GET 地址传给模型渠道。链接不作为工具结果输出；渠道返回的存储 URL 会被隐藏。桶配置一天删除规则，不在提交成功时删除，因为 H3 可能异步读取素材。取消和上传失败产生的对象也由生命周期清理。清理不是即时撤销。

2026-10-13 实测：私有桶签名 PNG 上传和回读均返回 200，内容哈希一致；匿名请求被拒绝；错误 MIME 的 PUT 返回 403；测试对象删除返回 200。本次没有提交付费 H3 视频任务。

保存 `generate_video` 返回的 `request_id` 和 `model`。调用 `get_video_generation` 时传入这两个字段。miniQ 会在工作区保存 H3 任务模型，省略 `model` 时可恢复协议。保存失败时结果仍返回任务 ID 和模型，不应重新提交。导入的任务需显式提供模型。渠道切换或模型冲突会在查询前报错。H3 轮询和下载使用独立的 std 路由。`queued` 和 `in_progress` 可以继续轮询。`completed` 下载视频，`failed` 停止轮询。H3 建议轮询间隔至少 20 秒。

渠道公开的新范围用于发送前校验。单个视频模型的 `max_duration` 只限制该模型，不取所有视频模型的最大值。Grok 与 H3 的限制独立生效。

## 音乐生成

初始默认模型为 `suno-v6`。渠道当前还提供 `suno-v6-mini` 和 `suno-v6-wild`。

| 字段 | 意义 |
|---|---|
| mode | simple 或 custom。省略时为 simple |
| prompt | simple 时为歌曲描述。custom 人声歌曲时为歌词 |
| instrumental | true 表示纯音乐。默认为 false |
| style | 自定义风格 |
| title | 歌曲标题 |
| negative_style | 要避免的风格 |
| vocal_gender | male 或 female |
| style_weight | 风格约束强度。当前范围 0–1 |
| weirdness | 创意程度。当前范围 0–1 |

simple 模式要求非空 prompt。custom 模式要求非空 style 和 title。custom 人声歌曲还要求非空歌词。custom 纯音乐可以省略或留空 prompt。

省略可选参数时，miniQ 不向上游发送无意义的 null 字段。

## 渠道能力刷新

daemon 启动后检查渠道缓存。运行期间主动检查刷新时间。配置渠道后唤醒检查。媒体工具调用也检查缓存，覆盖新配置或非默认会话渠道。

正常刷新间隔为 24 小时。应用关闭时不能刷新。下次启动时补充检查。

能力来源包括渠道的模型目录、模型详情、OpenAPI，以及已知渠道公开的媒体文档。每条约束保留来源。没有公开范围的字段保持未知，不通过付费生成试探范围。

缓存按渠道地址隔离，并持久化在 daemon 数据目录的 `cache/media-capabilities/`。缓存不包含 API Key。

刷新失败时保留上次成功数据。失败不更新成功获取时间。并发刷新共享同一项任务，避免重复请求。模型目录按分页读取，避免遗漏超过一页的模型。

模型工具说明与执行校验读取同一个能力快照。它们只使用当前工具已实现的字段。渠道新增了字段，并不代表当前客户端自动获得新的执行逻辑。

用户明确指定的模型不会被自动替换。已下线的模型会返回重新选择提示。未指定模型时，优先使用仍在目录里的默认模型；默认下线后从同一生成能力的目录选择可用模型。不会跨图片、视频、音乐能力选择模型，也不会把专用 Midjourney 路由当作普通图片接口。

能力目录展示已实现独立适配器的 H3 模型。未实现适配器的其他专用路由仍不可执行。H3 的原生 `seconds` 和 `ratio` 约束映射到工具的 `duration` 和 `aspect_ratio`。

## 查看刷新状态

只读 RPC `media.capabilities` 返回当前渠道缓存、获取时间、新鲜度和最近刷新错误。可选 `sessionId` 用于查看该会话实际使用的渠道。调用方不能通过此接口指定其他 URL 或凭据。

```json
{"method":"media.capabilities","params":{}}
```

该接口不发起媒体生成，不产生生成费用。

## 验证范围

自动测试使用本地假渠道。它们检查参数请求体、范围校验、Schema、每日缓存、分页、并发、离线缓存、配置切换和关闭流程。

真实渠道核验只读取公开目录、文档和能力定义。没有提交付费图片、视频或音乐生成任务。
