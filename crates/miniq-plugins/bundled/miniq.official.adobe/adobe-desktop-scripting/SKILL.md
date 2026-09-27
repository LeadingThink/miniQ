---
name: adobe-desktop-scripting
description: 当用户想让 miniQ 操作本机已安装的 Photoshop 或 Illustrator（批量导出/缩放、播放动作、导出画板、界面操作）或需要编写 ExtendScript/UXP 脚本时使用
origin: installed
requires:
  bins: [osascript]
---

# 本机 Photoshop / Illustrator 自动化

## 适用场景
- 一个文件夹的照片用 Photoshop 动作统一处理后，按长边缩放并导出 JPG/PNG。
- Illustrator 文件中的每个画板批量导出为 PNG（可倍率）或 SVG。
- 需要定制脚本（改图层文字、替换智能对象、批量套版等）或 Adobe 云端 MCP 不可用时的本地退路。

## 前置条件
- **macOS**，已安装并登录 Photoshop 和/或 Illustrator（需要有效的 Creative Cloud 订阅）。
- 执行方式为 AppleScript `do javascript` 调用 ExtendScript：首次运行时 macOS 会弹出“自动化”权限请求，须由用户本人在系统设置中允许，miniQ 不代为处理。
- 本技能脚本：`scripts/run_jsx.sh`（注入参数并执行）、`scripts/ps_batch_export.jsx`、`scripts/ai_export_artboards.jsx`。
- Windows：本插件脚本不支持；可告知用户在 Windows 上通过 COM 对象（`Photoshop.Application` / `Illustrator.Application`）的 `DoJavaScriptFile` 执行同一 .jsx，但需用户自行运行。

## 步骤
1. **检查环境**：`shell_run` 执行 `osascript -e 'id of application id "com.adobe.Photoshop"'`（Illustrator 为 `com.adobe.illustrator`）确认已安装；未安装则告知用户并改用 `adobe-creativity-cloud` 或 miniQ 原生 `edit_image`。
2. **确认任务**（`ask_user`）：输入/输出目录、格式与质量、长边尺寸、要播放的动作（动作组名 + 动作名须与 Photoshop“动作”面板完全一致）、是否允许覆盖同名文件。脚本默认**不修改原文件**、同名输出跳过。
3. **先跑样张**：把 1-2 个文件复制到临时目录试运行，`view_image` 检查结果，再处理全部。
4. **Photoshop 批量导出**（`shell_run`）：
   ```bash
   bash scripts/run_jsx.sh photoshop scripts/ps_batch_export.jsx \
     input="$HOME/Pictures/raw" output="$HOME/Pictures/out" format=jpg quality=10 maxEdge=2048 \
     actionSet="<动作组名>" action="<动作名>"
   ```
   返回值会列出成功数与失败原因。
5. **Illustrator 导出画板**（`shell_run`）：
   ```bash
   bash scripts/run_jsx.sh illustrator scripts/ai_export_artboards.jsx \
     input="$HOME/Design/icons.ai" output="$HOME/Design/export" format=png scale=2
   ```
6. **定制脚本**：需求超出以上两个脚本时，用 `file_write` 写新的 .jsx（ES3 语法：只用 `var`、无箭头函数、无原生 `JSON`；参数通过全局 `ARGS` 读取），并遵守“另存为副本、处理完 `close(DONOTSAVECHANGES)`”的原则；先给用户看脚本要点再运行。UXP 插件（Photoshop 新一代扩展）需要通过 Adobe UXP Developer Tool 加载，无法由 miniQ 从外部直接执行，只提供代码与安装说明。
7. **界面操作退路**：脚本无法覆盖的菜单/面板操作，使用 `app_automation`：`windows` 找到 Photoshop/Illustrator 窗口 → `inspect` 读取可访问控件 → 优先 `invoke` 菜单项；自绘画布区域需先 `screenshot` 再按截图坐标 `click`，每步后重新观察确认效果。Adobe 应用的可访问性树不完整，这种方式慢且脆弱，只用于少量步骤。
8. **验收**：`glob` 统计输出文件数量与输入一致，抽样 `view_image`，汇报失败文件清单。

## 注意事项 / 安全
- 运行任何会写文件的脚本前 `ask_user` 确认输入输出路径；绝不覆盖原图，`overwrite=1` 只在用户明确要求时使用。
- 批处理期间 Photoshop/Illustrator 会被占用并可能弹窗打断用户当前工作，事先提醒。
- 不运行来源不明的 .jsx/.atn；ExtendScript 拥有本机文件读写权限，等同执行代码。
- 字体缺失、链接图丢失、色彩配置文件不一致会导致结果偏差，应在汇报中说明。
- 参考：Adobe Photoshop/Illustrator Scripting 文档 https://developer.adobe.com/photoshop/ 、https://developer.adobe.com/illustrator/
