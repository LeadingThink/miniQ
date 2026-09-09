# 原生预览与阅读交互验收（2026-09-10）

本轮在用户明确允许本地安装、重启后，将上一轮预览改进装入 `/Applications/miniQ.app`，反复检查真实 macOS WebView，修复实际发现的问题，再安装复验。版本保留 `0.1.23`；这次是本地更新，不是新的公开安装包发布。

## 对比依据与范围

对比依据包括本机 ChatGPT 安装包中 `artifact-preview-header`、`chatgpt-code-block`、`conversation-markdown`、`pdf-preview-panel` 等前端模块的功能结构，以及 OpenAI 官方的文件预览说明。重点学习分栏阅读、文件工具栏、源码切换、页码控制和长内容阅读，没有复制客户端代码。

计算机控制工具不允许操作 ChatGPT 本体，因此本轮不声称完成了两个客户端的同任务性能基准。miniQ 的操作与截图验收均来自实际安装的原生客户端。

## 修复和交互改进

| 范围 | 现在的行为与依据 |
| --- | --- |
| 原生源码空白 | 原生控制台显示动态样式被 CSP 拒绝。响应头含 `style-src 'self' 'unsafe-inline' 'nonce-…'`，nonce 使 inline 许可失效。仅停止 Tauri 向 `style-src` 自动注入 nonce，恢复已声明的动态样式策略；源码高亮在安装后的普通构建恢复。脚本策略、文件权限和 HTML 隔离保持原有约束。 |
| 直接打开文件 | 会话工具栏增加项目文件预览入口，支持相对路径、完整路径和系统文件选择器，不需要模型执行任务。文件读取继续经过工作区范围校验。 |
| 会话切换 | 文件选择器晚返回时不能打开到另一个会话；切换会话关闭路径输入框。原生检查不同会话各自保留文件标签。 |
| 预览展开 | 可扩展到整个工作区，再恢复分栏；文档保持挂载，避免为了改变面板大小重新解析。 |
| WebKit 键盘焦点 | WebKit 鼠标点击按钮不一定获得焦点。展开按钮显式接收焦点，保证 Esc 能恢复分栏；原生复验通过。 |
| 文件标签 | 当前标签自动进入可见区域；鼠标或键盘关闭标签后，焦点回到当前标签。 |
| 同名文件 | 显示最短可区分目录，如 `miniq-preview-qa` 与 `other`，而不是两个都被省略成相同开头的绝对路径；完整路径仍在提示和文件头中。 |
| 文档页码输入 | 输入多位页码时只编辑草稿，在 Enter 或失焦时跳转；Esc 恢复当前页，避免每输入一位就重新渲染页面。 |
| Office 页码定位 | 只滚动文档自身，不带动应用祖先容器；短末页与前一页同时可见时，滚到底部保持最后一页页码。原生 PPT 从第 1 页输入 14，稳定保持 14/14。 |
| SVG 原始尺寸 | 原生独立样例确认，WebKit 对有 CSS 宽度约束的 SVG 返回缩小后的 naturalWidth。改为在未挂入 DOM 的图片上读取固有尺寸，900×450 的文件现在正确显示 900×450，100% 缩放也使用真实尺寸。 |
| SVG 生命周期 | 切换文件时移除旧测量回调、释放 Blob URL；旧尺寸不会覆盖新文件，解析失败走现有错误提示。 |
| 代码块 | 增加语言标识、常驻复制与自动换行按钮；复制完整代码，不包含工具栏文字。原生长中文代码换行与“已复制”反馈已验证。 |
| 长回复渲染 | 内容、路径和渲染选项不变时复用 Markdown 子树，避免另一个消息流式输出时反复解析已有内容；事件桥接仍调用最新会话回调。没有用截断缩短内容。 |
| 历史消息 | 移除历史气泡重复进场动画，保留静态阅读位置。 |
| 窄栏工具栏 | 控件文字保持单行，较窄状态栏使用图标节省空间，搜索栏可换行；只在状态栏建立尺寸容器，避免约束设置等弹窗。 |
| 主题适配 | 原生检查浅色和夜墨主题的代码、文件头、文档纸张及设置弹窗。验收后恢复用户原来的薰衣草田主题。 |

## 实际原生验收

使用独立的 `预览验收` 项目和 `原生预览验收（无模型任务）` 会话。没有发送模型请求，没有取消用户任务。

- Markdown：目录、标题跳转、本地相对图片、Mermaid 流程图、公式、完整代码换行与复制。
- 源码：普通安装构建中 Monaco 行号、中文文本、语法高亮、展开及 Esc 恢复正常。
- Word：真实 DOCX 表格、白色纸张、宽度适配及深色工具栏。
- PPTX：真实 14 页演示文件，中文、表格和图表显示，末页跳转稳定。
- PDF：Mozilla 14 页文档正常显示；第 12 页跳转、适配宽度和文字层检查。早期出现过等待渲染，激活窗口后的后续普通构建未复现；未据此加入猜测性的 Worker 替代或后台节流配置。
- CSV：10,003 行数据（含表头），搜索 10002 能找到最后一条记录，金额 69993；引号内逗号和换行保留。
- HTML：隔离预览中相对图片成功加载，点击“增加”后计数从 0 变成 1。
- SVG：矢量图显示正常，原生尺寸诊断样例证明并验证固有尺寸修复。
- 会话隔离：进入已结束的牛顿法会话时验收文件标签消失，返回验收会话时恢复其自己的标签。也检查了真实长回复与数学公式的阅读画面。

## 可复现材料

`apps/desktop/scripts/create-preview-fixtures.mjs` 生成不含用户会话或账号数据的 Markdown、CSV、SVG、HTML 和同名文件样例。运行方式：

```sh
cd apps/desktop
node scripts/create-preview-fixtures.mjs /path/to/isolated-preview-qa
```

Office / PDF 样例单独下载到该目录，来源为：

- `document.docx`：https://raw.githubusercontent.com/VolodymyrBaydalka/docxjs/master/tests/render-test/table/document.docx
- `slides.pptx`：https://501351981.github.io/pptx-preview/examples/dist/test.pptx
- `document.pdf`：https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf

本机样例在 `/Users/xuzhanwei/.local/share/miniq-preview-qa`。旧应用、CLI 与更新前数据库快照保存在 `/Users/xuzhanwei/.local/share/miniq-local-preview.MsVZsZ`，没有用快照覆盖当前会话数据。

## 自动检查与本地安装

- 最终相关回归：24 个测试文件、81 项测试通过，覆盖预览生命周期、文件隔离、页码、Markdown、代码复制、图片、表格、CSP 与窄栏宽度。
- TypeScript 检查、相关文件 Prettier 检查、`git diff --check` 通过。
- 普通 Tauri app 构建成功，不包含临时的 devtools 构建特性。后台与 CLI 同样由本分支源代码构建。
- 每次安装先检查后台空闲；`daemon.shutdownIfIdle` 返回接受，取消任务数和子 agent 数均为 0。
- 最终安装文件与构建产物 SHA-256 一致：`fd9a247ef5caaf56b813f66f65e17da1a8a9625c5e928b69de71a239283b7818`。
- 重启后 `daemon.health` 正常，版本为 `0.1.23`，支持空闲关闭；未修改公开下载链接或更新元数据。

## 仍有边界

这些结果覆盖本轮文件预览和阅读交互，不等于历史优化清单已全部完成。Excel 的完整样式/公式/图表保真、Office 动画和复杂嵌入对象、PDF 表单批注、文档区域评论，以及超大文件流式读取等仍需要独立实现和验收。Apple Developer 签名与公证继续按用户决定暂缓。
