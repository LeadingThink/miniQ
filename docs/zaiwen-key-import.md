# 在问主站 API Key 选择

## 用户流程

1. 用户通过左上角进入「在问」，在原生嵌入网页中完成主站登录。
2. 每次切入「在问」且主站加载完成后，miniQ 检测登录状态，并只读检查本机模型配置。已配置在问服务地址和 API Key 时，顶栏显示「已使用miniQ配置的API Key」，无需等待主站登录，不自动弹框或读取账户 Key；仍可手动点击「选择在问 API Key」。没有配置在问 Key 时，等待主站登录后自动打开选择框。手动选择也直接打开同一个选择框，不经过说明确认页。
3. 打开选择框时原生层以主站 `token` 请求 `https://back.zaiwenai.com/api/v1/user/sso-ticket`，立即使用返回的 `redeem_url` 兑换一次性票据。界面在此期间显示加载状态，加载失败可直接重试。
4. 兑换必须返回指向官方平台的 302 和新登录 Cookie。Cookie 保存在本进程独立的 OneAPI 会话中，不覆盖设置页短信登录的会话。
5. 复用现有 OneAPI `/v1/keys` 协议，完整读取所有分页，展示该账户的全部 Key、名称和脱敏标识。已停用或过期的 Key 保留在列表中，标注状态并禁止选中。首次选择无论有一个还是多个有效 Key，均由用户明确选择后点击「保存」，不预选、不自动保存。没有可用 Key 时提供「创建并使用」，仅在点击后创建。读取列表本身不会创建或保存 Key。不会把主站 Token、SSO 票据或控制台 JWT 当作模型 Key。
6. 确认前重新加载完整列表，确认所选 Key 仍然有效，并在确认前后核对主站会话。所选 Key 已删除、停用或过期时提示重新选择，不自动替换成其他 Key。成功后只在前端内存中记录当前会话对应的 Key ID，显示「已选择在问 API Key」，不保存完整密钥，不调用 `settings.update`，不修改 miniQ 的服务地址、模型、协议或 API Key。
7. 顶栏按钮仍可打开全部列表。当前 Key 勾选并置灰，标注「当前已选」，禁止重复选择；其他有效 Key 可以选择。选中其他 Key 并确认后更新当前项；取消或失败时保留上一次选择。没有新选择时「保存」不可用。

用户可通过顶栏「在问」切换入口右侧的绿色「选择在问 API Key」按钮重新打开列表。按钮使用统一的主按钮组件，切回 miniQ 时隐藏。同一次进入期间、同一登录会话只自动打开一次，取消后不会反复弹出；尚未选择且没有本机在问配置时，重新进入会再次打开。成功选择后切换界面仍保留当前 Key ID，不自动重弹。退出登录或切换主站账号会清除旧选择。退出应用后不会保留本次选择。

选择框显示期间暂时隐藏原生网页，关闭后恢复，保留网页登录态和会话。取消或离开界面会阻止迟到的结果更新当前选择；已经发出的创建 Key 请求无法撤销。

「已使用miniQ配置的API Key」是本机已有官方服务 Key 的配置提示。参考主站源码中的聊天请求使用主站账户 Token，尚未提供使用所选 OneAPI Key 的接口。当前选择只记录界面状态，不会向网页注入 Key，不代表主站聊天已切换到该 Key，也不改变主站计费方式。若要真正使用所选 Key 进行主站聊天，需要主站提供对应接入协议；不能通过覆盖 miniQ 模型配置实现。

## 平台能力

| 平台 | WebView | 主站 Key 选择 | 现有通用浏览器自动化 |
| --- | --- | --- | --- |
| Windows | Tauri/Wry + Edge WebView2 | 支持 | 导航、DOM、截图、合成输入 |
| macOS | Tauri/Wry + WKWebView | 支持 | 导航、DOM、截图、合成输入 |
| Linux | Tauri/Wry + WebKitGTK | 不支持读取主站登录态 | 原有受限能力不变 |
| iOS | Capacitor + WKWebView | 未接入此桌面流程 | 未扩展；保留现有手机账户流程 |
| Android | Capacitor + Android System WebView | 未接入此桌面流程 | 未扩展；保留现有手机账户流程 |
| 网页预览 | 浏览器中的跨域 iframe | 不支持跨域读取 | 无原生 DOM、截图或输入驱动 |

没有新增通用跨域读取权限、浏览器自动化接口或不受限网络代理。两个原生命令仅接受主窗口调用；读取脚本只在专用主站视图、精确生产源和顶层页面读取 Token。界面只拿到用于检测变化的会话标记。独立 SSO 会话仅能读/创建 Key，每次请求前后均核对主站会话。本次修改没有改变原生平台能力。

## 边界与验证

- 当前仅接生产环境，测试环境域名不自动接受。
- SSO 关闭、过期、兑换失败或网络故障会提示重试/使用模型设置页登录，不自动读取其他已登录账号的 Key。
- 会话 Token、票据和 OneAPI Cookie 不传给界面、不写文件、不输出日志；完整 Key 仅在列表读取和确认校验期间存在，关闭选择框后只保留 ID。miniQ 原有模型配置继续由 daemon 存储。
- 验证覆盖当前项禁用、其他项可切换、单 Key、重新进入、取消保留旧选择、退出登录清空、选择/创建期间账号变化、取消迟到请求、无设置写入，以及平台能力和原有设置回归。已有完整分页、SSO URL/过期/新 Cookie 契约测试保留。
- 自动化测试不使用真实账号，不申请生产票据；真实 SSO 登录仍需 Windows/macOS 实机验证。

## 主要实现文件

- `apps/desktop/src-tauri/src/zaiwen_sso.rs`、`zaiwen_sso_tests.rs`：原生 SSO 与协议测试。
- `apps/desktop/src-tauri/src/zaiwen_session.js`、`zaiwen_session.node-test.cjs`：受来源约束的会话读取与网页运行测试。
- `apps/desktop/src-tauri/src/account_transport.rs`、`browser.rs`、`lib.rs`：隔离账户会话、能力复用、命令注册；账户客户端创建前显式初始化 Rustls 加密提供器，避免首次网络请求 panic。
- `apps/desktop/src/zaiwenKeyImport.ts`、`zaiwenKeyImport.test.ts`：列表读取与 `selectZaiwenKey` 确认校验，不写模型配置。
- `apps/desktop/src/hooks/useZaiwenKeyImport.ts`、`useZaiwenKeyImport.test.tsx`：登录检测、列表加载、独立选择状态、取消和重试。
- `apps/desktop/src/components/ZaiwenSite.tsx`、`ZaiwenSite.css`、`ZaiwenSite.test.tsx`、`apps/desktop/src/ConnectedApp.tsx`：入口与简洁 Key 选择界面。
- `apps/desktop/src/desktopAccountKey.ts`、`desktopAccountKey.test.ts`：共享的完整分页读取及可用性判断；主站导入展示所有 Key，设置页原有登录流程继续获取一个可用 Key。
- `apps/desktop/src/components/DesktopAccountLogin.tsx`、`DesktopAccountLogin.test.tsx`、`apps/desktop/src/mobileIapAccount.ts`、`mobileIapAccount.test.ts`：复用原有账户协议，支持指定导入会话。
- `apps/desktop/src/providerDefaults.ts`、`apps/desktop/src/components/Settings.tsx`：共用服务地址、默认模型。
- `apps/desktop/src/hooks/useOpenDialog.ts`、`useOpenDialog.test.tsx`：识别原生 dialog 和现有组件的无障碍模态框，保护 WebView 层级。
- `apps/desktop/package.json`：把主站会话脚本测试加入现有定向测试命令。
