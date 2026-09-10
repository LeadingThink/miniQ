# 排队编辑与 macOS 窗口恢复验收

## 本轮修改

- 排队消息支持原位编辑、保存和取消；不会重新发送或打断当前任务。
- 新增 `session.queueUpdate`，必填 `sessionId`、`queuedMessageId`、`expectedContent`、`content`，拒绝未知字段。
- 保存只更新正文，保留附件、消息 ID、时间戳和排队位置。纯附件消息允许空正文；其他消息拒绝空白正文。
- 队列编辑与队列转入历史共用存储锁；已执行或移除的消息不能被编辑重新插入。
- 用编辑前正文检测多设备冲突，避免覆盖另一设备保存的修改；更新通过现有会话事件广播。
- 编辑期间消息开始执行或被移除，编辑框保留草稿，支持复制后重新发送。
- 保存失败保留草稿并显示就地错误；加载其他设备最新内容需要显式点击。
- 保存、调整方向、移除均防重复提交，操作期间禁用冲突按钮。
- Enter 换行，Cmd/Ctrl+Enter 保存，Escape 取消，兼容中文输入法合成过程。
- 关闭编辑后恢复键盘焦点；切换会话隔离编辑状态与异步错误。
- 长队列和长正文可滚动阅读，显示全部附件名称，手机布局按钮换行且扩大触控区域。
- macOS 处理 Tauri `RunEvent::Reopen`，显示、取消最小化并聚焦现有主窗口；复用到托盘与全局快捷键。关窗不销毁会话及子 webview，仅成功隐藏主窗口时阻止关闭。
- 队列读取异常会记录错误，不再广播伪造的空队列。

## 自动验证

- 前端 QueueBar、Timeline：19 项通过。
- 队列存储：7 项通过，含附件保留、跨会话拒绝、冲突、已执行拒绝、空内容约束和重新打开数据库后的持久化。
- daemon queue_integration、m6_multitask：7 项通过。两个 WebSocket 客户端验证更新广播与冲突；门控模型验证保存不打断当前任务、随后执行保存的内容。
- TypeScript、Rust 格式、Tauri cargo check、git diff --check 通过。
- release daemon 和无 devtools 的 macOS app 本地构建成功；Vite 保留既有的大 chunk 提示。

## 实际交互

- 独立 `queue-preview.html` 样例不连接用户真实任务。验证正文编辑保存、保留附件、多行显示与开始执行后的草稿保留。
- 390 × 844 手机视口：页面 clientWidth 与 scrollWidth 均为 390，无横向溢出；长队列滚动、编辑操作和恢复提示可见。
- 旧版：关窗隐藏后，系统应用重开入口无法恢复窗口。
- 新版本机：关闭主窗口后重新打开成功，重复操作仍成功；最小化后重开成功。验收会话中未发送的草稿完整保留，验收结束已清空测试草稿。
- 重开前后桌面 PID 12394、daemon PID 12412 保持不变；此过程未靠重启进程恢复窗口。
- 原生自动化无法直接读取 Dock 容器，因此实际动作验证使用系统应用重开入口；Dock 的处理依据是 macOS 对应的 Reopen 事件，不宣称已自动点击 Dock 图标。

## 本地安装

版本号保持 0.1.24。本轮没有创建版本标签、公共 Release 或上传安装包。

更新前 `daemon.shutdownIfIdle` 接受关闭，`cancelledAgents=0`、`cancelledTurns=0`。旧应用保留在 `/Users/xuzhanwei/.local/share/miniq-queue-install.rfVmcZ/miniQ.app`。

本地已安装二进制与构建产物 SHA256 相同：

- desktop：`2b870d700856095f57c05a99cef3aa5d38cf374682615d8b8a2140a48b16a6ae`
- daemon：`b96da5d76ab88c4ac4d986d7871bdd8800e20a6540c183e33ec2c1c2701d8caa`

范围限制：本轮完成队列编辑、窗口恢复及相关交互检查，不等于历史全部体验路线图已经完成。Windows、Linux 未在本机做原生运行验收。排队正文编辑保留既有附件，附件增删不属于本次实现。
