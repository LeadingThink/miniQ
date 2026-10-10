# 中文技能包与连接器扩充规范（2026-10-10）

本规范约束本批新增的内置插件包。所有包放在 `crates/miniq-plugins/bundled/<plugin-id>/`，`runtime = "skills"`，编译进 daemon。

## 1. 目录与清单

```
crates/miniq-plugins/bundled/miniq.official.<pack>/
├── manifest.toml
├── NOTICE.md              # 可选：注明来源与许可证
└── <skill-name>/
    ├── SKILL.md           # 必需
    ├── references/*.md    # 可选：按需加载的长资料
    └── tools/*.py|*.sh    # 可选：辅助脚本。禁止用 scripts/ 目录名（被 .gitignore 忽略）
```

`manifest.toml` 模板（字段固定，不要加别的键）：

```toml
id = "miniq.official.tencent-docs"
name = "腾讯文档"
version = "1.0.0"
api_version = "1.0.0"
runtime = "skills"
capabilities = ["skills"]
skills = ["tencent-docs", "tencent-smartsheet"]
requires = ["npx"]            # 可选，列 PATH 上需要的程序
description = "一句话说明整个包"
author = "miniQ"

[[mcp_servers]]               # 可选，可多个
name = "tencent-docs"         # ^[a-z0-9][a-z0-9-]{0,39}$
description = "腾讯文档官方远程 MCP（首次使用会在浏览器中 OAuth 登录）"
command = "npx"
args = ["-y", "mcp-remote@latest", "https://docs.qq.com/openapi/mcp"]
env = []                      # 只写变量名；值由用户在 daemon 环境中设置
```

规则：
- `id` 至少三段，小写。`skills` 中每一项是包内目录名，目录内必须有 `SKILL.md`。
- `[[mcp_servers]]` 只支持 stdio 命令。远程 HTTP/SSE 服务一律通过 `npx -y mcp-remote@latest <url>` 桥接；需要 Bearer 头时用 `"--header", "Authorization:Bearer ${VAR}"` 并在 `env` 中列出 `VAR`（mcp-remote 会展开 `${VAR}`；其他位置不会展开）。
- 全库 skill 名称必须唯一。新建前用 `find crates/miniq-plugins/bundled -maxdepth 2 -type d -name <name>` 检查。

## 2. SKILL.md 格式

```markdown
---
name: tencent-docs            # 与目录名一致；小写字母、数字、连字符
displayName: 腾讯文档读写
description: 当用户要在腾讯文档（docs.qq.com）中新建、搜索、读取、编辑在线文档/表格/幻灯片时使用……（写清触发词与不适用情形）
version: 1
origin: installed
requires:
  bins: [npx]                 # 可选
---

# 标题

## 适用场景
## 前置条件
## 步骤（每步写明用哪个 miniQ 工具）
## 注意事项 / 安全
## 如何确认完成
```

- frontmatter 只用上述字段。不要用 `allowed-tools`、`metadata`、`user-invocable` 等 WorkBuddy 字段。
- 正文全部中文；命令、标识符、API 名保持原文。
- 只引用 miniQ 实际存在的工具：`file_read` `file_list` `file_write` `file_edit` `file_glob` `file_grep` `apply_patch` `shell_run` `shell_batch` `git_status` `git_diff` `doc_read` `doc_write` `web_fetch` `web_search` `http_request` `memory_search` `memory_write` `task_update` `ask_user` `skill_read` `mcp_call` `browser_automation` `app_automation` `computer_use` `view_image` `view_pdf` `image_history` `generate_image` `edit_image` `generate_video` `generate_music` `synthesize_speech` `transcribe_audio` `agent_run` `process_output`。
- 不要写 WorkBuddy 专有工具（`Skill()`、`present_files`、`AskUserQuestion`、`editor_sdk`、`workbuddy_sites_deploy`、`ImageGen`、ardot/miora MCP）。
- MCP 用法固定写法：先 `mcp_call {server:"<name>", tool:"tools/list"}` 获取真实工具与 schema，再调用；写明"以 tools/list 返回为准"，不要把工具名写死为事实。
- 写操作（发送、发布、删除、付款、对外分享）必须先 `ask_user` 确认；明确列出哪些操作不可逆。
- 凭证：不让用户把 token 贴到对话；写明环境变量名或 OAuth 流程。
- 一个 skill 正文控制在 60–180 行；长资料放 `references/`，在正文里写"何时读取"。

## 3. 中文用户适配（每个 skill 都要落实）

- 时间：`YYYY-MM-DD HH:mm`，相对时间（昨天/本周/最近 7 天）要给出推算规则。
- 文件默认落点：`<工作区>/<中文语义目录>/`，如 `会议纪要/`、`公众号/`、`报告/`。文件名用中文或拼音连字符均可，禁止空格。
- 字体：生成 HTML/PDF/图片时指定中文字体栈 `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif`；PDF/图片生成前检查字体是否存在（`fc-list :lang=zh` 或 macOS 默认 PingFang），缺失时提示安装 Noto Sans CJK。
- 中文排版：中西文之间加空格；使用全角标点；正文行高 1.7；段落首行不缩进而用段距；数字用千分位或"万/亿"；避免孤行。
- 网络：npm 慢时提示 `npm config set registry https://registry.npmmirror.com`；前端库 CDN 首选 `https://cdn.jsdelivr.net/npm/...`，备用 `https://registry.npmmirror.com/<pkg>/<ver>/files/<path>`。
- 国内平台术语用官方中文名：腾讯文档、腾讯会议、企业微信、飞书、金山文档、TAPD、微云、腾讯问卷、企查查、公众号、小红书。

## 4. 视觉语言（生成任何可视化产物时遵守）

所有产出 HTML/SVG/PNG/PDF/PPT 的 skill 读取 `miniq.official.visual-language/visual-language-core/SKILL.md` 和其 `references/tokens.md`。核心原则：

1. **留白优先**：页边距 ≥ 48px（移动端 24px），卡片内边距 24px，模块间距 32–48px。
2. **一个主色**：从"中国传统色"色板选一个主色（如 黛蓝 #2B4C7E、朱砂 #C8323B、松绿 #2E8B57、杏黄 #E8A33D、青灰 #6C7A89），其余用中性灰阶。数据系列用固定 6 色板，同一实体全程同色。
3. **字体层级**：标题 28–36px/600，小标题 18–20px/600，正文 15–16px/400，辅助 13px；行高标题 1.3、正文 1.7。中文不用斜体。
4. **结论先行**：图表标题是结论句，副标题写口径与时间范围，底部注明数据来源与截至日期。
5. **可读的数字**：千分位、单位、`tabular-nums`；涨跌用 朱砂/松绿 并配箭头，不只靠颜色。
6. **克制的装饰**：无 3D、无阴影堆叠、无彩虹色、无渐变文字；圆角 8–12px；分割线 1px 中性色。
7. **深浅色自适应**：用 CSS 变量定义 token，`prefers-color-scheme` 自动切换。
8. **自检**：生成后必须渲染截图（`browser_automation` 起本地 http 服务，或 `view_image`）并逐项核对：中文无方块、无截断、无重叠、对齐、对比度 ≥ 4.5:1。

## 5. 质量门槛

- 每个 skill 至少写 3 条用户原话作为触发示例。
- 每个包至少 2 个 skill（单一连接器包可 1 个）。
- 不编造 API 端点、工具名、参数；不确定的写"以 tools/list / --help 为准"。
- `cargo test -p miniq-plugins` 必须通过（校验 manifest、frontmatter、名称唯一）。
