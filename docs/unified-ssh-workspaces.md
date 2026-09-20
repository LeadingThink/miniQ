# 统一 SSH 工作区：对照、设计与验收

## 问题与目标

原有 SSH 实现能执行远端任务，但它是一个全局主机切换器：切换时重建整个任务界面，侧栏只保留当前主机的数据。SSH 连接归 Tauri 原生壳管理，手机经 relay 连接的却是本机 daemon，因此手机无法使用桌面已经连接的 SSH 工作区。

本轮目标是保留同一个应用和根连接，把本机、SSH 主机及其项目同时放入侧栏，并让桌面与手机使用同一条带主机身份的请求、事件与文件通道。SSH 凭据仍留在桌面电脑上。

## 对照来源与证据等级

公开产品入口：[Codex Remote connections](https://developers.openai.com/codex/remote-connections)。官方文档用于核对产品概念和使用方式，下面的具体类、状态字段与路由结论来自已安装代码的静态分析。

本机安装包是 `/Applications/ChatGPT.app/Contents/Resources/app.asar`，版本 **26.901.51231，build 8109**。包内名称为 `openai-codex-electron`，产品名称为 Codex。本报告针对这一个实际安装版本，不将其实现泛化成所有 ChatGPT 产品。

分析使用 `/tmp/chatgpt-asar-inspect.bayRXD` 中的解包文件。以下主要资源已从当前安装的 `app.asar` 直接读取并做 SHA-256 比对，均与解包文件一致：

| 包内资源 | SHA-256 |
| --- | --- |
| `.vite/build/main-BT6ViFC-.js` | `ff6dac303dd188bddfdbfbfa43d0b04507dcf5136b773114970d73f9c2a9af01` |
| `webview/assets/app-initial-cadb12d4a15e.js` | `73594359b28d81b6fcc9a52aac808f6a2e9fc32ced661adb3e23d297827b9285` |
| `webview/assets/remote-workspace-root-dialog-d6e227ec6fb5.js` | `6b8e802648dd71073c096b0a8aa755455b56849153bc6ae56fb608f823fcb296` |
| `webview/assets/remote-connection-editor-draft-70caf00ab3e8.js` | `2901f61a0b983942202f299475a41fe5c4496f26c5c816a5c4bec15be5dea731` |

本轮没有实际操作 ChatGPT 原生界面：当前 CUA 通道拒绝了界面访问。没有读取账户、SSH 私钥或真实连接配置，也没有在该客户端新建远端登录。因此下文把静态证据、设计推论和 miniQ 的实测结果分开陈述。

## 已确认的安装包实现

下列函数名是编译后的实际符号，不是猜测的原始源码名称。行号对应上述解包文件；压缩代码中可按给出的锚点定位。

| 方面 | 可定位的静态证据 | 说明 |
| --- | --- | --- |
| 多主机连接 | `main-BT6ViFC-.js:8`，`var Lt=class` | `connections=new Map`，通过 `addConnection`、`getConnection(hostId)`、`getAllHostIds` 管理多个连接 |
| 主机身份 | `remote-connection-editor-draft-70caf00ab3e8.js:1`，`function a(e,t)` | 保存 SSH 目标与稳定 `hostId`；编辑已有主机复用 ID，手动主机采用 `remote-ssh-codex-managed:` 前缀 |
| 远端项目 | `remote-workspace-root-dialog-d6e227ec6fb5.js:1`，`hostId:t,label:Ee.trim()` | 项目记录包含 `{id,hostId,label,remotePath}`；路径校验和目录创建携带同一 `hostId` |
| 聚合会话 | `app-initial-cadb12d4a15e.js:2210`，`bPr`、`TPr`、`EPr` | 获取默认及启用的远端 manager，汇总 `getRecentConversations()`，按时间排序，并行刷新各主机 |
| 统一侧栏 | `app-initial-cadb12d4a15e.js:2835`，`ETi`、`DTi`、`NTi`、`PTi` | 以 `host:${hostId}` 分组，保留本机分组，为尚无任务的远端补空组；任务按所属 host 入组 |
| 按主机发请求 | `app-initial-cadb12d4a15e.js:1922`，`function Rb(e,t)` | RPC manager 返回 `n.forHost(t)`，而非修改一个全局连接后再调用 |
| 会话执行位置 | `app-initial-cadb12d4a15e.js:2852`，`function PVi` | 通过项目或会话恢复 `{cwd,hostId}`；远端项目使用自己的 `remotePath` |
| 主机独立目录 | `main-BT6ViFC-.js:226`，`var Ab=class` | 会话目录和同步检查点保存 `hostId`，数据库查询包含 `WHERE host_id = ?` |
| 文件与操作路由 | `main-BT6ViFC-.js:670`，`getAppServerClientForHostIdOrThrow` | 目录、文件、Git、worktree 等操作选择对应主机客户端，不把远端路径当成本机路径 |
| SSH 传输 | `main-BT6ViFC-.js:472`、`:473`，`AppServerTransportSshWebsocket`、`createSshProxyStream` | 通过 OpenSSH 启动远端 `codex app-server proxy`，将 stdin/stdout 包成 WebSocket 的双向流，并支持重连 |
| 传输与 UI 分离 | `main-BT6ViFC-.js:1295`，`function P5(e)` | 按 host 配置选择 SSH、remote-control、WSL、WebSocket 或本地 CLI 传输；上层项目与会话继续使用 host 身份 |

其中的聚合逻辑直接体现了用户看到的差别：添加远端是增加一个可查询的主机和项目来源，不是卸载本机应用再加载另一台电脑。

安装包也包含按主机调用 `remoteControl/enable` 和独立配对流程。它证明存在远程控制能力，但静态代码不足以证明手机会自动通过某台桌面看到所有 SSH 主机。miniQ 的手机代理方案是基于自身 relay 架构的设计，不冒充已验证的 ChatGPT 手机实现。

## miniQ 的统一设计

| 层 | 原有行为 | 本轮设计 |
| --- | --- | --- |
| SSH 生命周期 | Tauri 壳中维护当前连接 | 本机 daemon 持有多主机连接池；按目标 `hostId` 独立连接、断开和重连 |
| 桌面根连接 | 选主机后替换整个应用连接 | 始终连接本机 daemon，通过 `host.call` 选择目标 |
| 侧栏 | 只列当前主机数据 | 同时列本机与已保存主机的项目，显示各主机状态 |
| 会话隔离 | 依靠重建整个界面防止串用 | 主机身份进入会话、草稿、缓存、文件和事件路由 |
| 手机 | 只能访问本机 daemon | 通过既有加密 relay 调用相同主机目录与 `host.call` |
| 主机保存 | 桌面 localStorage | daemon 持久化；迁移旧版 `miniq.ssh.saved-hosts` |
| 移动权限 | 仅验证外层 RPC 方法 | 转发前验证内部方法及已保存目标，禁止通过 `host.call` 绕过限制 |
| 事件 | 当前连接的普通事件 | 以 `host_event` 包含来源 `hostId`，再分发给对应会话 |
| 断线恢复 | 需要重新选全局主机 | 仅该主机离线，其他主机继续；重连读取状态，不重放不确定请求 |
| 日常导航开销 | 主机切换连带重建和读取目录 | 已连接主机直接切换会话；各主机目录独立刷新，不等待慢主机 |
| 本机后台工作 | SSH 切换时卸载本机界面 | 保留本机浏览器与任务控制器，停用隐藏输入框、快捷键和会话订阅 |

通信契约如下：

- `host.list` 返回本机 daemon 管理的主机信息；桌面可保存、移除主机，并迁移此前的本地主机记录。
- `host.connect`、`host.disconnect` 只影响指定 `hostId`。手机只能访问桌面已保存的目标。
- `host.call` 包含 `hostId`、内部 `method`、`params`。桌面和手机的业务组件使用一致的会话接口；本机仍可直接调用原有 RPC。
- SSH 事件封装成 `host_event`，保留其来源。订阅、历史分页、审批、文件分批读取都必须使用相同的主机上下文。
- 私钥、ssh-agent 和主机校验由桌面电脑的 OpenSSH 管理，不通过 relay 传给手机。模型 Key 属于执行任务的远端实例，不从本机自动复制。
- 移动连接的远程限制仍作用于内部 RPC。禁止未保存目标、递归主机转发和被禁的管理操作；不因外层 `host.call` 被允许就放过内部方法。

## 自动验收与真实链路验收

以下是本轮已运行的检查及仍需真机验收的边界。加密移动链路使用真实 WebSocket 和真实 SSH，但客户端由测试程序模拟，不代表已在手机屏幕上验收。

| 检查 | 通过标准 | 状态 |
| --- | --- | --- |
| 主机池与路由 | 两个主机同时存在；一个断开不影响另一个；请求 ID、结果及事件不串主机 | SSH 单元测试 21/21；组合烟测通过 |
| 移动权限 | 加密 relay 可访问已保存主机；拒绝未保存主机、嵌套转发及被禁的内部方法 | remote 测试 25/25；组合烟测通过 |
| 主机事件 | 两个主机返回相同会话 ID，事件仍分别携带对应 hostId | 组合烟测通过；event_journal 测试 3/3 |
| 真实 SSH 回环 | 临时 sshd、私钥、配置、数据；OpenSSH → bridge → daemon 健康及项目调用成功 | 通过 |
| 真实断线恢复 | 运行中断开后任务继续，重连读到最终回复；测试模型请求次数保持 1 | 通过，模型请求恰好 1 次 |
| 加密移动 relay → daemon → SSH | 通过两个别名读取运行中会话与文件、接收事件；断开其一后另一个仍可用，再连接仍为运行中 | 组合烟测通过 |
| 真实 Linux SSH 服务器 | 隔离本机 daemon 连接此前授权的 Linux SSH 服务器，保留本机健康检查并读取远端目录 | 通过；远端为 0 项目、0 会话，未验真实任务 |
| 前端回归 | 同 ID 主机隔离、预览恢复、慢主机、迟到请求、错误清理、更新与根连接生命周期 | 19 个相关文件，142/142 通过 |
| 浏览器桌面/手机布局 | 生产侧栏与连接设置；主机共存、切换、离线错误及草稿保留 | 合成预览通过；390 × 844 无横向溢出 |
| 手机完整操作 | 已保存 SSH 项目、会话、文件及事件可用；本机项目始终保留 | 待真机 |
| Windows/Linux 桌面 | 系统 OpenSSH、连接保存、根连接与文件访问正常 | 待平台验收 |

回环入口是 `node scripts/test-ssh-smoke.mjs`，运行前执行 `cargo build -p miniq-cli -p miniq-daemon`。本轮使用默认 features 构建，两条命令均成功。脚本使用新建临时目录、临时密钥及 loopback sshd，不读写用户真实任务。它先启动合成任务并验证 CLI bridge 断开后任务仍在运行，随后在保持模型响应等待的阶段运行 daemon 中 `ssh::smoke::real_loopback_ssh_bridge` 的显式忽略测试。该测试通过加密移动连接访问两个 SSH 别名下的同一个合成会话，从而检验相同会话 ID 的主机隔离。最后释放合成响应，确认任务完成且模型只被请求一次。

`MINIQ_SSH_SMOKE_CONFIG`、`MINIQ_SSH_SMOKE_WORKSPACE`、`MINIQ_SSH_SMOKE_SESSION`、`MINIQ_SSH_SMOKE_PROJECT` 只传递本轮临时夹具的配置路径和合成标识。Rust 测试验证这些路径属于脚本新建的隔离目录；测试只读取指定合成文件，不发现或读取用户真实 SSH 配置。

此前授权的真实 Linux SSH 服务器另行验证：使用其已有 CLI 读取 daemon 健康状态，再通过新建临时本机 daemon 保存、连接该目标，成功并行读取本机健康状态及远端健康状态、项目列表和会话列表。服务器已有 daemon 为 0.1.41，目录为空。本次检查没有复制模型 Key、重启远端 daemon 或改动远端任务。

`--keep` 可在全部检查通过后暂时保留隔离夹具，便于继续诊断；收到 SIGTERM/SIGINT 后按脚本清理。测试不得使用生产 SSH 配置、真实模型凭据或当前运行的桌面 daemon。

本轮不把静态代码比较称为 ChatGPT UI 实机验收。组合烟测确实运行了“加密移动 relay → 本机 daemon → SSH → 远端 daemon”整条链路，但没有连接生产 relay，也没有替代 iOS/Android 真机界面的操作验收。

## 收尾回归与上线边界

浏览器验收页面为 `apps/desktop/ssh-preview.html`，使用生产主机状态、统一侧栏和 SSH 设置组件，数据来自隔离的合成 transport。桌面与 390 × 844 手机尺寸均实测：多个主机同时存在、相同项目/会话 ID 不混淆、手机选择 SSH 会话后关闭抽屉、离线主机不改变当前主机、往返切换草稿独立保留。手机不能新增任意 SSH 目标或调用桌面目录授权入口。已恢复浏览器默认视口。

后台浏览器另有真实 `AppShell` 集成回归：保留浏览器页面和 driver，切走时隐藏，恢复不重复打开。停挂载隐藏的 `MainPage`，避免窗口级拖文件监听把 SSH 附件写进本机草稿；浏览器草稿转会话事件携带 hostId。对正在等待的本机发送与历史同步，用导航代次和当前激活状态阻止迟到响应抢走移动订阅，不取消已经发出的任务。

测试还覆盖：SSH 请求超时不会断开共用根连接、客户端更新前暂停根连接自动恢复、空会话不误标未读、延迟目录响应不能把已断开主机标为在线。SSH 列表读取失败也不再触发健康本机连接不断重试；旧桌面尚未提供 `host.list` 时，本机会话仍可用，SSH 功能需要更新桌面 daemon。

本轮已通过 TypeScript 检查、Vite 构建、Rust workspace 检查、Tauri 编译检查、两处 Rust 格式检查及 Git diff 检查。RPC 集成测试 16/16 通过，覆盖项目和空会话目录变更广播。开发期间修改上下文和挂载代码触发过 Vite 热更新错误；源码稳定后重新整页加载并验收，未出现新的控制台错误。

上述实现验收阶段仅提交源码，未发布安装包或重启现有桌面客户端。后续正式发布记录见 [0.1.42](releases/0.1.42.md)。正式上线需更新桌面 daemon 和移动界面；远端 Linux 0.1.41 CLI bridge 已验证可用，无需复制桌面的模型凭据。
