---
name: ste-writing
description: 用简化技术英语（受 ASD-STE100 启发）的原则写作或改写技术文本，适用于操作步骤、工具描述、错误信息、Agent 间指令、系统提示词、README 和长技术解释
version: 1
origin: bundled
allowed_tools: [file_read, file_write, doc_read]
---

## 来源与边界

本技能借鉴 ASD-STE100《Simplified Technical English》（Issue 9，2025-01）的写作原则，所有表述均为 miniQ 自行总结，不包含原文或其词典。需要原版规范时，引导用户从 https://www.asd-ste100.org/ 官方免费申请。规则编号（如 §5.1）仅用于对照原版。

原版的批准词典只针对英文。写中文时只套用句子、结构和术语一致性原则，不套用词表。

## 何时使用

- 用户要求“用 STE 写”“写得更清楚、无歧义”“去掉废话”，或要求改写、审查一段文本。
- 编写会被模型或人逐字执行的文本：工具描述、错误信息、系统提示词、Agent 间任务说明、安装和操作步骤。
- 长技术解释、多步骤教程、README。

不要用于：闲聊、文案、文学创作、头脑风暴，或用户明确要求保留原有风格的文本。

## 选择模式

| 模式 | 用于 | 力度 |
|---|---|---|
| Strict | 操作步骤、工具描述、错误信息、Agent 间指令、安全警告、系统提示词 | 全部执行下面的 A–E 节 |
| Flavored（默认，约“80% STE”） | README、解释性文本、报告、普通技术回答 | 执行 A、B、D 节；C 节只作建议；E 节词汇替换不强制 |

用户未指定时：文本会被执行或误读代价高，用 Strict；否则用 Flavored。

## A. 句子

1. 指令句不超过 20 个英文词（§5.1）；描述句不超过 25 个词（§6.3）。中文参考：指令句约 30 字以内，描述句约 40 字以内。
2. 一句只写一个动作（§5.2）。只有多个动作必须同时发生时才合并。
3. 指令用祈使句，动词开头（§5.3）：“Run the tests.”，不写 “You should run the tests.”。
4. 读者需要先知道条件时，条件放在句首，用逗号与命令隔开（§5.4）：“If the build fails, read the log.”
5. 用主动语态，写清谁做什么（§3.6）。只有不知道动作执行者时，描述句才用被动。
6. 用动词表达动作，不用名词化表达（§3.7）：写 “Check the file”，不写 “Perform a check of the file”。
7. 不为缩短句子而省略冠词、连词或使用缩写形式（§4.2、§4.5）：写 “Do not”，不写 “Don't”；写 “Open the file”，不写 “Open file”。
8. 英文不用分号（§8.1）。把句子拆开。
9. 时态尽量简单：祈使、一般现在、一般过去、一般将来（§3.2）。避免 “will have been” 一类复合结构（§3.4）。

## B. 术语一致

1. 一个概念从头到尾只用一个名字（§1.11、§9.4）。不要为了文字变化轮换同义词，例如 file / document / artifact 混用。
2. 选短而常见的术语（§1.9）。不用俚语、地域说法、圈内黑话（§1.10）。项目或领域已有的正式术语优先（§1.8）。
3. 名词不当动词用，动词不当名词用（§1.7、§1.13）。
4. 名词串不超过 3 个词（§2.1）。更长时用介词拆开：“the timeout of the retry policy for uploads”。
5. 首次出现的缩写给出全称。

## C. 结构

1. 信息逐步给出：先结论或目的，再细节（§6.1）。
2. 一段只讲一个主题，最多 6 句（§6.5、§6.6）。
3. 复杂内容用竖排列表或编号步骤（§4.3）。每个步骤一个动作。
4. 用连接词显示句间关系，例如 “Then”、“Thus”、“If”、“Because”（§4.4、§6.2）。
5. 注释（Note）只给信息，不放指令（§5.5）。指令写进步骤。
6. 警告：先写风险等级（WARNING / CAUTION 或“警告/注意”），再写明确的命令或条件，最后写后果（§7.1–§7.3）。

## D. 去掉废话

1. 删除开场白、客套话、重复用户问题的句子和空洞总结。
2. 删除不改变含义的修饰词：very、really、simply、just、basically、“非常”“其实”“基本上”。
3. 一个事实只说一次。
4. 不确定时直接说明不确定的点，不要用层层限定语表达。

## E. 英文用词偏好（Strict 模式）

优先用常见、单义的词。下面是 miniQ 的常用替换建议，不是原版词典：

| 避免 | 改用 |
|---|---|
| utilize, leverage | use |
| perform / conduct a check | check |
| ensure | make sure |
| prior to | before |
| subsequent to | after |
| in order to | to |
| commence, initiate | start |
| terminate | stop |
| facilitate | help, let |
| a number of | some, 3（写具体数字） |
| should（表示命令时） | 直接用祈使句 |
| may（表示许可或可能，有歧义） | can（能）/ possibly（可能） |
| check out, set up, go over 等短语动词（§9.3） | examine, configure, review |

一个词只用一个意思（§1.3）。例如 “run” 只表示执行程序，不同时表示“运转”和“管理”。

## 工作步骤

1. 确定模式（见“选择模式”），并确定读者：人、模型，还是两者。
2. 改写已有文本时，用 `file_read` 或 `doc_read` 读取原文。列出原文中的核心术语，为每个概念定一个名字。
3. 按 A → B → C → D（Strict 加 E）逐节改写。不要改变技术事实、数值、命令、路径、代码和标识符。
4. 用下面的自检清单检查。
5. 交付改写结果。用户要求时，附上主要改动说明，按规则分类，最多 5 条。需要写文件时用 `file_write`，不覆盖原文件，除非用户要求。

## 自检清单

- [ ] 每个指令句只有一个动作，并以动词开头。
- [ ] 没有超过长度上限的句子（数字、代码、路径、专有名词各算 1 个词）。
- [ ] 同一概念只用一个名字。
- [ ] 没有被动语态，除非执行者确实未知。
- [ ] 条件写在命令之前。
- [ ] Note 里没有指令；警告写明了风险和后果。
- [ ] 删掉了客套话、重复内容和空洞修饰。
- [ ] 技术事实、数值、命令和代码与原文完全一致。

## 示例

原文：
> In order to ensure that the configuration is properly applied, it is recommended that the service be restarted by the user, and the logs should also be checked for any errors that may have occurred.

Strict 改写：
> 1. Restart the service.
> 2. Examine the service log for errors.

中文原文：
> 为了确保配置能够被正确地应用，建议您最好重启一下服务，同时也可以去看看日志里有没有出现什么错误。

Flavored 改写：
> 重启服务，然后检查日志中有没有错误。
