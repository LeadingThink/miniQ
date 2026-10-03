# 常驻写作原则（受 ASD-STE100 启发）

状态：已合入 `crates/miniq-daemon/src/turn.rs` 的 `SYSTEM_PROMPT`。

## 目的

让 miniQ 的日常回答更短、更清楚、歧义更少。常驻提示词只保留适用于所有对话、且经过样本验证有效的原则。完整规则、Strict / Flavored 模式和自检清单放在按需加载的 `ste-writing` skill 中（`crates/miniq-skills/assets/ste-writing/SKILL.md`）。skill 的规则由我们自己改写，没有复制 ASD-STE100 原文或词典。

## 常驻文本

插在 `SYSTEM_PROMPT` 的 "Be concise and accurate." 之后：

```text
Write in a plain, controlled style. Put the answer or result first. Do not open with what you
did or with a phrase such as "here is a summary". Use short sentences with one idea each, also
inside list items and table cells. Write steps as numbered direct commands, one action per step.
Use one name for one concept and keep it. Remove filler: pleasantries, restated questions,
slogans and closing summaries that repeat the body. Apply these rules in every response
language. Do not apply them to creative or narrative writing, speeches, a style the user asks
for, or quoted text. For procedures, tool descriptions, prompts, or a request for Simplified
Technical English, read the ste-writing skill.
```

## 样本评估

样本：最近 7 天内 10 个不同会话里的 assistant 长回答，每段 800–6000 字符，随机抽取，并排除了讨论 STE 本身的会话。方法：对每段样本逐条套用草案规则，并手动改写。如果改写后的版本更清楚，且没有丢失信息，这条规则就算“有效”。

| 样本 | 类型 | 发现的问题 | 起作用的规则 |
|---|---|---|---|
| s1 | 代码排查结论 | 开头先说“我先看了……”，结论排在后面 | 先给结论 |
| s2 | 技术选型对比 | 表格单元格里有多个分句 | 一句一个意思（含表格） |
| s3 | 演讲稿交付 | 演讲稿正文不适合压缩 | 需要创作类豁免 |
| s4 | 反馈修复状态 | “技术方案”列里一格写了 3–4 件事 | 一句一个意思（含表格） |
| s5 | 价格信息 | 装饰性分隔线和口语化的铺垫 | 去掉废话 |
| s6 | 文档修订汇报 | 首段的长句串了 3 个结论 | 一句一个意思 |
| s7 | 代码结构梳理 | 开头是“已经看完了，总结如下”；“工坊 / Studio / 链路 A”指的是同一个东西 | 先给结论、一个概念一个名字 |
| s8 | 方案交付 | 基本合格 | — |
| s9 | 产品定位文案 | 重复的口号和“更适合的表达是”之类的复述 | 去掉废话 |
| s10 | 故事与歌曲创作 | 叙事和情感内容，压缩后效果变差 | 需要创作类豁免 |

结论：

- **保留**：先给结论、一句一个意思（扩展到列表项和表格单元格）、步骤用编号命令、一个概念一个名字、去掉废话、适用于所有语言。
- **新增**：创作、叙事、演讲、用户指定的风格和引用原文不受这些规则约束。
- **移出常驻文本，只留在 skill 里**：主动语态、条件放在动作前、用常见词。10 段样本里都没有发现违反这几条的情况，放在常驻文本里只会增加 token。
- **不写字数上限和词表**：中英文的长度没法统一换算，原版词典也有版权限制。硬性上限放在 skill 的 Strict 模式里。

## 后续验证

上线后，抽查一周内的长回答，重点看两件事：

1. 回答是否因此丢失了必要的细节。
2. 创作类回答是否被误压缩。

如果出现问题，先调整豁免句，再考虑删除其他规则。
