---
name: figma-create-new-file
description: 需要新建空白 Figma 设计文件、FigJam 白板或 Figma Slides 演示文稿（例如在用 use_figma 生成设计/图表/幻灯片前需要一个新文件）时使用；调用 create_new_file 前必须先加载本技能
version: 1
---

# 新建 Figma / FigJam / Slides 文件

## 触发场景
- “帮我新建一个 Figma 文件/FigJam 白板/Slides 演示”。
- 其它技能（`figma-generate-design`、`figma-generate-diagram`、`figma-use-figjam`、`figma-use-slides`、`figma-generate-library`）需要一个全新文件承载内容，而用户没有给出现有文件链接。

## 参数
- `editorType`：`design`（默认）、`figjam`、`slides`。用户说“白板/流程图/便签”→ `figjam`；“幻灯片/演示/汇报”→ `slides`；其余 → `design`。
- `fileName`：用户给的名称；未给时根据任务起一个有意义的名字（例如“登录页设计探索”），实在无从判断用 `Untitled`。

## 前置条件
- 必须使用远程 `figma` 连接器（`npx -y mcp-remote@latest https://mcp.figma.com/mcp`，浏览器 OAuth 登录）。`create_new_file` 属于写入类工具，`figma-desktop` 本地服务器通常不提供；以 `tools/list` 为准。
- Figma 可能拒绝非目录客户端；被拒时无法用 MCP 新建（REST API 也不支持创建文件）。回退：请用户在 Figma 中手动新建（或在浏览器打开 https://www.figma.com/design/new 、FigJam 用 https://www.figma.com/board/new ），然后把链接发回来。
- 这是在用户账号中创建内容的操作：调用前 `ask_user` 确认文件类型、名称与所属团队（可与第 1 步合并确认）。

## 分步流程

### 1. 确定 `planKey`
`create_new_file` 需要 `planKey`（决定文件建在哪个团队/组织的草稿里）。
1. 用户已提供（或本会话之前 `whoami` 已拿到）→ 直接用。
2. 否则 `mcp_call`：`{"server":"figma","tool":"whoami","arguments":{}}`，返回 `plans` 数组（每项含 `key`、`name`、`seat`、`tier`）。
   - 只有一个 plan → 直接用它的 `key`。
   - 多个 plan → `ask_user` 让用户选择团队/组织（选项展示 `name` + `tier`），不要擅自挑选。
   - 注意 `seat`：只读/查看席位（view）可能无法创建或编辑文件，发现时提前告知用户。

### 2. 调用 `create_new_file`
```json
{"server":"figma","tool":"create_new_file","arguments":{"planKey":"team:123456","fileName":"登录页设计探索","editorType":"design"}}
```
三个参数都必填；`editorType` 只能是 `design` / `figjam` / `slides`。

### 3. 使用结果
- 返回 `file_key` 与 `file_url`。把 `file_url` 发给用户，`file_key` 作为后续 `use_figma` 等调用的 `fileKey`。
- 文件位于所选 plan 的**草稿（Drafts）**中；如需移到某个项目，请用户在 Figma 中移动（MCP 无移动接口）。
- 下一步要用 `use_figma` 写内容时，**先用 `skill_read` 加载 `figma-use` 技能**；FigJam 再加载 `figma-use-figjam`，Slides 再加载 `figma-use-slides`。

## 各类型文件的注意点
- **design**：新文件只有一个空页面 `Page 1`；生成设计前可按需要重命名页面或新建页面。
- **figjam**：空白画布；图表类内容交给 `figma-generate-diagram`（优先 `generate_diagram`）。
- **slides**：新文件里**一张幻灯片都没有**，幻灯片网格为空（`figma.getSlideGrid()` 返回空数组，页面下只有一个空的 `SLIDE_GRID` 节点）。后续脚本若假设“至少有一张幻灯片”（例如读取第一张的主题），要先判空或先调用 `figma.createSlide()`（首次调用会自动建第 0 行）。

## 失败与回退
| 现象 | 处理 |
|---|---|
| `tools/list` 无 `create_new_file` | 当前连接器不支持（常见于 `figma-desktop`）；改用 `figma` 远程或请用户手动新建 |
| 403 / 客户端未授权 | 说明 Figma 限制，请用户手动新建后提供链接 |
| planKey 无效 / 无权限 | 重新 `whoami`，让用户重选团队；检查席位 |
| 同名文件 | Figma 允许同名，无需处理；如用户在意可加日期后缀 |
不要为“重试”而重复创建多个文件：失败前先确认上次调用是否已经创建成功（看返回或请用户查看草稿）。

## 交付
- 文件类型、名称、所属团队、`file_url`；后续计划（例如“接下来用 figma-generate-diagram 在此文件画流程图”）。
