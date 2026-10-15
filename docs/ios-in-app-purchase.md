# iOS App 内购买配置与验证

当前流程：入口手动填写在问 API Key → 没有 Key 时进入手机号登录 → Apple 消耗型购买充值到共用 OneAPI 账户 → 手动创建、复制 Key → 返回入口粘贴。网页创建的 Key 继续可用，不需要为了使用已有 Key 再次购买。

后端具体接口、验签和账本要求见 [后端交接文档](ios-iap-backend-handoff.md)。不使用订阅、独立 miniQ 钱包或专用模型代理。

## App Store Connect 配置

应用 Bundle ID：`com.leadingthink.miniq`。

在 App Store Connect → miniQ → 营利 → App 内购买项目，创建「消耗型」商品，不需要订阅组。

| Product ID | 固定人民币到账额度 |
|---|---:|
| com.leadingthink.miniq.credits.5 | ¥5 |
| com.leadingthink.miniq.credits.10 | ¥10 |
| com.leadingthink.miniq.credits.20 | ¥20 |
| com.leadingthink.miniq.credits.50 | ¥50 |
| com.leadingthink.miniq.credits.100 | ¥100 |
| com.leadingthink.miniq.credits.200 | ¥200 |
| com.leadingthink.miniq.credits.500 | ¥500 |
| com.leadingthink.miniq.credits.1000 | ¥1000 |

Product ID 逐字一致，服务端按白名单发放上述固定人民币额度，不赠送、不换汇。各地区支付价格在 App Store Connect 设置，客户端直接显示 Apple 本地化价格并允许购买。例如 5 元额度包显示 USD 0.99 时，支付 USD 0.99、到账人民币 5 元。Apple 平台费用由业务承担，发布前核对各销售地区价格与成本。后端须删除旧的 CNY 和支付金额等于到账额度的限制，保留验签、商品白名单、账户绑定及幂等结算。

完成付费 App 协议、税务及银行信息，配置商品本地化、价格及可售状态。商品审核截图使用实际 App 购买页面；首次 IAP 按 App Store Connect 要求随 App 版本一并送审。

向后端提供应用的数字 Apple ID，并配置 App Store Server Notifications V2 地址。生产和 Sandbox 交易必须按交接文档隔离。不要把服务端 `.p8` 私钥放入 App。

## 客户端与后端联调

- 账户默认使用 `https://oneapi.zaiwenai.com/v1`，原生 HTTP 自动携带 Cookie，不需要 Bearer 登录改造。
- `VITE_MINIQ_API_BASE_URL` 在构建时统一指定账户、内购、模型和语音 API。测试使用 `https://apidev.zaiask.com/v1`，正式使用 `https://oneapi.zaiwenai.com/v1`。域名切换不能替代后端账本隔离；具体见 [测试环境联调](ios-iap-staging-test.md)。
- 模型、语音仍走已有 `/v1` 接口与用户填写的 Key。
- 先部署交接文档中的 context、transactions、notifications 及账本处理，再测试付款。
- 未完成购买启动/回到前台时自动尝试处理，账户页面也提供手动检查。已完成消耗型交易的余额由账户账本保存。
- 手机与电脑远程配对要求同一个 Key，只有相同手机号但 Key 不同仍无法配对。

## 真机测试

1. 验证从网页复制已有 Key 可直接问答、连接桌面。
2. 验证短信登录、Cookie 保存和续期、重启、退出、过期、注销确认。
3. 验证购买前显示当前手机号，付款后到账，手动创建/复制 Key，返回后手动粘贴保存。
4. 验证断网、取消、pending、App 被杀、重复领取，不重复充值或丢单。
5. 验证 Sandbox 充值与消费隔离，测试账户可以实际问答，退款能冲销。
6. 验证 iPhone / iPad 小屏、键盘、暗色模式、隐私同意和 Key 隐藏显示。

本地便携检查从 `apps/desktop` 运行：

```sh
npm run test:mobile
npm run build
node --test scripts/ios_testflight.node-test.mjs
```

StoreKit 的 Swift 编译、签名和上传需要 macOS；不能用 Windows 前端构建替代验证。后端接口和真机验证尚未完成时不要提交正式审核。上传 TestFlight 不等于正式提审，沿用仓库 AGENTS.md 的授权和工作流要求。
