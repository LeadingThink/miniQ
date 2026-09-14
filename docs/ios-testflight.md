# miniQ TestFlight 发布

miniQ 的 iOS 包由 `.github/workflows/ios-testflight.yml` 在 GitHub 的 macOS Runner 上签名，并直接上传 App Store Connect。工作流只允许手动触发，不会创建 Git tag、GitHub Release 或桌面更新。

## 前置配置

仓库 `Settings -> Secrets and variables -> Actions` 必须包含：

| Secret | 内容 |
| --- | --- |
| `IOS_CERTIFICATE_BASE64` | 含私钥的 Apple Distribution `.p12` 文件 Base64 |
| `IOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `IOS_APP_PROFILE_BASE64` | `com.leadingthink.miniq` 的 App Store 描述文件 Base64 |
| `APPLE_TEAM_ID` | Apple Developer Team ID，当前团队为 `W5M6Q4SAV7` |
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | App Store Connect API Issuer ID |
| `ASC_PRIVATE_KEY_BASE64` | App Store Connect API `.p8` 文件 Base64 |

API Key 至少需要能够上传构建；现有“App 管理”权限可以使用。不要把证书、密码、私钥或其 Base64 内容提交到仓库。

## 上传构建

1. 打开 GitHub 仓库的 `Actions -> iOS TestFlight -> Run workflow`。
2. `marketing_version` 填 App Store Connect 中的版本，例如 `1.0`。
3. `build_number` 填正整数。同一版本每次上传都必须大于以前的构建号，第一次可填 `1`，之后填 `2`、`3`。
4. 点击 `Run workflow`，等待工作流完成。成功表示 Apple 已接收 IPA，不代表 Apple 已处理完构建。

工作流会校验证书、Team ID、Bundle ID、App Store 描述文件和版本号，然后构建、签名并上传。IPA 和 dSYM 会保留为 GitHub Actions Artifact 14 天，日志保留 7 天。

## 在 TestFlight 中测试

上传成功后，App Store Connect 通常还需要数分钟到几十分钟处理：

1. 打开 `App Store Connect -> 我的 App -> miniQ -> TestFlight`。
2. 第一次上传可能要求回答出口合规问题；必须按应用实际使用的加密能力填写。
3. 在“内部测试”中创建群组，并选择已经处理完成的构建。
4. 在“用户和访问”中添加公司成员，再把成员加入内部测试群组。
5. 测试人员在 iPhone 或 iPad 安装 Apple 官方 TestFlight App，通过邀请邮件进入并安装 miniQ。

内部测试不要求先上传 App Store 商品页截图，也通常不需要 Beta App Review。外部测试需要单独建立外部群组、填写 Beta 测试信息并通过 Beta App Review。正式提交 App Store 审核时仍需补齐 iPhone 和 iPad 截图、隐私信息、年龄分级等资料。

## 常见失败

- `build number has already been used`：换成更大的 `build_number` 后重新运行。
- 描述文件校验失败：重新创建类型为 App Store、Bundle ID 为 `com.leadingthink.miniq` 的描述文件。
- 找不到 Apple Distribution identity：确认 `.p12` 导出时同时包含证书和私钥，并更新两个证书 Secrets。
- 上传成功但 TestFlight 暂时看不到：等待 App Store Connect 完成 Processing，并检查页面上的出口合规提示。
