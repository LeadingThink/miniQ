# miniQ 既往产品对比、未完成项与历史技术债务汇总

> 综合梳理自历史对比档案：`docs/side-panel-comparison-2026-09-20.md`、`docs/experience-improvement-ledger.md`、`docs/remaining-optimizations-2026-09-09.md`、`docs/computer-use-audit.md` 与 `docs/multi-agent-harness-audit.md`。

---

## 一、既往比对总结与已补齐项

在过去的迭代周期中（2026 年 9 月前后），miniQ 重点攻克了以下技术难关：
1. **多端会话与远程打通**：通过 `services/relay` 打通 Android 与 iOS 客户端，支持移动端随时向桌面守护进程派发任务。
2. **三栏工作台与侧边面板**：引入了统一的右侧工作面板（Workbench），实现了内嵌浏览器多标签、文件源码与富文本预览、审阅导航。
3. **后台与前台计算机操控**：完成了 `app_automation`（AXUIElement 无干扰后台控制）与 `computer_use`（前台键鼠接管）的双重引擎，通过了 UI-TARS 标准下的交互审计。
4. **沙箱隔离与多工作树（Worktree）**：增强了 Git 工作树隔离，避免多任务并发修改同一代码目录发生冲突。

---

## 二、历史对比中明确指出的「已知差距与待解决清单」

查阅 `docs/side-panel-comparison-2026-09-20.md` 与 `docs/remaining-optimizations-2026-09-09.md`，此前团队记录但在后续版本中仍待深化的核心项包括：

1. **工作台内容连续性与统一选区提问**：
   - 历史定性：ChatGPT 能把不同内容组织在极其紧凑的工作台中，用户可以一边看网页、代码和修改，一边直接高亮任意局部内容并「带回对话」。miniQ 虽然有了多面板，但从工作台选中某段代码/某张网页图片一键回填到 Composer 提问的链路还不够顺滑。
2. **跨面板拖拽与原生终端无缝挂载**：
   - 历史定性：ChatGPT 允许在右侧面板与底部终端自由拖拽文件、终端上下文一键导出，miniQ 的终端主要为固定区域展示，交互自由度不足。
3. **Office 文档的精确批注与视觉审阅**：
   - 历史定性：缺乏在生成的 Word、PPT、Excel 页面上直接划线打批注的能力，目前仍以全量重新生成为主。
4. **后台运行防休眠（Power Management）**：
   - 历史定性：在 macOS 上执行 10 分钟以上的深度长任务时，若用户合盖或系统进入省电休眠，后台守护进程网络与定时器可能被降频挂起。必须支持 `IOPMAssertionCreateWithName`（macOS C-API）对系统休眠实施临时阻止。
5. **外部专业编辑器联动（External IDE Deep Integration）**：
   - 历史定性：ChatGPT 支持在常规设置中绑定默认编辑器（VS Code / Cursor / Zed），代码生成或 Git Diff 产生后，界面提供专属图标直接在外部编辑器中跳转到指定行号。miniQ 仍主要在内置预览中展示。
6. **定时自动化看板（Automations UI）**：
   - 历史定性：miniQ 有脚本调度与 cron 能力，但一直缺少一个视觉化的专属一级页面，导致普通用户无法感知和管理自己的周期性工作流。
