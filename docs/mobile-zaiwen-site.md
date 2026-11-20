# 手机端 miniQ / 在问切换

## 行为与架构

原生 iOS、Android 应用在顶部保留统一的平台切换入口。选择「在问」打开 `https://chat.zaiwenai.com/` 的真实页面；选择「miniQ」恢复原来的手机聊天或远程工作台。入口在尚未填写 miniQ API Key 时也可使用。

`App` 只为原生手机入口挂载 `MobilePlatformShell`。miniQ 页面保持挂载，切换期间隐藏并暂停其返回键监听，保留草稿和连接。外层复用桌面的 `PlatformSwitcher`、`PlatformMenu`，菜单打开和应用模态框显示期间隐藏原生主站视图。浏览器入口与桌面路由保持原有行为。

主站使用独立原生 WebView，不导航主 Capacitor 页面，不配置 `allowNavigation`。远程页面没有 Capacitor 消息处理器或 Android JavaScript interface，无法直接调用 miniQ 原生插件或读取 miniQ 设置。Cookie/网站存储由系统网页引擎管理，切换不销毁网页登录态。主站共用桌面 `zaiwen_site.js`，只在精确生产源的顶层页面隐藏艺术创作、发现和额外创作工具。

| 平台 | 主站网页引擎 | 本次变化 |
| --- | --- | --- |
| iOS | 独立 WKWebView；miniQ 主页面仍由 Capacitor 托管 | 新增主站切换、布局同步、网页历史返回和刷新 |
| Android | 独立 Android System WebView；miniQ 主页面仍由 Capacitor 托管 | 新增相同能力，返回键先关闭切换菜单，再返回网页历史，最后回到 miniQ |
| Windows | Tauri/Wry + WebView2 | 保持现有实现 |
| macOS | Tauri/Wry + WKWebView | 保持现有实现 |
| Linux | Tauri/Wry + WebKitGTK | 保持现有实现 |
| 普通浏览器 | 保持原有网页入口 | 不启用手机原生主站插件 |

## 原生能力边界

`MiniqZaiwen` 仅暴露 `update`、`getState`、`reload`、`goBack`。布局参数来自主页面的内容区域，按主 WebView 宽度换算原生坐标，排除顶部切换栏和底部安全区。旋转、视口变化、应用进出后台会重新同步布局。调用串行执行，避免切回 miniQ 后迟到的打开请求覆盖隐藏请求。网络错误、主文档 HTTP 错误、渲染进程终止或 30 秒加载超时会隐藏网页并显示重试入口。

导航接受没有 URL 凭据、使用默认端口或 443 的 HTTPS 地址，以支持 HTTPS 登录跳转；阻止 HTTP、文件、content、Capacitor、自定义应用协议等导航。新窗口链接在同一隔离视图处理，不提供独立弹窗与 `window.opener` 通信。

没有新增通用 DOM 读取、截图、合成输入、任意脚本执行接口或网络代理。手机插件不读取主站 Token，不接入桌面 SSO API Key 选择，不修改 miniQ API Key、模型设置或主站计费。手机原有账户流程继续使用原来的实现。

## 构建与验证

新增了原生插件，已有安装包不能仅靠前端热重载获得此功能。需要正常的前端构建、Capacitor 同步和原生重新编译安装。Vite 将共享脚本以根文件 `zaiwen_site.js` 输出，`cap sync` 再复制进两端的 `public` 资源目录。缺少插件的旧安装包会显示明确提示，并允许切回 miniQ。

前端和 Node 检查从 `apps/desktop` 执行。项目根和 backend 没有本任务使用的 Python/uv 工程，本任务没有执行 Python 命令。

```sh
npx vitest run --maxWorkers=4 src/mobileZaiwen.test.ts src/hooks/useMobileZaiwenView.test.tsx src/components/MobilePlatformShell.test.tsx src/components/MobileEntry.back.test.tsx src/App.test.tsx src/ConnectedApp.platform.test.tsx src/components/AppMenuBar.test.tsx src/components/MobileEntry.ui.test.tsx src/components/MobileEntry.ios.test.tsx src/components/MobileEntry.android.test.tsx
npm run test:mobile-zaiwen
npm run test:zaiwen-site
npx tsc --noEmit
```

macOS 上 `test:mobile-zaiwen` 还会通过 Swift 编译并执行 Foundation 导航策略测试；其他系统跳过这一项。原生接线测试检查插件注册、iOS Sources 和共享资源配置，不能替代原生 SDK 编译或真机测试。Android 策略测试位于标准 JUnit 测试目录，需 JDK/Android SDK 执行。

在使用 Node 26 的开发机上，运行 Vitest 时可设置 `NODE_OPTIONS=--no-experimental-webstorage`，避免实验性 Web Storage 影响 jsdom。构建产物可输出到临时目录，再逐字节比较输出的 `zaiwen_site.js` 和原始脚本。

目前本机缺少完整 Xcode、JDK 和 Android SDK，没有完成 iOS/Android 原生编译、模拟器或真机运行。后续应在设备上验证登录、键盘、安全区、旋转、后台恢复、切换和网络重试。Android 独立视图尚未接入文件选择器、摄像头或麦克风授权；依赖自定义协议、独立登录弹窗或 opener 回调的第三方登录暂不支持。

## 修改文件

- 入口和返回键：`apps/desktop/src/App.tsx`、`src/components/MobileAppearanceSheet.tsx`、`src/mobilePageActivity.ts`。
- 手机壳与桥接：`apps/desktop/src/components/MobilePlatformShell.tsx`、`MobilePlatformShell.css`、`src/mobileZaiwen.ts`、`src/hooks/useMobileZaiwenView.ts`。
- 共用切换器：`apps/desktop/src/components/PlatformSwitcher.tsx`、`PlatformSwitcher.css`、`AppMenuBar.css`。
- iOS：`apps/desktop/ios/App/App/MiniqZaiwenPlugin.swift`、`MiniqZaiwenPolicy.swift`、`MainViewController.swift`、`apps/desktop/ios/App/App.xcodeproj/project.pbxproj`。
- Android：`apps/desktop/android/app/src/main/java/com/leadingthink/miniq/MiniqZaiwenPlugin.java`、`ZaiwenNavigation.java`、`MainActivity.java`。
- 前端测试：`apps/desktop/src/mobileZaiwen.test.ts`、`src/hooks/useMobileZaiwenView.test.tsx`、`src/components/MobilePlatformShell.test.tsx`、`MobileEntry.back.test.tsx`、`src/App.test.tsx`。
- 平台测试：`apps/desktop/scripts/mobile-zaiwen.node-test.mjs`、`apps/desktop/ios/App/Tests/MiniqZaiwenPolicyTests.swift`、`apps/desktop/android/app/src/test/java/com/leadingthink/miniq/ZaiwenNavigationTest.java`。
- 构建及文档：`apps/desktop/vite.config.ts`、`apps/desktop/package.json`、本文、`docs/zaiwen-key-import.md`。
