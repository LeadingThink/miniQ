# miniQ 多端与远程桌面

## 用户能力

- `移动问答`：手机浏览器直接请求在问 OneAPI；桌面离线也可使用。消息仅保存在该浏览器本地。
- `远程桌面`：手机展示桌面 daemon 中的项目、会话、实时生成、队列、计划、问题和审批，并可继续任务或取消任务。
- 桌面无需公网 IP 或端口映射。daemon 主动连接 relay，断线后指数退避重连。

移动入口：`https://oneapi.zaiwenai.com/miniq/`

Android 与 iOS App 复用同一移动工作台。App 的 API Key 保存在系统安全存储（Android Keystore / iOS Keychain），网页端仍只保存到当前浏览器会话。

## 链路

```text
手机浏览器                         国内 relay                         桌面 miniQ
same API Key                                              same API Key (settings.json)
     |                                  |                           |
     |-- 派生 room/auth/AES key --------|-------- 同样派生 ----------|
     |                                  |<-- desktop 出站 WSS -------|
     |-- mobile WSS + room/auth ------->|                           |
     |== AES-256-GCM(JSON-RPC) =========|==========================>|
     |<================ 加密响应与事件 ==|===========================|
```

Key 通过带标签的 SHA-256 分别派生：

- 房间 ID：relay 用于路由；
- 认证 token：relay 只在内存中比对；
- AES-256 key：只存在于手机和桌面，用于端到端加密。

三个值相互独立，relay 不接收 API Key 原文，也不能解密 RPC、会话、工具参数或结果。房间仅在桌面在线时存在；桌面断开后移动连接会关闭，认证 token 不持久化。

## 安全边界

- 每房间最多 8 台移动设备，每连接每分钟最多 240 个加密帧，单帧上限 2 MiB。
- Relay 限制 Web Origin，30 秒心跳清理失活连接。
- daemon 拒绝远程执行 `settings.update`、`daemon.shutdown`、`workspace.open`、外部会话导入、MCP 配置修改和技能删除。
- daemon 记录最近 2,048 个来源/nonce，重复密文不会再次执行。
- 高风险本地工具仍遵循 miniQ 原有审批模式；远程端可处理已产生的审批。
- API Key 只进入手机的 `sessionStorage`，关闭浏览器会话后失效；设备 ID 才会进入 `localStorage`。

## 生产部署

- 节点：`119.29.21.235`
- Relay：systemd `miniq-relay.service`，监听 `127.0.0.1:9200`
- 公网 WSS：`wss://oneapi.zaiwenai.com/miniq-relay/ws`
- 健康检查：`https://oneapi.zaiwenai.com/miniq-relay/health`
- 移动静态站：Caddy `handle_path /miniq/*`

桌面端在设置中开启“移动端与远程桌面”，保存后 daemon 自动连接。桌面版本必须包含本功能代码；旧版本不会建立 relay 连接。
