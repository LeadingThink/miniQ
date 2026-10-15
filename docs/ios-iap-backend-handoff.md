# miniQ × OneAPI：Apple 消耗型内购后端交接文档

更新日期：2026-10-15。实现已合入 miniQ 的 `main` 分支，本文是当前客户端接口契约。交接对象：`zaiwenai-openapi` 后端同学。切正式站的部署步骤见 [正式后端部署交接](ios-iap-production-rollout.md)。

## 1. 这次做什么

用户进入 miniQ，仍然手动输入 API Key。输入框下有「没有 API Key？登录购买额度 / 创建 Key」入口。进入后通过现有手机号短信验证码登录，在 App 内使用 Apple 消耗型购买充值到同一个 OneAPI 账户，再手动创建、复制 Key，返回入口粘贴保存。已有网页充值和网页创建的 Key 继续可以在 miniQ 使用。

- 不创建独立 miniQ 钱包或模型代理，不发放专用 miniQ 服务凭证。
- 同一账户的多个 Key 共用账户余额；创建 Key 不转移、不复制余额。
- 购买成功不自动创建、选用或覆盖入口的 Key。现有登录逻辑自动确保「Playground 默认 Key」存在，可以保留。
- 按 Apple 本地化价格付款，按商品 ID 固定发放人民币额度，无赠送、不换汇。例如 5 元额度包无论显示 CNY 5 或 USD 0.99，到账都是人民币 5 元。Apple 手续费由业务承担。
- 账户 Cookie 用于登录、余额、Key 管理和购买确认；API Key Bearer 用于模型请求，两种凭证不混用。
- 本文替代以前「独立钱包 / 邮箱登录 / 购买返回 apiKey / /miniq-iap/v1 代理」的方案。

## 2. 客户端已按哪些接口编写

默认 API 根地址：`https://oneapi.zaiwenai.com/v1`。当前联调地址：`https://apidev.zaiask.com/v1`，通过 `VITE_MINIQ_API_BASE_URL` 同时切换账户、内购、模型和语音请求。

miniQ 使用 `CapacitorHttp.request` 原生 HTTP 和系统 Cookie 存储。登录响应的 `Set-Cookie`、后续 `/user` 刷新 Cookie 均由原生层处理。客户端不把 JWT 存到 localStorage，也不改为 Bearer 登录。

统一响应沿用 OneAPI：

```json
{"code":"0","msg":"成功","data":{}}
```

`code` 是字符串；`"0"` 成功，`"-2"` 登录失效，其他值失败。现有 HTTP 200 业务失败也会被客户端拒绝。客户端不直接展示任意服务端错误正文，避免泄露敏感数据。

### 2.1 直接复用的接口

| 方法、路径 | 请求 | 响应 data / 用途 |
|---|---|---|
| POST `/user/send_sms_code` | `{"phone":"13800000000"}` | 发送短信；大陆 11 位，不加 +86 |
| POST `/user/login` | `{"phone":"13800000000","sms_code":"123456"}` | 现有 token 字段可保留；必须正确下发 Cookie |
| GET `/user` | Cookie | `phone:string, nick:string, balance:number`，余额单位人民币元 |
| POST `/user/logout` | `{}` + Cookie | 撤销登录、清除 Cookie |
| POST `/user/delete` | `{}` + Cookie | 注销共用的 OneAPI 账户；客户端提供明确二次确认 |
| GET `/keys?page=1&page_size=10` | Cookie | `{"total":11,"keys":[...]}`，客户端逐页查询 |
| POST `/keys` | 下方 JSON + Cookie | 返回创建后的 Key，用户自己复制 |

创建 Key 请求：

```json
{
  "remark": "miniQ",
  "is_active": true,
  "allow_model_ids": ["all"],
  "quote_limit": 0
}
```

Key 响应使用现有字段，客户端依赖：`key_id:string, sk:string, remark:string, is_active:boolean, expire_time:number`。`expire_time` 为秒级 Unix 时间戳。其他字段可保留。现有请求 `quote_limit`、响应 `quota_limit` 拼写不同，不要误将请求改成 `quota_limit`。0 表示没有单独的 Key 消费上限，仍受账户余额限制。

模型接口继续使用原有 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/audio/transcriptions`，请求头为 `Authorization: Bearer <API Key>`。

### 2.2 Cookie 接入检查（不要求重写登录协议）

- `token` Cookie 的 Domain 必须匹配 API 域名，Path 建议固定 `/`，使用 HTTPS，建议 Secure / HttpOnly。登录、续期、退出和注销须使用一致的 Domain / Path。
- 原生 HTTP 不依赖 WebView 第三方 Cookie，也不需要为 `capacitor://localhost` 放开浏览器跨域权限。不要因此移除网页端已有的 CSRF 防护。
- 新增购买接口继续依赖 `get_current_user`，校验登录、封禁和注销状态，不能仅相信客户端传来的用户 ID。
- `/user` 返回刷新 Cookie 后，必须验证 App 重启、退出重登时状态一致。当前登录、用户信息、退出接口中 Cookie Domain 的写法不完全一致，请部署前核对。
- 客户端不会全局开启 Capacitor 的 fetch 替换，避免影响模型 SSE 流式响应。

## 3. 必须新增的接口：账户绑定

### GET `/v1/iap/apple/context`

要求登录 Cookie。返回：

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "accountId": "<现有 User.uid()>的字符串",
    "appAccountToken": "00000000-0000-4000-8000-000000000001",
    "environment": "Production"
  }
}
```

- `appAccountToken`：服务端生成的随机 UUID，标准小写格式，与账户建立唯一稳定映射，不能用手机号直接代替。重复请求、重新登录、换手机时保持不变。
- `environment`：严格为 `Production` 或 `Sandbox`。由服务器的账户隔离策略决定，禁止客户端任意指定。
- 为旧用户按需创建 UUID 时使用唯一索引和原子写入，处理并发初始化。
- 客户端在购买前重新请求并核对账户，然后调用 StoreKit `product.purchase(options: [.appAccountToken(uuid)])`。
- 必须在响应成功前确认相应环境的充值、余额和消费隔离已准备好；没有准备好时返回业务错误，不让用户先付款。

## 4. 必须新增的接口：交易验签与入账

### POST `/v1/iap/apple/transactions`

要求登录 Cookie。客户端请求：

```json
{
  "productId": "com.leadingthink.miniq.credits.100",
  "transactionId": "100000000000000",
  "originalTransactionId": "100000000000000",
  "signedTransaction": "<苹果签发的 compact JWS>",
  "appAccountToken": "00000000-0000-4000-8000-000000000001"
}
```

交易 ID 是字符串，不能用 JavaScript Number 保存。没有充值金额、账户余额、客户端指定 uid 或环境字段。上述普通字段仅用于一致性检查；权威数据来自验签后的 JWS 和当前登录用户。

客户端发送的是 StoreKit `VerificationResult<Transaction>.jwsRepresentation`，不是 `Transaction.jsonRepresentation`，不是旧式 base64 receipt，也不是 miniQ 自己签名。

### 4.1 成功响应

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "accountId": "<现有 User.uid()>的字符串",
    "appAccountToken": "00000000-0000-4000-8000-000000000001",
    "environment": "Production",
    "transactionId": "100000000000000",
    "status": "credited",
    "creditedCents": 10000,
    "balanceYuan": 100.0001
  }
}
```

| 字段 | 契约 |
|---|---|
| accountId / appAccountToken / environment | 与 context 一致，UUID 小写 |
| transactionId | 与此次提交并验签的交易相同 |
| status | 仅 `credited`、`already_credited`、`revoked` |
| creditedCents | 商品到账分数的整数；重复确认仍返回原交易分数；撤销交易返回 0 |
| balanceYuan | 当前账户在相应环境的余额，人民币元，有限数值，可含小于分的计费精度或退款欠费 |

`credited` 表示实际入账完成，`already_credited` 表示之前已完成且这次未重复加钱。`revoked` 仅用于已验证的退款/撤销且冲销状态已可靠记录的终态，不能用它忽略任意验签错误。

客户端核对这些字段后才调用 StoreKit `finish()`。网络失败、验签失败、账户不匹配、环境不匹配、结算未完成时，不返回成功终态。客户端保留未完成交易，启动、前台恢复和用户点击「检查未完成购买」时重试，不要求用户再次付款。

### 4.2 使用 Apple 官方验签库

后端是 Python/FastAPI，建议使用 Apple 官方 [App Store Server Library for Python](https://github.com/apple/app-store-server-library-python)，遵循仓库 uv 管理方式安装依赖。使用库的 `SignedDataVerifier` 验证交易和通知，不自行拼凑 JWT 验签。

后端配置：

- Bundle ID：`com.leadingthink.miniq`。
- App Apple ID：App Store Connect 的应用数字 ID，生产环境校验需要；不是 Bundle ID 或 Team ID。
- 从 [Apple PKI](https://www.apple.com/certificateauthority/) 获取库要求的 Apple 根证书，按官方格式加载，不能直接信任 JWS 中任意自带证书。
- 启用库的证书链、签名、有效期和在线撤销检查；运行环境允许相应出站访问。
- 生产和 Sandbox 分别建立 verifier。验证成功后才相信 payload；未验签的解码结果最多用于选择验证器，绝不能据此放行。
- 如需调用 App Store Server API 对账，配置 Issuer ID / Key ID / 服务端私钥 `.p8`。它们属于服务器密钥，不能放入客户端、Git、普通日志。验签根证书和 API 私钥用途不同。

入账前逐项验证：

1. 苹果签名链、Bundle ID、生产环境 App Apple ID、环境匹配。
2. 类型为消耗型购买，productId 在白名单中；数量为 1。
3. 验签后的 transactionId、originalTransactionId、productId 与请求一致。
4. JWS 中 appAccountToken 绑定的 uid 等于当前 Cookie 用户；缺失、被别的用户领取均拒绝。仅在 JSON 中传一个相同 UUID 不算证明。
5. 交易没有退款/撤销，符合本应用和账户环境。对首次提交的旧凭证使用 Server API 查询当前交易状态，结合通知的撤销记录防止重放退款前的 JWS 重新领额度。
6. 支付价格和币种仅从已验签的 Apple 数据记录用于对账；不要求 CNY，也不要求价格等于到账金额。到账额度只由商品白名单决定，不能相信客户端价格或充值金额。
7. 原子入账和流水持久化完成后，返回上述响应。

### 4.3 本地化支付价格与固定人民币额度

| Product ID | 固定人民币到账额度 | creditedCents |
|---|---:|---:|
| com.leadingthink.miniq.credits.5 | ¥5 | 500 |
| com.leadingthink.miniq.credits.10 | ¥10 | 1000 |
| com.leadingthink.miniq.credits.20 | ¥20 | 2000 |
| com.leadingthink.miniq.credits.50 | ¥50 | 5000 |
| com.leadingthink.miniq.credits.100 | ¥100 | 10000 |
| com.leadingthink.miniq.credits.200 | ¥200 | 20000 |
| com.leadingthink.miniq.credits.500 | ¥500 | 50000 |
| com.leadingthink.miniq.credits.1000 | ¥1000 | 100000 |

Apple 交易 `price` 的单位为支付币种的千分之一，例如 USD 0.99 对应 990，CNY 5 对应 5000。原样保存验签后的 price 和 currency 作为支付记录，不将其直接写入人民币余额。缺失价格时用受信任的 Apple 数据补齐对账记录，不根据缺失字段推定 CNY 或零价。

**删除旧校验 `currency == "CNY"` 和 `price == creditedCents * 10`。** 支付金额由 App Store Connect 的各地区定价和 Apple 实际交易决定；发放金额只读取上述 productId 白名单。数量仍只允许 1。没有汇率计算，没有赠送，也不按 Apple 扣除手续费后的净收入充值。

客户端展示 Apple 的 displayPrice 和固定人民币到账额度，允许 Apple 返回的任意币种和定价。付款前仍检查商品价格是否变化，变化时要求重新加载。请在 App Store Connect 核对各销售地区价格与成本；更新地区价格不会自动改变固定到账额度。

充值额用整数分/Decimal 计算，到现有账本时再按统一规则转换为元。模型计费保留现有精度，不能把每次模型消费强行取整到分。

### 4.4 幂等和账本：不能直接复用当前充值任务

已检查现有代码：

- `services/payment_settlement.py` 的 `settle_recharge` 会触发充值赠送、邀请奖励、累计奖励。
- `services/cumulative_bonus.py` 当前会统计非 SYSTEM 的成功订单；新增 APPLE 支付类型后，如不改过滤条件，会把 Apple 充值计入后续活动奖励。
- `tasks/__init__.py` 的 BalanceUpdateTask 当前先保存余额再保存交易，交易唯一索引在余额更新之后才起作用，不能保证苹果重复回调不重复入账。

需要：

- 增加 Apple 支付来源，并接入现有账户资金流水，不创建独立生产钱包。
- Apple 渠道不触发赠送、邀请返利、累计充值奖励，且后续累计活动查询排除 Apple 金额。网站原有活动不应被一起删除；已有注册赠送属于另外的业务规则。
- 交易唯一键至少包含 `(environment, transactionId)`，同时固定归属 uid、UUID、商品、金额；同一交易不得换账户再次领取。
- 使用 Mongo 事务（确认副本集支持）或经验证的原子收据方案，保证去重、余额变更和资金流水一致；不要仅先查是否存在再写余额。
- 只在实际入账完成后返回 credited，不能把「异步任务已入队」当作到账。
- 数据库提交后响应丢失、并发请求、App 与通知同时到达，均返回同一笔结算结果，不再次充值。
- 已注销账户的交易与 UUID 映射按账务要求留档，不能把旧交易分配给手机号重新注册后的新 uid。

### 4.5 如果启用了主站统一钱包

先确认线上 `wallet_enabled` 的实际值，不能只看默认配置。

开启时，`services/balance.py` 以主站钱包为权威，`services/wallet.py` 会调用 `/api/v1/wallet/credit` 并使用 `X-Billing-Reference`。这时不能只给 OneAPI 本地 Balance 加钱：

- 给 Apple 交易固定且带环境的 billing reference，重试始终复用。
- 主站充值成功、本地持久化、重试及对账之间使用可靠状态机/outbox；远程 HTTP 不能包进 Mongo 事务就声称跨系统原子。
- 主站也要确认 Apple 不触发赠送，支持幂等和退款冲销。
- 若现有主站接口已满足要求则复用；否则需同步修改主站钱包服务。
- 未确认权威账本入账前不能返回 credited。

## 5. Sandbox / TestFlight / 正式审核

TestFlight 和苹果审核可能产生 Sandbox 交易，不是真实付款。不得向正式共用余额或主站生产钱包充值。

为保持当前同一 API 域名和模型接口，建议服务端准备明确隔离的测试/审核账户：

- 服务端固定标记审核测试账户，context 返回 Sandbox，使用独立测试账本。
- 这些账户的 `/user` 余额、创建的 Key、模型消费都必须走测试账本或有明确成本上限的测试服务；不能只有交易表标记 Sandbox，余额仍更新正式 Balance。
- 普通账户返回 Production，只接受 Production 交易。不能由请求头、前端参数或任意手机号触发沙盒切换。
- Sandbox 交易与通知绝不调用生产主站钱包 credit。
- 审核账号要能完成购买、创建 Key、实际问答全流程。为审核提供可操作的独立登录方式，不要要求审核员使用真实客户短信或加入全局验证码绕过。

当前已部署独立测试域名 `apidev.zaiask.com`。客户端通过 `VITE_MINIQ_API_BASE_URL` 同时切换账户、内购、模型和语音请求，并隔离设备上保存的测试 Key。后端仍需隔离测试数据库、账本和主站钱包。该域名的 Cookie 应使用匹配的 Domain（或 host-only Cookie），不能继续设置 `.zaiwenai.com`。详细步骤见 [测试环境联调](ios-iap-staging-test.md)。

## 6. Apple 通知、退款和对账

新增 `POST /v1/iap/apple/notifications`，不要求用户 Cookie，认证依据是 Apple `signedPayload` 验签。App Store Connect 配置 App Store Server Notifications V2 的生产和 Sandbox 回调 URL。

- 验证外层 signedPayload 以及内部 signedTransactionInfo，检查应用和环境，使用稳定 UUID 找到账户。
- notificationUUID 去重，同时使用交易账本幂等；乱序通知不可覆盖更晚的退款终态。
- 退款、撤销到达时按原交易实际发放的人民币额度做一次冲销（不能用外币支付数值扣人民币余额），余额已消费时按明确欠费/冻结规则处理，不能静默丢弃。
- 退款先于客户端领取时，先保存撤销记录，随后领取不得充值。
- 有关付款成功的通知可以调用同一结算服务；不得独立复制第二套入账逻辑。
- Apple 通知持久化接收后再返回成功；处理失败支持队列重试和对账，不能依赖 App 永远会再打开。
- 保留交易金额、环境、账户、状态迁移及资金流水用于对账；普通访问日志不打印 Cookie、JWT、完整 JWS 或 API Key。

## 7. 建议改动位置

| 后端模块 | 工作 |
|---|---|
| api_server/api/v1/ | 新增 `/iap/apple` 路由；保持现有 Cookie 依赖 |
| api_server/db/ | UUID 账户映射、交易与通知记录、唯一索引、状态 |
| api_server/models/ | Apple 支付来源、接口 Pydantic 模型 |
| api_server/services/ | Apple 验签、统一幂等结算、退款与对账 |
| payment_settlement / cumulative_bonus | 明确排除 Apple 赠送和累计活动 |
| wallet / balance | 确认权威账本及沙盒隔离，必要时对接主站 |
| config / 部署配置 | App 数字 ID、证书、服务端凭据、通知 URL、测试账户策略 |

不要把 Apple 逻辑塞进模型推理或普通 Key 创建接口。验签库异常应转换为明确失败响应，不返回成功并忽略错误。

## 8. 联调验收清单

1. 原生短信登录后 Cookie 生效；重启保持、/user 续期、过期重登、退出、注销行为正确。
2. 现有网页 Key 直接粘贴可用，不要求先登录或再次购买。
3. 登录账户 A 充值只增加 A 的余额；用户填写 B 的 Key 不会误使用 A 余额。
4. 创建 Key 权限为 all，使用本账户余额；超过 10 个 Key 可翻页；创建/购买不自动填入口。
5. 对同一商品测试 CNY、USD、JPY 及变化的人民币售价，始终只发放白名单人民币额度，无任何充值或累计赠送。验证退款冲销原发放额度。
6. 伪造签名、错误 App、未知商品、数量非 1、缺失 UUID、其他账户 UUID 均拒绝；客户端不能通过伪造价格改变额度。
7. 并发领取同一交易、通知和领取并发、入账后断网、finish 失败再试，始终只入账一次。
8. 取消付款、Ask to Buy pending、App 被杀后重开，不误发额度，也不提示再次付款解决丢单。
9. Sandbox 不能增加生产资金；审核账户在沙盒可以走完整功能。
10. 退款重复通知、先退款后领取、退款前旧 JWS 重放、余额已经消费后的退款均有测试。
11. 已注销账户的 Key 失效，待处理交易有可追溯规则。
12. 若开启主站钱包，验证主站和 OneAPI 最终一致、固定 billing reference 生效。

## 9. 当前交付边界

miniQ 客户端已按本契约实现；OneAPI 仓库尚未由本任务修改。新增 Apple 接口部署前，购买区域会报服务不可用，不能用于正式充值。Cookie 账户与 Key 接口可以先联调。

Windows 上的前端测试和构建不等于 iPhone 验证。仍需 macOS 编译 StoreKit 桥接，并用真机/TestFlight 验证 Cookie 生命周期、Apple Sandbox 购买、断网恢复和退款。TestFlight 上传与 App Store 正式提审是独立操作，须在联调完成后安排。
