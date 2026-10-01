# 权限与故障排查

## 权限
| 症状 | 原因 | 处理 |
|---|---|---|
| `app_automation status` 显示辅助功能未授权，或报 `computer_permission_required` | 缺少「辅助功能」权限 | 请用户打开「系统设置 → 隐私与安全性 → 辅助功能」，勾选 miniQ（若已勾选，先用“−”移除再重新添加），然后重启 miniQ。也可以到 miniQ「设置 → Computer Use」查看引导。**不要循环重试**。 |
| 截图全黑、只有壁纸或报屏幕录制错误 | 缺少「屏幕与系统录音」权限 | 在「隐私与安全性 → 屏幕与系统录音」中勾选 miniQ，然后重启 miniQ；纯 AX 操作不受影响，可以先继续 |
| `osascript` 报 -1743 或“不允许发送 Apple 事件” | 缺少「自动化」权限 | 在「隐私与安全性 → 自动化」中允许 miniQ 控制目标应用。首次运行时会弹窗，由用户点击“好” |
| `computer_use status` 显示被拒 | 同上两项之一 | 请用户到 miniQ「设置 → Computer Use」处理；不要替用户点系统授权弹窗 |
| 读取 `~/Library/...` 被拒 | 缺少「完全磁盘访问权限」 | 在「隐私与安全性 → 完全磁盘访问权限」中加入 miniQ |

权限修改后通常需要**重启 miniQ**才生效。miniQ 从终端启动时，授权对象是那个终端。

## 找不到窗口或元素
- **应用未运行**：先 `open -a "应用名"`，或按 bundle id `open -b com.apple.Notes`（启动会抢前台，需先告知用户），然后重新调用 windows。
- **中英文名称**：界面上叫“备忘录”，`open -a` 可以用 `Notes`；查询 bundle id：`osascript -e 'id of app "Notes"'`。
- **窗口在其他桌面空间、最小化或全屏**：windows 可能列不出来；征得用户同意后激活它。
- **AX 树很浅或为空**：可能是自绘界面（Electron 画布、游戏、远程桌面），改用窗口截图加像素点击。
- **元素 ID 失效**：每次输入都会让旧的 observationId 失效，必须使用最新返回的 ID；不要编造 ID。
- **分页**：inspect 结果被截断时，用同一个 observationId 加 `offset` 翻页，或用 `parentId` 展开具体子树。

## 操作无效
| 现象 | 尝试 |
|---|---|
| AXPress 后界面没变 | 重新 inspect 确认；检查是否弹出了模态对话框（它会拦截操作）；改用快捷键或像素点击 |
| setValue 后文本没有更新，或应用不认 | 先 `invoke AXPress` 聚焦该输入框，再用 `type {text}`；最后按 Tab 让应用提交 |
| key 无效 | 该面板没有焦点，改用 AX 控件；或者告知用户后改用 computer_use |
| 菜单项找不到 | 菜单栏属于应用根元素；也可以用 `osascript` 加 System Events 的 `click menu item`（需要自动化权限） |
| 文件选择器是空的 | 它在异步加载，稍后重新 inspect；按 ⌘⇧G 输入路径也可行（需要焦点） |

## 不要做
- 不要用 `sleep` 干等界面，重新观察即可。
- 不要在未确认效果的情况下重复同一个输入。
- 不要为了绕过权限问题改用 sudo、tccutil 等手段，除非用户明确要求，并了解后果。
