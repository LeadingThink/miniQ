# 手机与桌面文件传输

文件传输沿用已认证的远程桌面连接。控制请求和签名地址通过现有加密 RPC 返回，文件字节通过单独的 `remote-files/` 私有对象命名空间传输；它不使用 provider-media 对象，也不接受客户端指定的下载 URL。

## 协议

本节说明 relay 的签名对象存储协议。SSH 主机的 `file.download.prepare` 返回连接分块描述符，具体字段及读取、释放接口见 [SSH 文件预览与下载](ssh-connections.md#ssh-文件预览与下载)。两者共用会话文件权限校验，客户端按目标连接选择传输协议。

此通道针对当前连接桌面的本地会话项目；它不是任意 SSH 主机的通用文件上传接口。每个文件最大 200 MiB。SHA-256 使用 64 位小写十六进制。上传保持所选 File 的原始字节，包含 HEIC；预览转换不能替换上传原件。系统照片选择器可能返回兼容格式，若必须保留相机原始 HEIC，应从系统文件选择器选取原件；此通道本身不做 JPEG 重编码。HEIC 能否直接预览取决于平台解码支持，不能预览仍可保存原文件。

- `file.download.prepare {sessionId,path,revision}`：验证会话文件权限与版本，流式上传到私有对象，返回 `{transferId,getUrl,expiresAt,size,sha256,revision}`。
- 上传范围（scope）：`file.upload.prepare`、`file.upload.commit`、`file.transfer.cancel` 与 `file.transfer.status` 必须**恰好提供** `sessionId` 或 `workspaceId` 之一；两者同时出现或都缺失返回 `InvalidParams`（“Specify either sessionId or workspaceId, not both” / “Specify exactly one of sessionId or workspaceId”），未知字段同样被拒绝。`sessionId` 保存到该会话工作目录的 `inbox/`；`workspaceId` 用于新会话尚未创建时，保存到该项目根目录的 `inbox/`，不会创建隐藏会话或伪造会话 ID。两种范围共用同一套目的地校验（规范化路径、符号链接与 `inbox` 逃逸拒绝、`.partial` 暂存、文件名规则、禁止覆盖）。传输记录按“调用手机 + 范围”隔离：用某一范围准备的传输，不能以另一个会话或项目提交、取消或查询。`file.download.prepare` 与 `file.transfer.status` 对下载仍只使用 `sessionId`。
- `file.upload.prepare {sessionId|workspaceId,name,size,sha256}`：为当前连接、调用手机和范围建立上传票据，返回 `{transferId,putUrl,expiresAt}`。对象存储命名空间对会话范围使用原 `sessionId`，对项目范围使用 `workspace:<workspaceId>`（只作为不透明的存储键，relay 无需变更）。
- 手机直接 PUT 原始文件，`Content-Type: application/octet-stream`。
- `file.upload.commit {sessionId|workspaceId,transferId}`：桌面从服务端保存的票据下载并校验大小与 SHA-256，完成收件后返回 `{status:"completed",path,size,sha256}`。PUT 成功不是桌面收件成功。
- `file.transfer.cancel {sessionId|workspaceId,transferId}`：请求停止未完成传输。客户端必须按终态显示完成或取消，不能把网络断开当作成功。
- 新会话页：手机端在已选择项目时用 `workspaceId` 上传，回执中的绝对路径作为附件路径随 `startTask` 发送（附件准备只要求可读的绝对路径，不要求属于某会话）。未选择项目时不提供上传，只保留“附加电脑上已有文件”的路径输入并提示先选择项目。上传永不自动发送消息。
- 小于等于 256 KiB 的文本预览仍使用 `file.read`；远程大文件和二进制文件使用对象传输。

签名地址过期时重新请求准备操作。不能向 daemon 传入通用 HTTP URL，也不能自行构造其他对象的访问票据。签名地址及 OSS 凭据不得记录到日志。

## 会话外单个文件确认

手机预览项目范围外、尚未作为会话附件保存的文件时，可通过当前已认证的加密连接请求一次明确确认：

- `file.access.request {sessionId,path}` 返回 `{requestId,path,expiresInSeconds:300}`。界面必须展示返回的规范化完整路径，再让用户确认或拒绝。
- `file.access.resolve {sessionId,requestId,allow}` 仅接受原手机、原会话和未过期的请求。确认期间文件内容、身份或符号链接目标变化，需要重新请求。
- 允许后，仅当前会话的远程 `file.describe`、`file.read` 和 `file.download.prepare` 可读取该文件；不授权父目录、相邻文件、Agent 工具、本地或 SSH 转发的 RPC。不能伪造 `origin` 获得此能力。
- 拒绝目录、路径跳转、网络共享、备用数据流、硬链接和敏感凭据/数据库/系统路径。此接口不会扩展项目根目录、写入永久权限或持久化附件。
- 每个 daemon 最多保留 8 个待确认请求和 32 个文件授权，超额明确失败。待确认请求在连接存续时由现有清理周期自动过期；授权持续至会话权限变更、会话删除或 daemon 退出。权限变更及会话删除会立即释放固定文件身份所占的句柄。同一文件可重新确认，不增加授权数量。

文件票据失败会提供稳定的 `error.data.reason`：存储未启用为 `file_storage_unavailable`，签名失败为 `file_storage_failed`，配额耗尽为 `file_budget_exceeded`（`retryAfterMs:60000`），连接中断或超时为 `file_connection_unavailable`，权限拒绝为 `file_ticket_forbidden`。这些运维失败不会再全部显示为用户参数错误。

## 原生保存

`MiniqFiles` 是应用内 Capacitor 插件。JavaScript 仅传入签名下载票据、大小、SHA-256 和显示文件名；不传文件内容或 Base64。

- Android：用 64 KiB 缓冲下载到私有缓存，校验后打开 `ACTION_CREATE_DOCUMENT` 系统文件选择器；完成写入及关闭输出后才返回 `saved`。失败时尝试删除目标端的不完整文档。用户取消返回 `cancelled`。选择器已打开时，应用取消会立即结束待保存回执；Android 的外部选择器仍需用户关闭，期间不允许再开启第二个选择器，迟到返回的新文档会尝试删除。
- iOS：`URLSessionDataDelegate` 流式写入临时文件并增量计算 SHA-256，校验后打开 `UIActivityViewController`。系统分享完成才返回 `shared`；取消返回 `cancelled`。iPad 设置弹出窗口锚点。
- 两端限制为一次原生保存、禁止 HTTP 重定向、拒绝超过声明大小的数据，并在完成或失败后删除缓存。应用上次被终止留下的文件在下次保存时清理。
- 原生保存失败不会回退到 WebView `<a download>` 并伪报成功。`shared` 表示系统活动报告完成，不保证第三方接收应用把文件同步到云端。

## 服务配置

必须先为 OSS 私有桶配置 `remote-files/` 前缀的一天自动删除生命周期，并使用现有允许房间列表。服务验证桶私有性和生命周期；失败时不能签发文件票据。签名有效期 15 分钟；每个房间/桌面的文件票据总量限额为每分钟 200 MiB，与 provider-media 的配额分开。部署和实际桶配置属于独立操作，此代码变更不会自动部署服务或修改桶。

此模式的临时文件内容在 OSS 中是私有明文字节，受私有桶及短时签名 URL 保护；不是文件级端到端加密。聊天与控制消息继续使用现有端到端加密。需要端到端加密文件对象的部署应另行定义分块加密格式及原生解密协议。

原生窗口、照片选择器、网络切换、应用后台/终止和设备存储不足仍需在实际 iOS 与 Android 设备上做验收；编译和单元测试不等价于设备验收。
