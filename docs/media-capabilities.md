# 媒体生成参数与渠道刷新

miniQ 的图片、视频和音乐工具使用配置的模型服务。聊天模型与媒体模型独立选择。

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
| reference_images | reference_images | 1–5 个 HTTP(S) URL |
| reference_videos | reference_videos | 1–3 个 HTTP(S) URL |
| reference_audios | reference_audios | 1–3 个 HTTP(S) URL |

H3 引用使用 URL 字符串数组。渠道文档没有确认 data URL 或本地文件上传协议。miniQ 在提交前拒绝本地路径和 data URL。源文件保持不变。H3 不接收 `image_path` 或 `resolution`。

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
