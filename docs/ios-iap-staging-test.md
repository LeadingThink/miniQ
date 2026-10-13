# apidev.zaiask.com 测试环境联调

## 当前检查结果（2026-10-13）

已从客户端开发环境通过 HTTPS 读取测试站的 OpenAPI 文档：

- 存在 `GET /v1/iap/apple/context`、`POST /v1/iap/apple/transactions`、`POST /v1/iap/apple/notifications`。
- context 和交易响应声明的字段与 miniQ 契约对应。
- 未登录访问 context 返回 `{"code":"-2","msg":"请先登录","data":null}`，未开放匿名领取。
- `/v1/models` 的 CORS 预检允许 `capacitor://localhost` 和 Authorization 请求头。

这些检查只证明连通性、接口声明和匿名鉴权，不证明真实登录 Cookie、Apple 验签、资金入账或退款已通过。尚未发送短信、创建测试 Key 或发起支付。

## 后端同学部署前要确认

1. 全部接口以 `https://apidev.zaiask.com/v1` 为根地址，包含用户、Key、模型和 Apple 内购，不只有充值接口。
2. 测试 Cookie 的 Domain 与 `apidev.zaiask.com` 匹配。建议 host-only 或明确设置 `.zaiask.com`，Path 为 `/`；登录、续期、退出、注销须一致。继续设置 `.zaiwenai.com` 会导致此域名无法保存登录。
3. 指定测试手机号；该账户的 context 返回 `Sandbox`。苹果 Bundle ID 仍为 `com.leadingthink.miniq`。
4. 测试数据库、余额、主站钱包均隔离。使用真实模型做测试时明确费用来源和上限；不能把 Sandbox 免费交易充进正式钱包。
5. Sandbox 通知 URL 配为 `https://apidev.zaiask.com/v1/iap/apple/notifications`，正确配置证书与服务端凭据。
6. 已有测试用户的消费、创建 Key 与余额查询均使用同一份测试账本。

## miniQ 客户端配置

已改为统一变量，账号、内购、模型、语音都会切换：

```text
VITE_MINIQ_API_BASE_URL=https://apidev.zaiask.com/v1
```

它是构建时变量，修改服务器或本地文件不会改变已经上传的 TestFlight 包。原来的 `VITE_MINIQ_IAP_API_BASE_URL` 已删除，避免只切账户而模型还在正式环境。

正式构建不设置该变量时默认 `https://oneapi.zaiwenai.com/v1`。测试包有明显提示，保存的 API Key 与正式包分开，不会自动读取或覆盖正式 Key。Cookie 由域名隔离。当前没有测试 relay 的地址和认证配置，因此测试包暂不开放远程桌面；本次验证登录、充值、创建 Key 和移动问答。

本地 Windows 构建（目录 `apps/desktop`）：

```powershell
$env:VITE_MINIQ_API_BASE_URL = 'https://apidev.zaiask.com/v1'
npm run build
Remove-Item Env:VITE_MINIQ_API_BASE_URL
```

GitHub Actions 的 `iOS TestFlight` 工作流新增 `api_environment` 选择：

- `staging`：构建连接 apidev 的测试包。
- `production`：默认选项，构建连接 oneapi 正式服务的包。

只有用户明确要求构建/上传 TestFlight 时才执行工作流；这份文档及环境配置不会触发上传。仍需新的、未使用的 build number，沿用 AGENTS.md 的签名与上传流程。

## 在 iPhone 上怎么测

1. 安装指向 staging 的新 TestFlight 包，确认入口显示「测试环境」。填写已有正式 Key 不能代替测试 Key。
2. 点击「没有 API Key？登录购买额度 / 创建 Key」，用测试手机号收短信并登录。
3. 登录后看到正确手机号和测试余额，退出 App 再打开检查 Cookie 是否保留。
4. 购买区域显示「当前为测试账户」。先买最小可用额度包，确认苹果显示测试购买，完成后验证测试余额精确增加商品金额。
5. 手动创建 Key，复制，返回入口手动粘贴保存；打开移动问答，选择测试站模型并发送一条问题。
6. 确认调用成功且仅扣测试账户余额；购买和创建 Key 均没有自动替换入口内容。
7. 检查取消付款、断网后重试、重复检查未完成购买、换账号、退出和注销。退款通知由后端同学协助联调。

遇到问题记录测试时间、测试包版本/构建号、操作、错误提示及 Apple 交易 ID（如有）。不在普通截图或日志中暴露验证码、Cookie、API Key 或 .p8。

## 确认后切正式

后端将相同代码部署到 `oneapi.zaiwenai.com`，配置生产账本、匹配的 Cookie Domain 和生产通知 URL。客户端重新构建 `api_environment=production` 的候选包并验证。不能把指向 apidev 的 TestFlight 构建直接选为正式发布包，也不能把测试余额迁为正式充值。

生产服务还要保留对苹果审核 Sandbox 交易的隔离处理；正式审核环境不一定产生 Production 交易。正式候选包的审核账户必须可完成完整流程。
