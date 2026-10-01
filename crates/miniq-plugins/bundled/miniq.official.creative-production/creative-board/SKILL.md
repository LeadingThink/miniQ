---
name: creative-board
displayName: 创意看板
description: 创意看板：用本地 board.json + 自包含 HTML 追踪多方向出图的占位、完成、失败、重试、选中与淘汰，并渲染网格或对比视图供用户挑选。生产多方向素材或需要让用户比较选择时使用。
version: 1
---

# 创意看板

## 触发场景
- `creative-asset-produce` 一次生成 ≥2 个方向，需要统一登记与展示。
- 用户说“把几个方案放一起看”“我选第 2 和第 4 个”“把淘汰的去掉”“重做这张”。
- 并行子任务（`agent_run`）需要一个共享的、防并发冲突的结果登记处。

## 前置条件
- `python3`（仅标准库）。脚本：本技能 `scripts/board.py`，下文用 `B="python3 <本技能绝对路径>/scripts/board.py"` 表示。
- 看板目录默认 `creative/board`，可用 `--board <目录>` 或环境变量 `CREATIVE_BOARD` 指定。
- 详细数据结构、并发与渲染说明见 `references/board-runtime.md`（需要排查问题或扩展时再读）。

## 分步流程
1. **初始化**：`$B init --title "<项目名>" --summary "<目标一句话>"`（已存在时不覆盖；`--force` 重建前先 `ask_user`）。
2. **登记占位**：批量 `$B begin --from-json creative/directions.json`（`variants.py` 输出）；或单条 `$B begin --id ads-01-hero --label "英雄主图" --direction "英雄主图" --mode ads --tool generate_image --prompt "..."`。衍生变体加 `--parent <父 id>`。
3. **登记结果**：每张图生成后 `$B complete --id <id> --image <路径>`（自动读取 PNG/JPEG/GIF/WebP 尺寸；.mp4/.mov 识别为视频，音频同理）。失败 `$B fail --id <id> --reason "..."`；准备重做 `$B retry --id <id> --prompt "<新提示词>"`。
4. **查看状态**：`$B read`（摘要）、`$B read --json`、`$B read --id <id>`；确认没有遗留 pending 再交付。
5. **渲染**：`$B render` → `creative/board/board.html`。
   - `--layout compare`：选中项并排大图，适合终选；
   - `--group auto|direction|none`：grid 分组方式（auto：每组只有一张时合并为一组，方向名显示在卡片上）；
   - `--only-selected`、`--hide-rejected`：过滤；`--out` 指定输出路径。
6. **目视检查**：`browser_automation` 打开 `file://<board.html 绝对路径>` 截图；或 `bash <creative-layout-deliver>/scripts/render.sh creative/board/board.html 1400x900 creative/board/board.png` 后 `view_image`。
7. **记录选择**：用户决定后 `$B select --id a --id b [--exclusive] --note "理由"`、`$B reject --id c`、`$B unmark --id d`；删除条目 `$B delete --id x`（先确认）。
8. **日志**：关键决策 `$B log --message "用户选定暖色路线" --kind decision`；`$B log --tail 20` 查看。

## 工具与参数要点
- 所有命令通过 `shell_run` 执行；路径可相对当前目录，脚本内部统一解析为真实路径，HTML 中写相对路径，整个 `creative/` 目录可直接打包。
- 并行子任务同时写看板是安全的（跨进程锁 + 原子替换）；子任务只调用 `complete` / `fail` / `log`，不要 `init --force` 或 `delete`。

## 质量检查
- `read` 输出中的计数：done 数 = 应交付数；failed 项都有原因。
- 渲染后的截图用 `view_image` 看：图片均能加载（无破图）、选中标记正确、方向名称正确。

## 失败回退
- 锁超时（报“看板被占用”）：等待几秒重试；若进程已崩溃，锁超过 120 秒会自动视为过期。
- board.json 损坏：脚本会报错并保留原文件；用 `file_read` 查看并手工修复，或另建新看板目录重新 `begin`。
- 无法渲染截图：直接把 board.html 路径告诉用户，并逐条文字列出方向。

## 交付格式
- 对用户：先按方向逐一一句话介绍 + 推荐项，再请用户选择；最后附上 `board.html` 路径。
- 文件：`creative/board/board.json`、`creative/board/board.html`（可选 `board.png`）。
