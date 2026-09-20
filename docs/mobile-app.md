# miniQ 移动 App

Android 与 iOS App 使用 Capacitor 8 封装现有移动工作台，网页入口继续保留在 `https://oneapi.zaiwenai.com/miniq/`。

## 能力与安全

- 移动问答直接调用在问 OneAPI，支持 SSE 流式回答。
- 每条移动问答消息都提供复制和删除操作。复制保留完整文字（含 Markdown）；仅含图片的消息没有可复制的文字。删除需确认，只移除选中的消息并更新本地历史，后续提问不再携带它；删除正在生成的回答也会停止该回答。
- 模型选择使用独立顶层弹窗，打开时背景问答不可操作，列表可搜索和滚动；兼容 iPhone/iPad 的键盘与安全区域。
- 移动问答支持从系统相册/文件选择器附加 PNG、JPEG、WebP、GIF 图片；图片会按 OpenAI 多模态 `image_url` 格式发送，重新打开历史仍保留图片上下文。
- 远程桌面通过 `wss://oneapi.zaiwenai.com/miniq-relay/ws` 控制桌面 miniQ。
- API Key 在 Android Keystore / iOS Keychain 中安全保存，不发送给 relay。
- 原生日志关闭，避免调试日志记录跨原生桥接的敏感参数。
- Android 系统返回键优先返回移动首页，再次返回时将 App 最小化。

## 构建

```bash
cd apps/desktop
npm run mobile:sync

JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./android/gradlew -p android assembleDebug
```

APK 输出在 `apps/desktop/android/app/build/outputs/apk/debug/app-debug.apk`。

iOS 工程位于 `apps/desktop/ios/App/App.xcodeproj`。安装完整 Xcode 后执行 `npm run mobile:ios`，在 Xcode 中选择 Apple Developer Team，再进行真机归档和签名。

通过 GitHub Actions 上传内部测试构建的配置和操作步骤见 [miniQ TestFlight 发布](ios-testflight.md)。内部 TestFlight 不要求先准备 App Store 商品页截图。
