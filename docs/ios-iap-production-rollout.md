# miniQ Apple 内购正式后端部署交接

日期：2026-10-15。客户端使用 main，正式后端构建参数为 `api_environment=production`。

## 客户端切换

账户、短信、余额、Key、Apple 交易确认、模型和语音接口统一使用 `https://oneapi.zaiwenai.com/v1`。远程连接使用现有正式 relay。代码与工作流默认值已经是 production，无需删除 staging 支持或修改支付校验；之前的测试包由工作流显式选择 staging 构建。

本次保留 CNY 和额度包金额校验及商店刷新逻辑。切正式后端不解决 StoreKit 返回美元的问题，非 CNY 商品仍不能购买。TestFlight 包仍产生 Apple Sandbox 交易，正式 App Store 安装的支付环境由 Apple 决定，不能因 API 域名是正式站就把交易认定为 Production。

## 请 OneAPI 同学部署

1. 将测试站的 Apple 内购实现部署到正式站，接口契约见 [后端交接文档](ios-iap-backend-handoff.md)：
   - `GET /v1/iap/apple/context`
   - `POST /v1/iap/apple/transactions`
   - `POST /v1/iap/apple/notifications`
2. 保留正式手机号账户、余额和手动 Key 管理。Cookie 使用正式站 host-only 或匹配 `.zaiwenai.com` 的 Domain，登录、续期、退出的 Path 和 Domain 一致。
3. 配置 Bundle ID `com.leadingthink.miniq`、App Apple ID、Apple 验签根证书和服务端 API 凭据。继续按稳定 appAccountToken 绑定账户、验签、校验商品与 CNY 实付金额、幂等入账、无赠送、退款和对账。
4. 接入正式权威钱包和流水，确认不是只更新本地镜像余额。真实 Production 交易才进入正式账户可消费余额，不把 Sandbox 交易或旧测试余额迁入正式钱包。
5. 为 TestFlight 和 Apple 审核配置专用 Sandbox 测试账户及隔离账本；context 的 environment 与该账户策略一致，验签后必须检查交易环境。不能让所有正式站账户都返回 Production，否则 TestFlight 交易无法完成确认；也不能把所有正式用户配置成 Sandbox。当前客户端要求结算响应环境与 context 一致，不能由客户端随意指定环境。
6. 隔离必须覆盖充值、余额查询、Key 使用与模型扣费。测试账户或审核账户如需调用真实模型，应有独立且受控的测试费用来源，不把沙盒免费充值变成正式无限额度。

## App Store Connect 通知配置

- 生产通知 V2 URL：`https://oneapi.zaiwenai.com/v1/iap/apple/notifications`。
- Sandbox 通知：若后续测试账户、账本都转入正式站的隔离测试环境，将 Sandbox URL 也切到上述地址；需等后端支持按验签环境正确处理后再改。
- 若继续保留 apidev 沙盒账本，通知仍指向 apidev 时，必须与后端约定通知路由和交易所属账本，不能让新测试交易和退款落入不同数据库。

## 部署后的验证

检查未登录 context 返回登录失效业务响应，而不是 404；验证手机号登录和 Cookie 续期、余额、Key 创建/复制、模型请求。使用指定 Sandbox 账户验证 Apple 交易、重复提交、退款与隔离，然后再准备 App Store 审核候选。CNY/USD 商品异常仍是未解决项，不能把上传 TestFlight 或切正式域名当作内购验收通过。

2026-10-15 部署前只读检查：正式站 `/openapi.json` 有用户/Key 接口，但未声明上述三个 IAP 路由；直接 GET `/v1/iap/apple/context` 返回 HTTP 404。此记录不代表后续部署后的状态。

本次只准备连接正式后端的 TestFlight 候选包，不自动提交 App Store 审核。
