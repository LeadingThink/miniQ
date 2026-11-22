# 在问主站 API Key 选择

## 用户流程

1. 用户通过左上角进入「在问」，在原生嵌入网页中完成主站登录。
2. 主站加载完成后，miniQ 检测登录状态，并只读检查本机模型配置。主站已登录且 miniQ 没有任何服务的 API Key 时，预备选择框；通过左上角下拉框切回 miniQ 时立即在工作台中央显示选择框，再加载 Key 列表。在「在问」页面不弹框，顶栏不再显示选择按钮或配置提示。已有 API Key、未登录或当前是 SSH 工作区时不自动导入。
3. 打开选择框时原生层以主站 `token` 请求 `https://back.zaiwenai.com/api/v1/user/sso-ticket`，立即使用返回的 `redeem_url` 兑换一次性票据。界面在此期间显示加载状态，加载失败可直接重试。
4. 兑换必须返回指向官方平台的 302 和新登录 Cookie。Cookie 保存在本进程独立的 OneAPI 会话中，不覆盖设置页短信登录的会话。
5. 复用现有 OneAPI `/v1/keys` 协议，完整读取所有分页，展示该账户的全部 Key、名称和脱敏标识。已停用或过期的 Key 保留在列表中，标注状态并禁止选中。首次选择无论有一个还是多个有效 Key，均由用户明确选择后点击「保存」，不预选、不自动保存。没有可用 Key 时提供「创建并使用」，仅在点击后创建。读取列表本身不会创建或保存 Key。不会把主站 Token、SSO 票据或控制台 JWT 当作模型 Key。
6. 确认前重新加载完整列表，确认所选 Key 仍然有效，并核对主站会话。所选 Key 已删除、停用或过期时提示重新选择，不自动替换成其他 Key。保存前重新检查 miniQ 配置和主站会话，避免覆盖选择框打开期间已经配置的 Key。通过本机 `settings.update` 保存所选 Key、官方服务地址、共用默认模型与 `auto` 协议，不修改其他设置。
7. 保存成功后关闭选择框，立即刷新 miniQ 模型配置状态。以后切换不再自动弹框；更换 Key 使用原有模型设置入口。保存失败时保留选择并提示重试。

同一次进入 miniQ 期间、同一登录会话只自动打开一次，取消后不会反复弹出；尚未保存 Key 时，重新进入「在问」再切回 miniQ 会再次打开。退出登录或切换主站账号会清除旧列表和未确认的选择。已经保存的 miniQ Key 由 daemon 持久化，不随网页登录状态清除。

选择框显示在 miniQ 工作台上，原生主站网页保持挂载但隐藏，保留网页登录态和会话。取消或切回「在问」会中止当前操作并忽略迟到结果；已经发出的创建 Key 或设置写入请求无法保证撤销。

所选 Key 用于 miniQ 模型服务，不会向主站网页注入 Key，也不改变主站聊天的登录或计费方式。

## 平台能力

| 平台 | WebView | 主站 Key 选择 | 现有通用浏览器自动化 |
| --- | --- | --- | --- |
| Windows | Tauri/Wry + Edge WebView2 | 支持 | 导航、DOM、截图、合成输入 |
| macOS | Tauri/Wry + WKWebView | 支持 | 导航、DOM、截图、合成输入 |
| Linux | Tauri/Wry + WebKitGTK | 不支持读取主站登录态 | 原有受限能力不变 |
| iOS | Capacitor 主页面 + 独立 WKWebView 主站视图 | 支持主站切换；未接入桌面 Key 选择 | 现有主站导航、返回、刷新和显隐；无通用 DOM、截图或输入驱动 |
| Android | Capacitor 主页面 + 独立 Android System WebView 主站视图 | 支持主站切换；未接入桌面 Key 选择 | 现有主站导航、返回、刷新和显隐；无通用 DOM、截图或输入驱动 |
| 网页预览 | 浏览器中的跨域 iframe | 不支持跨域读取 | 无原生 DOM、截图或输入驱动 |

桌面 Key 选择没有新增通用跨域读取权限、浏览器自动化接口或不受限网络代理。两个原生命令仅接受主窗口调用；读取脚本只在专用主站视图、精确生产源和顶层页面读取 Token。界面只拿到用于检测变化的会话标记。独立 SSO 会话仅能读/创建 Key，每次请求前后均核对主站会话。

上述 SSO 用户流程属于桌面端。手机主站切换使用独立的有限导航插件，不包含这两个桌面命令，也不读取登录 Token 或修改 miniQ Key，详见 [手机端主站切换](mobile-zaiwen-site.md)。

## 边界与验证

- 当前仅接生产环境，测试环境域名不自动接受。
- SSO 关闭、过期、兑换失败或网络故障会提示重试/使用模型设置页登录，不自动读取其他已登录账号的 Key。
- 会话 Token、票据和 OneAPI Cookie 不传给界面、不写文件、不输出日志。列表只展示脱敏 Key；取消后清除列表，确认后完整 Key 通过现有 RPC 保存到 daemon 模型配置。
- 验证覆盖切回 miniQ 弹框、主站不弹框、单 Key 必须明确选择、重新进入、取消不写入、已有任意服务 Key 时不弹框、账号变化、取消迟到请求、保存错误及配置刷新，以及平台能力和原有设置回归。已有完整分页、SSO URL/过期/新 Cookie 契约测试保留。
- 自动化测试不使用真实账号，不申请生产票据；真实 SSO 登录仍需 Windows/macOS 实机验证。

## 主要实现文件

- `apps/desktop/src-tauri/src/zaiwen_sso.rs`、`zaiwen_sso_tests.rs`：原生 SSO 与协议测试。
- `apps/desktop/src-tauri/src/zaiwen_session.js`、`zaiwen_session.node-test.cjs`：受来源约束的会话读取与网页运行测试。
- `apps/desktop/src-tauri/src/account_transport.rs`、`browser.rs`、`lib.rs`：隔离账户会话、能力复用、命令注册；账户客户端创建前显式初始化 Rustls 加密提供器，避免首次网络请求 panic。
- `apps/desktop/src/zaiwenKeyImport.ts`、`zaiwenKeyImport.test.ts`：列表读取与 `importZaiwenKey` 确认校验、模型配置保存。
- `apps/desktop/src/hooks/useZaiwenKeyImport.ts`、`useZaiwenKeyImport.test.tsx`：登录与配置检测、选择框预备、列表加载、取消和重试。
- `apps/desktop/src/components/ZaiwenSite.tsx`、`ZaiwenSite.css`、`ZaiwenSite.test.tsx`：主站视图与加载状态。
- `apps/desktop/src/components/ZaiwenKeyDialog.tsx`、`ZaiwenKeyDialog.css`、`ZaiwenKeyDialog.test.tsx`、`apps/desktop/src/ConnectedApp.tsx`、`ConnectedApp.platform.test.tsx`：切换时弹框、Key 选择与配置刷新。
- `apps/desktop/src/desktopAccountKey.ts`、`desktopAccountKey.test.ts`：共享的完整分页读取及可用性判断；主站导入展示所有 Key，设置页原有登录流程继续获取一个可用 Key。
- `apps/desktop/src/components/DesktopAccountLogin.tsx`、`DesktopAccountLogin.test.tsx`、`apps/desktop/src/mobileIapAccount.ts`、`mobileIapAccount.test.ts`：复用原有账户协议，支持指定导入会话。
- `apps/desktop/src/providerDefaults.ts`、`apps/desktop/src/components/Settings.tsx`：共用服务地址、默认模型。
- `apps/desktop/src/hooks/useOpenDialog.ts`、`useOpenDialog.test.tsx`：识别原生 dialog 和现有组件的无障碍模态框，保护 WebView 层级。
- `apps/desktop/package.json`：把主站会话脚本测试加入现有定向测试命令。
