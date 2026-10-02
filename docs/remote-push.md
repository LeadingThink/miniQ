# miniQ 手机离线推送

开启“移动端与远程桌面”后，手机 App 即使在后台或已被系统挂起，也能收到桌面任务的系统通知。与远程桌面的链路相同，推送内容端到端加密，relay 和推送厂商都看不到明文。

## 用户能力

- **任务完成**：通知标题为会话名称。耗时少于 10 秒的任务不推送。
- **任务失败**：通知中附带截断后的错误摘要。
- **需要我操作**：任务等待审批或回答问题时推送。如果是审批，可以直接在通知上点“批准 / 拒绝”。
- **桌面离线**：桌面与 relay 断开超过 5 分钟（relay 可配置）时提醒一次。
- **点击通知**：打开 App，并跳转到对应会话。
- **免打扰时段**：在手机本地时区设置开始和结束时间。时段内通知静默送达，不响铃、不横幅打扰。
- **前台去重**：手机 App 在前台可见时，relay 不发系统推送，只显示 App 内的 TaskBanner 横幅。
- **角标**：iOS 与 Android 都显示未读任务数，打开 App 后清零。
- **保持唤醒**：远程访问开启且已配置 API Key 时，daemon 会阻止电脑空闲休眠，让手机始终能连上。屏幕仍可以关闭；合盖或手动选择“睡眠”时，电脑照常休眠。

设置入口：手机 App →“设置”→“任务通知”。在这里可以选择通知类型，开关“需要我操作时提醒”，设置免打扰时段，并查看推送注册状态（RemotePushStatusRow）。桌面端的同一页面只显示桌面系统通知开关：“需要审批时提醒”“需要我回答时提醒”。

## 链路

```text
桌面 daemon                       relay                          APNs / JPush            手机
  | 事件 -> PushTracker             |                                  |                    |
  | AES-256-GCM(标题/正文) -------->| push{kind, collapseId, 密文}     |                    |
  |                                 |-- 跳过前台在线设备 ------------->|-- 系统推送 ------->|
  |                                 |   按 kinds / 免打扰过滤           |                    | NSE / Receiver 本地解密
```

- daemon 的 `remote/push.rs` 决定哪些事件值得推送：TurnCompleted、TurnFailed、ApprovalRequested、QuestionRequested。标题、错误和审批信息都用房间 AES key 加密后才交给 relay。
- relay 只知道粗粒度的 `kind`（用于决定通知的打断级别）和不透明的 `collapseId`。
- iOS 通过 Notification Service Extension（`MiniqNotificationService`）解密。房间密钥经 App Group `group.com.leadingthink.miniq` 与 Keychain 共享给扩展。Android 由 `MiniqPushNotifier` 在本地解密。
- 每个房间最多登记 8 台设备，每分钟最多推送 60 条。APNs 返回无效 token 时，对应登记会被自动删除。

## Relay 配置

推送是可选能力。没有配置对应厂商时，手机注册会收到 `enabled=false`，设置页显示“推送未启用”，其他功能不受影响。

| 环境变量 | 说明 |
| --- | --- |
| `MINIQ_APNS_KEY_PATH` / `MINIQ_APNS_KEY` | APNs Auth Key（`.p8`）的文件路径或内联内容，二选一 |
| `MINIQ_APNS_KEY_ID` | APNs Key ID |
| `MINIQ_APNS_TEAM_ID` | Apple Team ID |
| `MINIQ_APNS_BUNDLE_ID` | 默认 `com.leadingthink.miniq` |
| `MINIQ_JPUSH_APP_KEY` / `MINIQ_JPUSH_MASTER_SECRET` | 极光推送凭据，两者都配置后才启用 Android 推送 |
| `MINIQ_JPUSH_PRODUCTION` | 默认 `true`；设为 `false` 时使用开发环境 |
| `MINIQ_PUSH_REGISTRY_FILE` | 设备登记的持久化文件；不设置则只保存在内存，relay 重启后需要手机重新注册 |
| `MINIQ_DESKTOP_OFFLINE_PUSH_MINUTES` | 桌面离线多久后推送提醒，默认 5 分钟 |

APNs 根据手机上报的 `environment` 自动选择 sandbox 或 production 网关。上述凭据只能放在服务器的 systemd 环境文件中，不要提交到仓库。

## 构建配置

### iOS

- App 和 NSE 两个 target 都需要 App Store 描述文件：`com.leadingthink.miniq`、`com.leadingthink.miniq.MiniqNotificationService`。两者都必须启用 App Group `group.com.leadingthink.miniq`，App 还要启用 Push Notifications。
- TestFlight 工作流新增 Secret `IOS_NSE_PROFILE_BASE64`，内容是 NSE 描述文件的 Base64。工作流会校验归档中包含 `MiniqNotificationService.appex`，并确认 App 以 `aps-environment=production` 签名。

### Android

- JPush 集成在可选的 `:miniq-jpush` 模块中。只有配置了 app key 才会参与构建，来源可以是以下任意一种：环境变量 `MINIQ_JPUSH_APPKEY`、`-PminiqJpushAppKey=...`，或者 `local.properties` 中的 `miniqJpushAppKey=...`。未配置时构建出的 APK 不含极光 SDK，App 内通知照常工作。
- Android 13 及以上版本，首次开启推送时会请求 `POST_NOTIFICATIONS` 权限。

## 排查

- 设置页显示“推送未启用”：检查 relay 是否配置了对应平台的凭据。
- iOS 能收到通知但显示的是占位文案：说明 NSE 没能解密。检查 NSE 的 App Group 与 Keychain 共享配置，并确认 App 在前台至少成功连接过一次桌面，以便写入房间密钥。
- 某条通知一直没收到：先确认手机当时不在前台（前台只显示 App 内横幅），也不在免打扰时段，并且该通知类型已在设置中启用。
