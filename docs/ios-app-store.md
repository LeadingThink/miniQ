# iOS App Store Connect 自动化

工作流位于 `.github/workflows/ios-app-store.yml`，通过手动触发运行，默认操作是 `inspect`。它使用已有的 `ASC_KEY_ID`、`ASC_ISSUER_ID` 和 `ASC_PRIVATE_KEY_BASE64` secrets；密钥只在 GitHub runner 的进程环境中使用，脚本不会打印 JWT、密钥或 Apple 的原始错误响应。

## 操作顺序

先用 `inspect` 输入目标 marketing version。脚本会读取 iOS 商店版本、已上传 build、处理状态、过期状态、出口合规声明、当前选中 build、审核提交状态，并给出该版本范围内的最大 build 与下一个未使用 build。输出只包含可审计的摘要。

`prepare` 需要人工提供已经审核过的简体中文 `whats_new`。它幂等创建目标版本（首个审核版本保持 `1.0`），只写入 `zh-Hans` 的 whatsNew，并在写入后重新读取确认。截图、隐私、年龄分级、出口合规、审核联系方式等其他资料仍须在 App Store Connect 中人工核对。

`submit` 必须同时勾选“已在真实 iPhone/iPad 验证”和“已核对所有商店资料”，并提供精确 build。脚本会重新检查 build 属于正确 app、版本和 iOS 平台，确认 build 为 `VALID`、未过期、出口合规已解决，再选择 build、建立审核项目，并在正式提交前再次读取全部关键状态。任何状态不确定或 API 请求结果未知都会停止，不自动重试。

`release` 只处理已经通过审核、状态为 `PENDING_DEVELOPER_RELEASE` 且 release type 为 `MANUAL` 的版本。Apple API 对“立即发布”的支持可能随版本变化；脚本会遵循 API 返回结果并把无法执行的限制写入日志，不把 TestFlight 上传或审核通过误报为已上线。

## 安全边界

- 默认只读；所有写操作必须显式选择 `prepare`、`submit` 或 `release`。
- 不接受协议，不代填隐私或年龄声明，不生成审核凭证，不修改截图和其他 metadata。
- POST/PATCH 失败或网络超时后不会自动重发；应先重新运行 `inspect` 确认 Apple 的实际状态。
- 版本和 build 必须由发布负责人指定。build 不能复用，失败上传也应重新检查已占用的号码。

本地 mock 测试：

```sh
cd apps/desktop
node --test scripts/ios_app_store.node-test.mjs
```
