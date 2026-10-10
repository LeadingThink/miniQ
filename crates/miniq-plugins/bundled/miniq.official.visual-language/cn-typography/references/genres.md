# 五种文体的版式参数

本文件补充 `SKILL.md` 步骤 1–3。所有 CSS 都以 `../../visual-language-core/references/tokens.md` 的令牌为基础，仅覆盖文体差异。

## 通用打印基线

```css
@page { size: A4; margin: 25mm 20mm; }
.doc { max-width: var(--doc-width, 820px); margin: 0 auto; padding: 48px; }
@media print { .doc { max-width: none; padding: 0; } }
.doc h1, .doc h2, .doc h3 { break-after: avoid; }
.doc p, .doc li { orphans: 3; widows: 3; }
.doc table, .doc figure, .doc blockquote { break-inside: avoid; }
.doc .footer { margin-top: 48px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 12px; }
```

## 1. 公文（通知、函、请示、报告类公文）

依据 GB/T 9704 的通用习惯做"像公文"的网页/PDF 版，不承诺逐项合规。

| 项目 | 参数 |
|---|---|
| 主色 | 朱砂 `#C8323B`，仅用于发文机关标志（红头）与红色反线 |
| 页边距 | 上 37mm、下 35mm、左 28mm、右 26mm |
| 发文机关标志 | 居中，字号 36–42px，`font-weight: 600`，颜色 `--primary` |
| 红色反线 | `border-top: 2px solid var(--primary)`，置于发文字号下方 |
| 标题 | 居中，22–24px，600，可两行，回行时词意完整 |
| 主送机关 | 顶格，后跟全角冒号 |
| 正文 | 16px，行高 1.8，**首行缩进 2 字符**（`text-indent: 2em`），两端对齐 |
| 层级编号 | `一、` → `（一）` → `1.` → `（1）` |
| 附件说明 | 正文下空一行，"附件：" 顶格缩进 2 字符，多个附件编号 |
| 落款 | 发文机关署名右对齐，成文日期用阿拉伯数字 `2026 年 10 月 10 日`，右空 4 字符 |
| 页码 | 页脚居中，`— 1 —` 形式 |

```css
.gw { --doc-width: 760px; }
.gw .head { text-align: center; color: var(--primary); font-size: 40px; font-weight: 600; line-height: 1.3; margin-bottom: 16px; }
.gw .no { text-align: center; margin-bottom: 8px; }
.gw .rule { border-top: 2px solid var(--primary); margin: 0 0 32px; }
.gw h1 { text-align: center; font-size: 22px; margin: 0 0 24px; }
.gw p { text-indent: 2em; line-height: 1.8; text-align: justify; margin: 0 0 .6em; }
.gw .sign { text-align: right; margin-top: 40px; padding-right: 4em; }
```

## 2. 工作报告 / 调研报告

| 项目 | 参数 |
|---|---|
| 主色 | 黛蓝 `#2B4C7E`（默认）；用户品牌色优先 |
| 页宽 | 820px；打印 A4 |
| 封面 | 可选：报告名 36px、副标题 18px `--muted`、单位与日期置底 |
| 目录 | 章节超过 5 个时生成；用 `<nav class="toc">`，打印时显示页码需 JS，默认不加页码 |
| 章节编号 | `1` `1.1` `1.1.1`，最多三级 |
| 标题 | h1 32px，h2 22px 左侧 4px 主色竖线 `border-left: 4px solid var(--primary); padding-left: 12px` |
| 正文 | 16px，行高 1.75，段距 1em，不缩进 |
| 摘要 / 结论 | 放卡片 `.card`，背景 `--card`，标题"摘要"或"核心结论" |
| 表格 | 表头 `--muted` 13px；数字右对齐 `tabular-nums` |
| 图片 | `figure` + `figcaption`（13px `--muted`）；来源写在图注末尾 |
| 页眉页脚 | 页眉左报告名、右章节名（可省）；页脚页码居中 |

## 3. 合同 / 协议

| 项目 | 参数 |
|---|---|
| 主色 | 青灰 `#6C7A89`，仅用于标题与分隔线；正文纯黑 |
| 页宽 | 760px；打印 A4 |
| 标题 | 居中 24px 600；下方一行合同编号 13px `--muted` 右对齐 |
| 当事人 | 甲方 / 乙方信息用两列表格或定义列表，标签 `--muted` |
| 条款编号 | `第一条`、`第二条`……；条内 `1.` `2.`；再往下 `（1）` |
| 正文 | 15px，行高 1.8，两端对齐；条款标题加粗，不换色 |
| 金额 | 大小写并列："人民币壹拾贰万元整（¥120,000.00）" |
| 空白填写项 | 用下划线占位 `<span class="blank">　　　　</span>`，`border-bottom: 1px solid var(--fg)` |
| 签章区 | 两列，左甲方右乙方：盖章 / 授权代表 / 日期，各留 48px 空白；`break-inside: avoid` |
| 页码 | 页脚右侧 `第 1 页 / 共 N 页`（Chromium 无法直接得出总页数时写"第 N 页"或省略） |

```css
.ht { --doc-width: 760px; font-size: 15px; }
.ht p { text-align: justify; line-height: 1.8; }
.ht .clause { font-weight: 600; margin-top: 20px; }
.ht .blank { display: inline-block; min-width: 6em; border-bottom: 1px solid var(--fg); }
.ht .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; margin-top: 64px; break-inside: avoid; }
```

## 4. 学术 / 技术论文

| 项目 | 参数 |
|---|---|
| 主色 | 青灰或黛蓝，仅用于标题与链接 |
| 页宽 | 760px；打印 A4 |
| 题名 | 居中 26px 600；作者 15px；单位与邮箱 13px `--muted` |
| 摘要 / 关键词 | 缩进框 `.abstract`，14px，关键词用全角分号分隔 |
| 章节编号 | `1` `1.1` `1.1.1`；"引言""结论""参考文献"不编号或按期刊要求 |
| 正文 | 15px，行高 1.8，两端对齐 |
| 图表题注 | 图注在下、表注在上；`图 1`、`表 1` 与题注之间一个空格 |
| 公式 | 优先 MathML 或图片；不要引外链 MathJax（离线不可用）；需要时在交付说明 |
| 脚注 | 13px，页面底部 `<section class="footnotes">`，编号 `[1]` |
| 参考文献 | 13px，悬挂缩进 `padding-left: 2em; text-indent: -2em;`，GB/T 7714 格式 |

## 5. 营销文案 / 公众号推文

| 项目 | 参数 |
|---|---|
| 主色 | 用户品牌色；否则杏黄 `#E8A33D`（生活）或朱砂 `#C8323B`（促销） |
| 页宽 | 680px；移动端优先，先截 390 宽 |
| 标题 | 28px 600，可配一行 15px `--muted` 导语 |
| 小标题 | 18px 600，前置 8px 主色方块或序号 |
| 正文 | 17px，行高 1.8，段落短（≤ 4 行），段距 1.2em |
| 金句 | `blockquote`：左侧 3px 主色线，背景 `--card`，字号 18px |
| 行动号召 | 底部 `.btn-primary` 样式块；文字一句话 |
| 图片 | 宽 100%，圆角 12px；图下 13px 说明 |
| 禁止 | 每段开头 emoji、彩虹色、渐变文字、超过一个主色 |

## 检查清单（对所有文体）

- [ ] 中西文之间一个空格；全角标点；数字千分位 / 万亿；日期格式统一
- [ ] 标题层级 ≤ 3；编号风格统一
- [ ] 段落无单字孤行；标题不落页底
- [ ] 一个主色；对比度正文 ≥ 4.5:1
- [ ] 不引用外链字体/脚本，离线可开
- [ ] PDF 首页、跨页、末页已 `view_pdf` 核对
