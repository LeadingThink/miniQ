# WorkBuddy 技能与连接器对标（2026-10-10）

## 证据来源

| 项 | 路径 | 说明 |
|---|---|---|
| WorkBuddy 内置技能 | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/` | 27 个 |
| WorkBuddy 内置插件 | 同上 `builtin-plugins/`（sheetagent、tencent-docs-plugin、tencent-docx、tencent-pptx、weixinpay） | 19 个 skill |
| WorkBuddy 技能市场 | `~/.workbuddy/skills-marketplace/.codebuddy-skill/marketplace.json` | 230 个 |
| WorkBuddy 连接器市场 | `~/.workbuddy/connectors-marketplace/.codebuddy-connector/connectors.json` + `connectors/*/mcp.json` | 19 个 |
| miniQ 内置 | `crates/miniq-plugins/bundled/`（40 包）+ `crates/miniq-skills/assets/`（11 个） | 395 个 skill |
| Claude Code 热门 | skills.sh 排行、mattpocock/skills、anthropics/skills、obra/superpowers | 见本文第 4 节 |

## 1. WorkBuddy 连接器 → miniQ 状态

WorkBuddy 连接器 = 一个 MCP/CLI 配置 + 配套 SKILL.md。miniQ 对应物是插件 manifest 的 `[[mcp_servers]]` + skill。

| 连接器 | 类型 | 端点（已探测） | miniQ 原有 | 本次新增 |
|---|---|---|---|---|
| 腾讯文档 | MCP | `https://docs.qq.com/openapi/mcp`，401+OAuth 动态注册 | 无 | `tencent-office/tencent-docs`、`tencent-smartsheet` |
| 腾讯会议 | CLI `@tencentcloud/tmeet` | — | 无 | `tencent-office/tencent-meeting` |
| 腾讯问卷 | MCP | `https://wj.qq.com/api/v2/mcp`，401+OAuth | 无 | `tencent-office/tencent-survey` |
| 微云 | MCP | `https://www.weiyun.com/api/v3/mcpserver`，401+OAuth | 无 | `tencent-office/tencent-weiyun` |
| 腾讯乐享 | MCP | `https://mcp.lexiang-app.com/mcp`，401+OAuth | 无 | `tencent-office/tencent-lexiang` |
| TAPD | MCP | `https://websocket.tapd.cn/mcp/mcp`，401+OAuth | 无 | `tencent-office/tapd-workitems` |
| 企业微信 | CLI `@wecom/cli` | — | 无 | `cn-collab/wecom-messages`、`wecom-schedule-todo`、`wecom-docs` |
| 飞书 | CLI `@larksuite/cli` | — | 无 | `cn-collab/feishu-suite` |
| 金山文档 | MCP | `https://mcp-center.wps.cn/skill_hub/mcp`，initialize 200 | 无 | `cn-collab/kdocs` |
| QQ 邮箱 | MCP | `https://api.mail.qq.com/mcp`，401+OAuth | 无 | `cn-collab/qq-mail` |
| 企查查 | MCP | `https://agent.qcc.com/mcp/company/stream`，401+OAuth | 无 | `cn-collab/qcc-company` |
| Notion | MCP | `https://mcp.notion.com/mcp` | `miniq.official.notion`（7 skill） | — |
| GitHub | MCP | `https://api.githubcopilot.com/mcp/` | `miniq.official.github`（3 skill + MCP） | — |
| Jira | stdio | `atlassian-jira-mcp-server` | `miniq.official.atlassian`（2 skill + MCP） | — |
| Supabase | MCP | `https://mcp.supabase.com/mcp` | `miniq.official.supabase`（4 skill + MCP） | — |
| Gmail / 163 邮箱 | stdio `mcp-email` | 需账号密码环境变量 | 无 | 未做（通用 IMAP 方案风险高；`email-draft` 已覆盖起草；后续可加 `mcp-email` 包） |
| 百度网盘 | SSE | 需 `BAIDU_NETDISK_ACCESS_TOKEN` | 无 | 未做（token 获取需用户在百度开放平台手工申请；下一批） |
| 福帮手 | MCP | 私有生态 | 无 | 不做（垂直私有生态） |

MCP 接入机制：miniQ 只支持 stdio，远程端点全部用 `npx -y mcp-remote@latest <url>` 桥接；OAuth 在浏览器完成，与现有 notion/linear 包一致。

## 2. WorkBuddy 内置技能 → miniQ 状态

| WorkBuddy 内置 | 能力 | miniQ 对应 |
|---|---|---|
| ardot-design-core / ui-design / slides / poster / design-to-code / livestream-poster | Ardot 画布（私有 MCP）设计稿 | 私有画布无法移植。设计方法论吸收进 `visual-language`（poster-cn、web-deck-cn）与现有 `product-design-*`、`figma-*` |
| miora-creative-core / image / video / brand-design | 生图生视频决策层（费用确认、意图判定、锚点链） | 现有 `creative-production` 4 skill 已覆盖；本次在 `poster-cn` 补"底图生成 + 文字层分离" |
| design-router | 设计任务路由 | 现有 `product-design-router` |
| tencent-docs-routing / tencent-local-office-edit | 本地 Office 文件路由与实时编辑（editor_sdk） | editor_sdk 为私有；miniQ 走 `doc_read`/`doc_write` + `document-workflow`/`spreadsheet-workflow`/`presentation-workflow` |
| tencent-docx（9 子 skill：design-token→doc-typeset→html-review→html-to-docx） | 文档排版流水线 | 本次 `visual-language/cn-typography` 吸收其分阶段思想 |
| tencent-pptx / sheetagent | PPT/Excel 生成 | 现有 `presentation-workflow`、`spreadsheet-workflow`、`data-report-office` |
| wb-finance-skill | 金融总入口路由 | 本次 `cn-finance/finance-router` |
| library | 资料库/空间（私有） | 不做；miniQ 用工作区 + `memory_*` |
| sites（发布为应用） | 一键发布到云端链接 | 现有 `web-deploy`（vercel/netlify/cloudflare）+ `data-publish-html` |
| skill-creator | 创建技能 | 现有 `writing-skills` + 任务蒸馏 |
| recommend-connectors / recommend-experts / marketplace-skill-installer | 市场推荐卡片 | miniQ 插件页承担；无需 skill |
| expert-manager | 专家包生命周期 | 不做（WorkBuddy 专有概念） |
| geo-map-compliance-guard | 地图合规 | 未做；后续在 `travel-plan-cn` 补一句合规提醒 |
| wecom-forwarded-chat-resources | 企微转发聊天资源 | 不做（宿主注入） |
| buddy-image-processing / multimodal-generation | 去水印/修图/3D/模板视频 | 部分由 `edit_image`/`generate_video` 原生覆盖 |
| weixinpay-* | 微信 AI 支付 | 不做（需微信私有能力） |

## 3. WorkBuddy 市场 230 技能 → 按类别覆盖

| 类别 | 数量 | miniQ 原有覆盖 | 本次新增 | 未覆盖（理由） |
|---|---|---|---|---|
| 内容创作 | 50 | creative-production、remotion、hyperframes、higgsfield、canva、adobe | `cn-writing`（7）、`visual-language`（5） | 小众 SaaS（LibTV、WorkRally）；依赖私有 API 的生图 |
| 开发工具 | 46 | 全部 Vercel/Expo/iOS/macOS/web-app/web-testing/security 等 | `dev-flow`（8） | 腾讯云 CloudBase/COS/CLS/CloudQ/MigraQ（下一批可做 MCP 桥接）；小程序框架 |
| 效率工具 | 32 | 浏览器 10 种自动化 → `chrome`、`browser_automation` 原生 | `cn-daily/apple-notes-reminders`、`habit-goal-tracker` | 金数据、微盛 SCRM（私有 API） |
| 知识与学习 | 28 | research、notion、knowledge-capture | `cn-daily/daily-briefing-cn` | 元宝搜索、腾讯新闻 API（私有）；人格蒸馏类 |
| 办公协同 | 25 | notion、linear、atlassian、messages、meeting | `tencent-office`（7）、`cn-collab`（7） | Google 全家桶、Trello、Things |
| 生活服务 | 22 | 无 | `cn-daily`（travel/train-flight/weather/price-compare） | 美团领券、滴滴、唯品会（私有 API） |
| 数据分析 | 17 | data-analysis（18） | `cn-finance`（earnings/macro） | 广告素材库 |
| 投资理财 | 5 | 无 | `cn-finance`（7） | 富途/国泰海通（需券商账户） |
| 商业运营 | 5 | 无 | `cn-collab/qcc-company`、`cn-finance/company-dd-cn` | 1688→Ozon、TikTok Shop |

## 4. Claude Code 热门技能 → miniQ 状态

| skills.sh 排名 | skill | 来源 | miniQ 状态 |
|---|---|---|---|
| 1 | find-skills | vercel-labs | 插件页承担 |
| 2/3/13 | grill-me / grill-with-docs / grilling | mattpocock | 新增 `dev-flow/grill-me` |
| 4 | improve-codebase-architecture | mattpocock | 新增 `dev-flow/architecture-review` |
| 5 | agent-browser | vercel-labs | 现有 `vercel-agent-browser`、`browser_automation` |
| 6 | tdd | mattpocock | 现有 `test-driven-development`、`sp-tdd-debug` |
| 8 | frontend-design | anthropics | 现有 `frontend-polish`、`frontend-app-builder` |
| 9 | handoff | mattpocock | 新增 `dev-flow/handoff` |
| 10 | triage | mattpocock | 新增 `dev-flow/issue-triage` |
| 11 | prototype | mattpocock | 新增 `dev-flow/prototype` |
| 12–20 | hyperframes-* | heygen | 现有 `hyperframes`（6） |
| 17 | vercel-react-best-practices | vercel | 现有 |
| 44 | diagnosing-bugs | mattpocock | 新增 `dev-flow/diagnosing-bugs` |
| 56 | code-review | mattpocock | 新增 `dev-flow/code-review-two-axis` |
| 65 | remotion-best-practices | remotion | 现有 |
| 171+ | obra/superpowers 全套 | obra | 现有 `superpowers`（17） |
| 175 | wait-what | mattpocock | 新增 `dev-flow/wait-what` |
| 226 | impeccable | pbakaus | 方法论吸收进 `visual-language-core`"禁用 AI 味" |
| 264/285 | pptx / pdf | anthropics | 现有 `presentation-workflow`、`pdf-workflow` |

## 5. 本次新增汇总

| 包 | 名称 | skill 数 | MCP 数 |
|---|---|---|---|
| `miniq.official.visual-language` | 视觉语言 | 5 | 0 |
| `miniq.official.dev-flow` | 开发协作流 | 8 | 0 |
| `miniq.official.tencent-office` | 腾讯办公套件 | 7 | 5 |
| `miniq.official.cn-collab` | 国内协作平台 | 7 | 3 |
| `miniq.official.cn-writing` | 中文内容创作 | 7 | 0 |
| `miniq.official.cn-daily` | 生活与资讯 | 7 | 0 |
| `miniq.official.cn-finance` | 投研与财经 | 7 | 0 |
| 合计 | | 48 | 8 |

## 6. 下一批建议

1. `miniq.official.tencent-cloud`：CloudBase、COS、CLS 三个 MCP（WorkBuddy 市场有 SKILL.md，端点待探测）。
2. `miniq.official.cn-mail`：`mcp-email` stdio 包，支持 Gmail/163/QQ IMAP；凭证走环境变量。
3. `baidu-netdisk`：SSE 端点需 token，待 miniQ MCP 支持 URL 内变量展开后再做。
4. 地图合规提醒并入 `travel-plan-cn`。
5. 插件页增加"按场景"分组（办公/创作/开发/生活/投研），对应本次 7 个包。
