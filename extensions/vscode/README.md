# miniQ Terminal Integration

在可信任的 VS Code 项目中打开 miniQ 终端会话，共用 miniQ 已有的项目与会话数据。

先安装 miniQ 官方终端包，并在用户设置 `miniq.executablePath` 中填写本机原生可执行文件的绝对路径。默认使用 macOS/Linux 的 `~/.local/bin/miniq` 或 Windows 的 `%LOCALAPPDATA%\miniQ\bin\miniq.exe`。路径不能包含命令参数，Windows 不支持 `.cmd` 或 `.bat`。Remote SSH 使用远端扩展宿主上的 miniQ 和文件。

打开项目后，在命令面板搜索 `miniQ`：新建项目聊天、选择会话恢复、恢复最近会话、列出项目会话、检查连接与依赖。多根工作区会先选择项目。

“Open Chat with Current Saved File” 会先展示附件确认。miniQ 读取整个已保存文件，提交提示词后可能发送给配置的模型服务商。未保存文件、项目外文件和指向项目外的符号链接会被拒绝。

## 本地开发和安装

在本目录运行 `npm ci`、`npm test`、`npm run check`，然后执行 `npm run package` 生成 VSIX。通过 VS Code 的 “Extensions: Install from VSIX...” 安装。开发调试可在本目录按 F5 启动 Extension Development Host。

当前验证涵盖命令与参数、工作区信任和附件边界的本地模拟测试；真实 VS Code、Remote SSH 和跨平台安装仍需实机验证。此扩展尚未发布到 Marketplace。
