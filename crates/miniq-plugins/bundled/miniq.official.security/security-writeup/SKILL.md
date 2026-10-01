---
name: security-writeup
displayName: 单漏洞详细报告
description: "为单个已确认或高度可疑的漏洞撰写披露/安全公告级详细报告：精确源码版本、引入提交与受影响发布、分层证据、PoC 与修复建议。多个漏洞时每个一份报告。找漏洞用 security-scan，判真伪用 security-triage-finding。"
version: 1
---

# 单漏洞详细报告

目标：交付一份让陌生读者（上游维护者、安全团队、CVE 编号机构、客户）能独立读懂、独立核对的漏洞报告。报告的价值来自**准确**，不来自说服力：每一句技术断言都能对应到源码、实际运行记录或明确标注的推断。源码与报告声明矛盾时，停止把它写成漏洞，改为说明矛盾。

## 触发场景

- 已有 finding（来自 `security-scan`、`security-validation`、`security-triage-finding` 的 `valid` 项或外部报告），需要对外披露、提交上游、申请 CVE、写客户公告或内部复盘。
- 需要确定“哪些发布版本受影响、从哪个版本开始、哪个版本修复”。
- 一次有多个漏洞要写：每个漏洞一份报告，按下文“多漏洞流程”并行起草。

不适用 / 应转交：

- 还不确定是不是漏洞 → 先 `security-triage-finding`（外部报告）或 `security-validation`（内部候选）。
- 严重度与攻击链尚未校准 → `security-attack-path`。
- 需要全仓汇总报告 / SARIF → `security-scan` 的 `findings_report.py`。
- 需要修复代码 → `security-fix-finding`；要把报告登记为 GitHub Security Advisory / Jira → `security-track-findings`（可直接复用本报告正文）。
- 编写 `SECURITY.md` 披露政策 → `security-policy`。

## 前置条件

1. **精确源码**：漏洞所在的仓库与版本可读。拿不到时先 `ask_user` 索要；只有用户明确接受“仅基于报告材料”时才继续，并把所有依赖源码的结论写成条件句。
2. **完整历史**：追溯引入版本需要 tag 与历史。浅克隆时在授权范围内 `git fetch --unshallow --tags`；做不到就在报告里写明限制。
3. **原始材料**：finding JSON（字段见 `../security-scan/references/finding-schema.md`）、分诊结论、报告人原文、PoC、日志、已有修复补丁。
4. **测试授权**：需要运行 PoC 时，确认用户授权的环境（本地容器、一次性测试实例）。未经针对具体目标的许可，不对公网、生产、第三方系统发送任何请求。
5. 先完整阅读 `references/report-format.md` 与 `references/evidence-rules.md`。

## 分步流程

1. **证据盘点**（`file_read`、`doc_read`、`file_glob`）。按 `references/evidence-rules.md` 的盘点表逐项登记：原始声明、源码版本、入口/控制/汇点位置、角色与权限、PoC 与日志、已有修复、测试授权。每项标出它属于哪一类证据（源码/实际运行/未执行 PoC/报告声明/推断/未知）。
2. **锁定版本**（`shell_run`）。`git rev-parse HEAD`、`git status --porcelain`、`git describe --tags --always`；工作区有改动就记录为“含未提交改动”。评估的版本不是当前检出时用 `git show <tag>:<path>` 读取，不要拿工作区代替。涉及第三方依赖时从锁文件确定实际版本。
3. **一句话攻击陈述**。在动笔前写下：Mallory 是谁、手里有什么合法凭证或输入、做了什么、本该由哪个控制拦下、最终到达哪个实际后果；并写出“不声称”的内容（例如“不需要窃取 Alice 的会话”）。后续所有分析不得悄悄换成更容易的路径或别的对象。
4. **按因果顺序核对源码**（`file_read`、`file_grep`）。入口 → 数据传递 → 应有的控制 → 失效点 → 汇点 → 后果。逐一挑战：所需配置是默认还是可选？攻击者是否已经拥有其声称要获得的权限？是否有错误处理、权限检查、生命周期管理会中断路径？任一环节被源码否定就停下汇报。
5. **追溯引入与受影响发布**（`shell_run`）。按 `references/evidence-rules.md` 的“版本追溯”：`git log -L`/`git log -S`/`git blame` 找引入提交，`git tag --contains` 得到候选发布，再对代表性的首个受影响版本、最后受影响版本、首个修复版本逐一 `git show <tag>:<path>` 确认，并检查维护分支上的回港。“含有引入提交”不等于“受影响”。
6. **PoC 处理**。已有 PoC 先阅读；在授权的一次性环境里运行（`shell_run`）并原样保存输出，同时做一个阴性对照（如 Alice 自己访问成功、补丁后 Mallory 失败）。不能运行就明确写“未执行”，只给出“预期输出（未观察）”。崩溃、破坏性、提权类 PoC 只在容器或临时目录里跑。
7. **起草**（`file_write`）。按 `references/report-format.md` 的章节写入 `reports/<slug>/<slug>.md`（或用户指定路径）；真实 PoC 文件放同级 `poc/`。slug 用小写英文连字符，如 `order-export-idor`。
8. **自查与验收**（`file_grep`、`shell_run`）。按下文“质量检查”逐条核对；用 `grep -nE '/Users/|/home/|/tmp/|[A-Za-z]:\\|file://' -r reports/<slug>` 找出作者机器的绝对路径并替换为仓库相对路径（目标系统上复现所必需的绝对路径除外）。对照源码复核每段引用代码与行号。

## 多漏洞流程

1. 主代理先盘点全部 finding，按根因 + 源码位置（而非标题）去重，完成第 2–3 步和版本追溯的公共部分（tag 列表、历史是否完整）。
2. 每个独立漏洞用 `agent_run`（`runInBackground: true`）派一个起草子代理，同时不超过 4 个。每个子代理只拿到该漏洞的材料：原始 finding、一句话攻击陈述、源码根目录与锁定版本、PoC、输出路径、两个 reference 文件的路径、测试授权边界。要求子代理先读完 reference 再动笔。
3. 用 `process_output`（`block: true`）收齐后，主代理**独立**对照源码与原始材料验收每份草稿。出现编造运行结果、夸大影响、猜测受影响版本、泄露本机路径、把未执行 PoC 写成已复现等问题即退回。
4. 实质性问题用新的子代理重写（附上具体退回理由），不要用润色掩盖证据缺口。子代理两次失败则在交付中列为阻塞项。
5. 验收通过后主代理只做小幅修订并生成索引 `reports/README.md`。

## 工具与参数要点

- `shell_run` + git：`git log --follow -p -- <path>` 跟踪重命名；`git log -L <起>,<止>:<path>` 看某段代码演变；`git log -S'<关键表达式>' --oneline`；`git tag --contains <sha> --sort=v:refname`；`git branch -r --contains <fix-sha>` 找回港分支。
- `file_read`：引用代码前必须重新读取目标版本，摘录保持最短且包含关键行。
- `web_fetch` / `web_search`：只用于查公开的发布说明、已有 CVE/GHSA，结果需要与源码互证；不得用来探测目标。
- `agent_run`：多漏洞时一漏洞一子代理；单漏洞由主代理直接写。
- CVSS：只有用户需要且每个指标都有依据时才给出向量；否则用插件的 severity（可调用 `python3 <插件目录>/security-attack-path/scripts/severity_calc.py`）。

## 质量检查

- 陌生读者能读懂：组件是什么、谁是 Alice/Bob/Mallory、安全边界在哪、为什么这是问题。
- 每段代码摘录与指定版本逐字一致，带仓库相对路径与函数名，并解释它证明了什么、没证明什么。
- 源码证据、实际运行观察、未执行 PoC、报告声明、推断、未知在文中可区分（按 `references/evidence-rules.md` 的标注法）。
- 受影响版本范围均来自实际检查过的 tag；未逐一检查的中间版本在文中点明。
- 影响、可靠性、部署普遍性不强于证据；“文档里有这个配置”不等于“很多人这样配置”。
- 没有编造的命令输出、截图、CVE 编号、CVSS 向量、修复版本号；预测输出标注“未观察”。
- 修复建议说清代码应改成什么行为，并建议回归测试；引用上游修复前已确认它确实阻止了报告中的攻击。
- 报告与 PoC 中没有作者机器的绝对路径、内部令牌、占位符（`TODO`、`<填写>`）。
- 提交哈希只在引入/修复提交本身有说明价值时出现，正文以发布版本号为主。

## 失败回退

- 源码或精确版本不可得：`ask_user`；用户接受则写“仅基于报告材料”版本，执行摘要顶部声明限制。
- 历史不完整或没有 tag：写“已确认受影响的最早检查版本”，明确“更早版本未知”。
- 源码否定了声明：停止撰写披露报告，改写简短的“复核结论”说明矛盾点，建议把 finding 状态改为 `rejected`。
- 无法在授权环境运行 PoC：保留静态论证，PoC 章节标注“未执行”，列出所需环境。
- 子代理卡住或产出不合格：给一次明确收尾指令，再用更窄的单漏洞任务重试一次，仍失败则报告阻塞。

## 交付格式

- 文件：`reports/<slug>/<slug>.md`，可选 `reports/<slug>/poc/`（仅真实产物，含 README 说明运行与清理方式）；多漏洞时加 `reports/README.md` 索引（slug、标题、严重度、受影响版本、状态）。
- 对话回复：每份报告的路径、一句话摘要、受影响版本结论及其确认程度、证据等级（静态/已复现）、仍未解决的未知项。
- 若需登记 GHSA/Jira，提示用 `security-track-findings`，并说明哪些章节包含可利用细节、不宜公开。
