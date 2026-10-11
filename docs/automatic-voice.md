# 语音输入自动选择

## 用户行为

保留一个麦克风按钮。没有识别后端选择器，也不要求用户下载模型。

Mac 桌面优先使用 Apple Speech framework 的本机流式识别。手机远程工作台和直接问答使用手机保存的 API Key，直接访问既有语音服务。手机音频不再经过中继或所选电脑。文字提交仍使用原有会话连接。

Windows、Linux 和非本机识别路径保留已有 API 转录。

## 实现

- `appleSpeech.ts` 与 `apple_speech.rs` 连接前端、Tauri 和 Swift。能力探测不申请权限。只有开始录音才申请语音识别权限。
- `AppleSpeech.swift` 使用 `SFSpeechRecognizer`，设置 `requiresOnDeviceRecognition = true`。没有使用 Apple 服务器识别，也没有添加第三方本地模型。
- 本次采用 SFSpeechRecognizer，未引入 macOS 26 专属的 SpeechAnalyzer。它满足本机增量转录需求，并覆盖更多系统版本。实际设备和语言不支持时自动使用 API。
- 录音仍由现有 Web Audio 管线采集。原生识别消费同一份 PCM，不再次打开麦克风。
- `AutomaticVoice` 保留完整音频。本地成功时不上传音频。本地启动、提交、识别或最终结果失败时，API 使用同一段录音；最终文本替换预览，不拼接两种后端的结果。
- 麦克风权限被拒绝时沿用权限引导，不能用 API 绕过录音权限。
- `mobileVoice.ts` 固定请求现有移动服务地址，不导出电脑密钥，不在鉴权失败后回退电脑。上传使用 WAV multipart，省去远程 RPC 的 base64 传输。
- 最终 API 请求对网络错误、429 和 5xx 最多尝试三次。预览不做密集重试。取消会中止请求和等待。
- `useSpeechInput` 单独处理输入能力，不改变已有朗读功能。手机直接问答复用已有模型目录，避免重复请求。
- Swift 代码有系统版本检查，Speech 框架使用弱链接。旧系统继续走 API。Windows/Linux 不编译 Swift。

## 生命周期与边界

本地启动等待最多 20 秒，PCM 提交等待最多 3 秒，最终结果等待最多 10 秒。原生会话还有 205 秒的释放保护，防止 WebView 重载后遗留识别对象。已有录音上限仍为 180 秒。

取消、组件卸载和会话切换均释放录音及识别对象。迟到的结果不写入其他会话。API 失败后保留录音供用户重试，不要求重新说一遍。

本地失败后会向用户已配置的 API 上传录音，符合自动回退策略；不能把本功能描述为“始终离线”。诊断不记录音频、转录文字和 API Key。

## 验证

- Mac 原生应用 debug 编译和链接通过。
- Swift Apple Silicon 和 Intel 目标编译通过，Intel 使用 macOS 10.13 部署目标验证兼容守卫。
- 二进制检查确认 Speech.framework 为 `LC_LOAD_WEAK_DYLIB`。
- 本机只读探测显示 zh-CN 和 en-US 支持本地识别，未触发录音或系统权限操作。
- 前端类型检查、生产构建通过。
- 输入框、语音及手机相关回归共 19 个文件、145 项通过。
- 自动协调器 7 项、路由 hook 3 项通过。
- macOS 录音权限配置检查 4 项通过。
- 语音接口针对 `capacitor://localhost` 的 OPTIONS 返回 204，允许 Authorization 和 POST。

尚未完成带真实麦克风的签名应用验收。不能据此宣称中文准确率、首次文字延迟或无网使用已经达标。iPhone、Android 真机录音和老版本 Intel macOS 的运行效果也需要后续设备验收。

本次只提交并合并代码，不调整版本号、不生成发布标签、不上传安装包。
