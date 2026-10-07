# 同 Key 多设备远程访问

用户已确认设备选择、记忆、顶部切换和离线展示。设备离线不得自动切换。会话、文件、审批、事件和通知必须隔离。切换后原设备任务继续。已有开发及发布授权。

## 实施

1. 修改 services/relay/src/broker.ts。一个认证房间保存多个设备。protocol 2 mobile hello 使用可选 targetDeviceId。devices 提供 deviceId/deviceName/online。ready 增加 desktopDeviceId/deviceName。未选设备仅发现。旧客户端仅在唯一设备时连接。
2. 修改 services/relay/src/push.ts。登记和推送按来源设备隔离。保留现有 registry。
3. 修改 crates/miniq-daemon/src/remote。主机使用稳定 deviceId。通知负载携带来源设备。
4. 修改 apps/desktop/src。加入设备选择器。切换时销毁旧连接并重建工作台。丢弃旧异步响应。清理会话、审批和 SSH 状态。
5. 修改 iOS 通知扩展。通知目标、分组和角标包含来源设备。

## 验证

- 两台主机使用同一 Key 同时在线。
- 同名会话、重复 RPC id、审批和 blob 不串线。
- 延迟回包不更新切换后的工作台。
- 指定离线目标不重定向。
- 旧 socket 断开不注销新连接。
- 旧移动端面对多设备安全失败。
- 执行相关 relay、Rust、前端测试及类型检查。
- 发布前完成 AGENTS.md 的发布检查。

## 集成与发布

使用隔离工作树 /private/tmp/miniq-multi-device。分工文件互不重叠。集成前审查差异并再次同步 main。保留其他工作树内容。验证通过后发布桌面/终端和 Android。部署 relay 并同步下载页。真机验证单独报告。

## 风险与回滚

部署前备份 relay dist。健康或路由验证失败则恢复备份并重启。客户端不得在旧 relay 上静默连接任意设备。离线设备目录至少在 relay 进程内保留。主机端任务不因手机切换停止。
