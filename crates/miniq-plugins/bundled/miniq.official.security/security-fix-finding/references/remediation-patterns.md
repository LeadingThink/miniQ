# 常见漏洞类的修复模式与反模式

用法：先确认 finding 的类别与根因，再在本表中找到对应小节，选择与仓库技术栈匹配、且能在**共享执行边界**落地的模式。每节都给出"推荐模式""反模式""回归测试应覆盖的输入"。本文件是起点而非清单式替代：最终方案必须以仓库源码与已有先例为准。

## 通用原则

1. **白名单优于黑名单**：列出允许的值/字符/主机/类型，而不是枚举危险值。
2. **在最终使用点之前、规范化之后校验**：先解码/规范化/解析到最终形式，再判断；判断后不再变换。
3. **结构化 API 优于字符串拼接**：参数化查询、参数数组调用进程、模板自动转义、URL 构造器。
4. **失败即拒绝**：异常、未知值、缺失配置都走拒绝分支。
5. **单一执行点**：多个入口共用一个辅助函数/中间件，避免每个调用点各写一份。
6. **显式拒绝而非静默修正**：把 `../` 删掉再继续，往往会把 `....//` 变成 `../`。

## 1. SQL / NoSQL 注入

- 推荐：参数化查询/预编译语句（`cursor.execute("... WHERE id = %s", (uid,))`、`db.query("... $1", [uid])`）；ORM 的查询构造器；动态列名/排序字段用白名单映射（`{"name": "u.name", "created": "u.created_at"}`）。NoSQL 中拒绝对象型输入进入查询操作符位置（如 Mongo 的 `{"$gt": ""}`），对字段做类型断言。
- 反模式：手写转义函数、`replace("'", "''")`；只在前端校验；把 `ORDER BY` 字段直接拼接；用 ORM 的 `raw()`/`text()` 并拼接。
- 测试输入：`' OR '1'='1`、`1; DROP TABLE x--`、注释符、排序字段 `id desc, (select ...)`、Mongo 操作符对象；合法对照：含撇号的姓名 `O'Brien`。

## 2. 命令注入

- 推荐：参数数组调用且不经 shell（`subprocess.run([...], shell=False)`、`execFile`、`Command::new().arg()`）；参数前加 `--` 防止选项注入；可执行名白名单。
- 反模式：`shell=True` 配合 `shlex.quote` 只处理部分参数；黑名单过滤 `;|&`；拼接到 `bash -c`。
- 测试输入：`; id`、`$(id)`、反引号、换行、以 `-` 开头的参数（`--output=/etc/x`）；合法对照：含空格的文件名。

## 3. 路径穿越 / 任意文件读写

- 推荐：把用户输入当作名字而非路径；必须是路径时 `realpath/resolve` 后与根目录做**路径组件级**前缀比较（Python `Path.is_relative_to`，Node 用 `path.relative` 结果不以 `..` 开头且非绝对）；打开时使用 `O_NOFOLLOW` 或 `openat` 类 API 防符号链接；解压归档时对每个条目单独校验。
- 反模式：字符串 `startswith(root)`（`/data/app` 会放行 `/data/app2`）；只删除 `../`；只校验一次后再拼接其他片段；忽略 Windows 的 `\` 与盘符。
- 测试输入：`../../etc/passwd`、`..%2f`、`..%252f`、`....//`、绝对路径、`..\\`、符号链接指向根外、Zip Slip 条目；合法对照：`sub/dir/file.txt`。

## 4. 跨站脚本（XSS）

- 推荐：依赖模板引擎的上下文自动转义；必须渲染富文本时用成熟的 HTML 净化库（如 DOMPurify、nh3）并配置白名单；URL 属性校验协议（只允许 `http/https/mailto`）；补充 CSP 作为纵深防御。
- 反模式：`innerHTML`/`dangerouslySetInnerHTML`/`v-html`/`|safe` 直接输出；只转义 `<>` 而忽略属性和 JS 上下文；用正则去掉 `<script>`。
- 测试输入：`<img src=x onerror=alert(1)>`、`javascript:` URL、属性闭合 `" onmouseover=`、SVG 载荷；合法对照：含 `<` 的普通文本正确显示。

## 5. 服务端请求伪造（SSRF）

- 推荐：目标主机白名单；必须支持任意 URL 时，解析 → 解析 DNS → 校验所有解析出的 IP 不在内网/回环/链路本地/元数据段 → **用校验过的 IP 直连**（防 DNS rebinding）；禁用或逐跳重新校验重定向；限制协议为 http/https。
- 反模式：对 URL 字符串做正则判断主机名；只在第一次请求前校验而跟随重定向；忽略 IPv6、十进制/八进制 IP、`0.0.0.0`。
- 测试输入：`http://169.254.169.254/`、`http://127.1`、`http://[::1]`、`http://2130706433`、指向内网的重定向、解析到内网的域名；合法对照：白名单内的外部地址。

## 6. 认证缺失与越权（IDOR / 对象级授权）

- 推荐：在数据访问层按"当前主体 + 资源 id"查询（`WHERE id = ? AND owner_id = ?`），或统一的策略函数 `authorize(subject, action, resource)`；路由默认需要认证，公开接口显式声明；授权在最终资源身份（解析别名/重定向后）上判断。
- 反模式：只在 UI 隐藏按钮；只校验登录不校验归属；信任请求体里的 `user_id`/`role`；列表接口校验了而单项接口没校验。
- 测试输入：用户 A 访问用户 B 的资源 id、修改请求体中的 `owner_id`、批量接口混入他人 id、未登录访问；合法对照：用户访问自己的资源。

## 7. 批量赋值（Mass Assignment）

- 推荐：显式的输入 DTO/白名单字段（`permit(:name, :email)`、Pydantic 模型、`@JsonIgnoreProperties`）。
- 反模式：`Model(**request.json)`、`Object.assign(user, req.body)`；只在前端表单不提供字段。
- 测试输入：请求体附加 `is_admin: true`、`role`、`tenant_id`。

## 8. 不安全反序列化

- 推荐：改用数据格式（JSON）+ 模式校验；必须用对象序列化时开启类型白名单；YAML 用安全加载器（`yaml.safe_load`）。
- 反模式：`pickle.loads`/`Marshal.load`/`ObjectInputStream` 处理不可信数据；仅靠签名但密钥可泄露或可预测。
- 测试输入：构造的恶意载荷（仅在本地）、非预期类型；合法对照：正常对象往返。

## 9. 密码学误用

- 推荐：密码哈希用 argon2id/bcrypt/scrypt；随机数用 CSPRNG（`secrets`、`crypto.randomBytes`）；对称加密用 AEAD（AES-GCM、ChaCha20-Poly1305）且 nonce 不复用；比较令牌用常量时间比较；JWT 固定允许的算法并校验 `exp/aud/iss`。
- 反模式：MD5/SHA1 存密码；`Math.random()` 生成令牌；ECB 模式；接受 `alg: none`；关闭 TLS 证书校验。
- 测试输入：篡改签名、`alg: none`、过期令牌、错误受众；合法对照：有效令牌。

## 10. 硬编码密钥

- 推荐：移到密钥管理/环境变量，**同时轮换已泄露密钥**（仅改代码不够，历史中仍存在）；启动时缺失即报错。与 `security-secret-scan` 的处置流程一致。
- 反模式：只把密钥挪到另一个被提交的配置文件；只做 base64；删除当前行但不轮换。

## 11. CSRF 与跨域

- 推荐：状态变更接口要求 CSRF 令牌或 `SameSite=Lax/Strict` Cookie + Origin 校验；CORS 白名单精确匹配来源，带凭据时绝不回显任意 Origin。
- 反模式：GET 做状态变更；CORS 反射 `Origin` 且 `Allow-Credentials: true`；正则匹配 `example.com` 放行 `evil-example.com`。

## 12. 开放重定向

- 推荐：只允许相对路径（以单个 `/` 开头且不是 `//` 或 `/\`）或白名单主机；用 URL 解析器而非字符串判断。
- 测试输入：`//evil.com`、`/\evil.com`、`https:evil.com`、`https://good.com@evil.com`。

## 13. XML 外部实体（XXE）与解析器

- 推荐：禁用 DTD 与外部实体（`defusedxml`、`XMLConstants.FEATURE_SECURE_PROCESSING`、`disallow-doctype-decl`）。
- 反模式：只过滤 `<!ENTITY` 字符串。

## 14. 资源耗尽 / ReDoS

- 推荐：请求体、上传、解压后大小与条目数上限；正则避免嵌套量词或使用线性时间引擎（RE2）；分页上限；超时。
- 反模式：只限制压缩后大小；在用户输入上执行可回溯的复杂正则。

## 15. 日志与信息泄露

- 推荐：对令牌、密码、个人信息做字段级脱敏；错误响应返回通用信息 + 关联 id，详情只写服务端日志；日志输出前去除换行防日志注入。
- 反模式：`logger.info(request.headers)`；生产开启调试页。

## 16. 竞争条件 / TOCTOU

- 推荐：数据库层原子操作（条件更新、唯一约束、行锁/事务）；文件用 `O_EXCL` 创建、句柄级操作；幂等键。
- 反模式：先查询后更新的两步操作（余额、库存、优惠券）；`exists()` 后再 `open()`。
- 测试输入：并发请求同一操作（本地用线程/`xargs -P` 模拟）。

## 选择模式时的决策顺序

1. 仓库已有的安全辅助是否能直接复用？→ 用它，并让漏报的调用点接入。
2. 框架是否提供开箱即用的安全机制（自动转义、参数化、中间件）？→ 开启/使用它。
3. 需要新增辅助函数时，放在所有入口共享的层，并在同一补丁内让已知同类实例调用它（若它们属于本 finding 的同一边界）。
4. 修复会改变外部行为（拒绝以前接受的输入）时，在 `fix-report.md` 写明兼容影响，必要时 `ask_user`。
5. 需要跨模块重构才能根除的，先做最小可行的边界修复，把系统性改进交给 `security-hardening`。
