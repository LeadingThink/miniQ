---
name: figma-rest-export
description: 当用户在 Figma MCP 不可用时需要用个人访问令牌批量读取 Figma 文件结构、导出图层切图（PNG/SVG/PDF）时使用
origin: installed
requires:
  bins: [python3]
---

# Figma REST API 读取与切图导出

## 适用场景
- Figma MCP 连接被拒或用户没有 Dev 席位，但持有 Figma 个人访问令牌。
- 批量导出图标、插画、画板为 PNG/SVG/PDF，放入代码仓库。
- 读取文件图层结构、文本内容，做内容盘点或设计走查。

## 前置条件
- 环境变量 `FIGMA_TOKEN`：在 Figma「设置 → 安全 → 个人访问令牌」中生成（只需文件只读权限）。由用户在 miniQ 设置或终端环境中配置，**不要**让用户把令牌贴到对话里。
- 用户对目标文件有查看权限。

## 步骤
1. **确认令牌存在**（`shell_run`）：`test -n "$FIGMA_TOKEN" && echo ok || echo missing`（不要打印令牌值）。缺失时用 `ask_user` 请用户在设置中配置。
2. **解析链接**：`fileKey` 为 URL 中 `/design/` 或 `/file/` 后的一段；`node-id=12-34` 在 API 中写作 `12:34`。
3. **读取结构**（`shell_run`，用 curl 并通过环境变量带令牌）：
   ```bash
   curl -s -H "X-Figma-Token: $FIGMA_TOKEN" "https://api.figma.com/v1/files/$KEY?depth=2" -o /tmp/figma-file.json
   curl -s -H "X-Figma-Token: $FIGMA_TOKEN" "https://api.figma.com/v1/files/$KEY/nodes?ids=12:34" -o /tmp/figma-node.json
   ```
   用 `file_read` 或 `python3 -m json.tool` 查看；大文件先限制 `depth`。
4. **导出切图**（`shell_run`）：使用本技能脚本（先 `file_read` 查看用法）：
   ```bash
   python3 scripts/figma_export.py --file-key $KEY --ids 12:34,56:78 --format svg --out assets/figma
   python3 scripts/figma_export.py --file-key $KEY --ids 1:2 --format png --scale 2 --out assets/figma
   ```
   脚本调用 `GET /v1/images/:key?ids=...&format=...&scale=...` 获取临时下载链接，再逐个下载。
5. **检查结果**（`glob` 列出文件，`view_image` 抽查 PNG）：确认数量、尺寸、透明背景是否正确；SVG 可用 `file_read` 检查是否含多余的内嵌位图。
6. **汇报**：列出导出文件路径与对应节点名。

## 注意事项 / 安全
- 令牌只从环境变量读取，命令和日志中不要出现明文令牌；不要把令牌写进仓库文件。
- 该 API 只读；本技能不做任何写入 Figma 的操作。
- 注意速率限制（HTTP 429）：减少单次请求 id 数量并稍后重试。
- 导出链接是临时的，应尽快下载；设计资产的使用需符合团队授权。
- 参考：https://developers.figma.com/docs/rest-api/file-endpoints/
