# WorkBuddy 只读审计

审计范围：截至本报告生成时，只读检查了已安装的 Electron 应用 `/Applications/WorkBuddy.app`，重点证据来自 `/Applications/WorkBuddy.app/Contents/Resources/app.asar` 内的打包 renderer/CLI 条目。未启动应用，未读取 `.env`、密钥、token 模块或用户数据，未修改任何项目文件。

## 证据边界

本机在已检查位置没有找到 WorkBuddy 的源码仓库，也没有找到可归属于 WorkBuddy 的 `app/` Expo 前端或 `web/` 主站源码。因此，本报告不能证明 WorkBuddy 存在 Expo app/web 主站实现，也不能用其他项目的同名目录补齐结论。

明确属于其他项目的路径：

- `/Users/xuzhanwei/Desktop/projects/zaiwenai/app`：这是 zaiwenai 项目的 Expo/移动端目录，不是已安装 WorkBuddy 的证据。
- `/Users/xuzhanwei/Desktop/projects/zaiwenai/web`：这是 zaiwenai 项目的主站目录，不是已安装 WorkBuddy 的证据。
- `/Users/xuzhanwei/Desktop/projects/meeting/miniQ/apps/desktop`：这是 miniQ 自己的 Tauri/React 桌面端源码，只用于最后的对照建议，不是 WorkBuddy 的实现。

## 1) 可观察功能

从安装包静态代码可以确认以下产品机制存在于打包前端；静态证据不能单独证明线上配置、后端接口或每个运行分支一定成功：

- 主窗口导航可处理 home、conversation、genie、experts、skills、connectors、space-library、settings、logout 等路由，并支持跨窗口投递。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/main-window-navigation-BAerSk_t.js`，`routeHandlers`、`isNavigationDelivery`、`applyMainWindowNavigation`。
- 会话路由能区分 cloud 与本地 transport，并在需要时标记 `needsSessionRestore`。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/conversation-route-redirect-DxSxkUem.js`，`resolveProjectConversationRoute`。
- 会话流支持按 session 累积文本、工具调用和父工具关系，能从已有 assistant 消息重建累积状态。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/acp-message-accumulator-XU4j3vGr.js`，`ACPMessageAccumulator`、`hydrateFromAssistantMessage`。
- 对断线/连接关闭有有限重试；明确离线时短路，默认最多三次、按 500ms × attempt 等待。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/stale-conversation-status-writeback-C7oHb3cc.js`，`runAcpConnectionRetry`。
- 打开历史会话时，若列表认为仍运行而权威历史已终止，可推导 completed/failed 的过期状态修复目标。
  - 证据：同上，`resolveStaleConversationWriteback`。
- 技能可以启动新任务并注入 skill 名称、示例文本、展示文本和 skillId；从 office 独立窗口返回时可向原会话投递结果。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/use-try-skill-BnsrWXWi.js`，`useTrySkill`。
- 文件上传队列区分 success、error、cancelled、conflict、pending、uploading 等状态，批量完成回调会等待队列进入终态。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/upload-queue-store-BqjhaMAJ.js`，`isFinalState`、`flushCompletedBatches`、`AbortController`。
- 自动化收件箱区分运行中、失败、部分交付、仅副作用和已交付，避免仅用 `success:false` 把未完成项目显示为失败。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/automation-panel-CPyRlvr5.js`，`isInboxRunningItem`、`isInboxDeliveredLike`、`InboxDetailStatusClass`。
- HTML 预览默认使用 sandbox iframe、`srcDoc`、无 referrer，并限制 same-origin/top-navigation/downloads；兼容路径使用 strict sanitizer 和 CSP 约束。
  - 证据：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/PreviewIframe-Q-w_16tm.js`，`HtmlPreview`。

## 2) 关键交互模式与代码位置

- **跨窗口导航集中分发**：独立窗口只投递 route，主窗口由 `routeHandlers` 决定 hash、deep link 或 DOM 事件；未注册 route 进入统一 adapter。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/main-window-navigation-BAerSk_t.js`。
- **来源约束的返回意图**：`resolveTrustedOfficeReturn` 要求 origin 为 `office`、返回窗口 ID 以 `window:office:` 开头，并检查返回会话字段。位置同上。
- **异步结果身份保护**：页面导航/查询返回后检查 `cancelled`，清理时设置取消标记；创建预览另使用 `location.key` 隔离。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/conversation-RTAhhkkk.js`。
- **深链门控与有界去重**：`useDeepLinkNavigation` 先检查 shell view 是否允许，再以最多 200 项的 `deeplinkId` 集合去重。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/app-shell-B-SpaaE8.js`。
- **输入/预览安全边界**：HTML 预览明确区分 sandbox 路径与兼容 fallback 路径；默认路径不授予 `allow-same-origin`，fallback 依赖 strict 清洗。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/PreviewIframe-Q-w_16tm.js`。
- **上传批次收尾**：上传 item 由 AbortController 关联取消；只有所有 item 到达终态，或被明确移除后，才触发批次完成。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/upload-queue-store-BqjhaMAJ.js`。
- **自动化结果表达**：运行中、部分完成和副作用已发生被分别表达，详情页根据 `resultState` 选择状态。位置：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/automation-panel-CPyRlvr5.js`。

## 3) 值得借鉴的机制

1. **把导航变成受控协议**：使用有限 route 注册表、统一分发器和来源元数据，减少独立窗口各自实现跳转造成的状态漂移。可借鉴 `main-window-navigation-BAerSk_t.js` 的 `routeHandlers` 结构。
2. **异步操作绑定身份**：请求返回前检查会话/页面身份，避免旧会话的查询、附件或预览结果写入当前会话。可借鉴 `conversation-RTAhhkkk.js` 的 cancelled 清理模式；miniQ 的草稿和附件已有相近基础。
3. **状态修复必须有双重条件**：只有“列表显示运行中”且“权威历史已终止”时才修复状态，避免普通刷新误写。可借鉴 `resolveStaleConversationWriteback`。
4. **上传/自动化使用细粒度终态**：把 conflict、cancelled、partial_delivered、side_effect_only 分开，让用户知道是否需要重试、是否已经产生外部影响。可借鉴两个对应打包模块。
5. **HTML 预览默认隔离**：将 sandbox、strict sanitizer、CSP 和 fallback 作为同一安全设计，并明确不授予 same-origin、top-navigation、downloads。可借鉴 `PreviewIframe-Q-w_16tm.js` 的边界说明。
6. **技能试用携带上下文**：技能入口把 skillId 和示例输入一起交给新任务，降低用户从技能页到会话页的上下文损失。可借鉴 `useTrySkill`。

## 4) 不应照搬的部分

- **不要把前端深链去重当作授权或恰好一次保证**：200 项集合只是 UI 级内存去重，不能替代 miniQ daemon 的权限、幂等键和审计。证据：`app-shell-B-SpaaE8.js`。
- **不要直接照搬文本启发式流合并**：`ACPMessageAccumulator` 会按“相同/前缀/追加”推断 chunk 关系；在协议已有明确 delta 语义时应使用显式序号或事件 ID，否则可能吞掉合法重复文本。
- **不要把“取消标记”误认为真正中止请求**：`conversation-RTAhhkkk.js` 的 cancelled 主要防止旧结果落地；miniQ 仍应在 Rust/daemon 侧传递取消和回收工具执行。
- **不要无条件重试所有 AbortError/connection closed**：WorkBuddy 代码的错误字符串模式包含 abort 类错误；miniQ 要区分用户主动取消、超时、断网、服务端失败，避免重复副作用。
- **不要用 WebView fallback 的 same-origin `doc.write` 作为默认预览方案**：该路径安全完全依赖 strict sanitizer/CSP；只应在明确的兼容约束下使用，并保留可验证的白名单。
- **不要扩大本地文件权限来追求预览便利**：已读的 WorkBuddy 安装包中，文件预览相关代码存在父目录访问扩展逻辑的迹象；miniQ 应继续坚持工作区约束和单文件显式授权。
- **不要把安装包的模块名当作完整产品能力证明**：没有源码、后端和运行时观测时，只能报告静态代码展示的机制，不能断言接口送达、重连最终成功或云端功能可用。

## 5) 对 miniQ 的具体建议（按优先级）

### P0：优先补强可靠性与安全边界

- 为会话事件、工具调用和审批建立明确的事件序号/幂等键；UI 只接受当前 session/revision 的事件，daemon 负责最终一致性。参考：`/Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/assets/acp-message-accumulator-XU4j3vGr.js`。
- 将“用户取消”“网络离线”“连接关闭”“执行超时”“部分交付”建成协议级状态，禁止用一个 failed 覆盖所有结果。参考：`stale-conversation-status-writeback-C7oHb3cc.js` 与 `automation-panel-CPyRlvr5.js`。
- 对 HTML/Markdown/Office 预览继续保持最小权限：sandbox、CSP、路径沙箱和用户可见的外部文件授权必须在 daemon/原生层同时执行，不能只依赖 React 状态。
- 为跨窗口/远程控制的导航消息加入不可伪造的来源绑定、过期时间和一次性幂等标识；前端 route 注册表只做路由，不做授权。

### P1：提升会话与文件交互

- 在 Composer 和附件队列中统一展示 pending、uploading、conflict、cancelled、success、error，并提供逐项重试/取消；批次完成只在所有项终态后触发。
- 为切换会话、切换 workspace、关闭预览增加 revision 检查和取消传播，避免迟到的文件读取、语音转写或工具事件写入新上下文。
- 在会话历史页增加“列表状态与权威事件不一致”的自动修复，但只在双条件满足时写回并记录审计事件。

### P2：提升技能与自动化体验

- 技能入口启动任务时同时传 skillId、版本、示例输入和来源，生成可审计的上下文块；失败时展示“技能加载失败/任务失败/部分产物已生成”的区别。
- 自动化任务详情按 delivered、partial_delivered、side_effect_only、failed、interrupted 分类；对已经产生副作用的任务提供继续、补偿或人工检查入口。
- 可以引入受控的主窗口 route registry 和深链去重，但把去重上限、过期清理和失败重放策略写入协议/存储，而不是只放在 React 内存。

## 静态审计限制

结论来自打包 JavaScript 的静态读取，未启动 `/Applications/WorkBuddy.app`，没有观察真实 UI，也没有访问 WorkBuddy 的用户数据库、网络响应、账户内容或本地用户项目。已安装包内没有可供本次审计确认的 `app/` Expo 源码和 `web/` 主站源码；因此关于 Expo/web 的结论是“证据缺失”，不是“功能不存在”。
