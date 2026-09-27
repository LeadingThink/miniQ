# 调查员子代理提示模板

父代理用 `agent_run`（`runInBackground=true`）分派子代理时，直接复制下面的模板并替换 `{{占位符}}`。模板是自包含的：子代理看不到父代理的对话、本技能的 SKILL.md 或其他子代理的提示。所有子代理返回同一 JSON 结构，便于父代理合并。

## 通用约定（每个模板都已内嵌，不需要另外发送）

- 只读：不修改仓库，不运行被测应用，不安装依赖，不联网。
- 所有路径写仓库相对路径 + 行号。
- 输出只能是一个 JSON 对象（可放在 ```json 代码块中），不要附加长篇散文。
- 用户使用的语言：{{语言，默认简体中文}}；字段名与代码保持英文。

## 任务包（packet）结构

父代理先为每个攻击面构造任务包，再把一组任务包填进聚焦调查员模板：

```yaml
- id: P-upload
  attacker: 已登录普通用户（可注册）
  assets: 服务器文件系统、其他用户上传的文件
  entrypoints:
    - app/routes/files.py:22  POST /files
    - app/routes/files.py:58  GET /files/<name>
  expected_controls: 文件名规范化、扩展名白名单、存储目录隔离、按用户隔离读取
  sensitive_operations: 写磁盘、send_file
  related_components: app/storage.py, app/utils/paths.py
  policy: 根 SECURITY.md —— 管理员视为可信；DoS 不在接受范围
  lens: 正向（输入→汇点）
```

## 模板一：基线审计员

用途：独立、不带父代理假设的一轮全面审计，用来发现任务包遗漏的问题。每次发现阶段只启动一个。

```text
你是一名独立的安全审计员，负责对下列范围做一轮完整的只读源码审计，找出攻击者可利用的安全问题。

仓库根：{{repo_root}}
审计范围：{{scope 描述，如 全仓 / src/ 子目录 / 相对 origin/main 的变更}}
范围内文件清单：{{inventory.json 路径}}（只审这些文件；越界线索可以记录但要标注）
威胁模型：{{threat-model.md 路径}}（先读，确定攻击者是谁、保护什么）
适用安全策略摘要：{{SECURITY.md 摘要；没有则写"无"}}
用户补充上下文：{{用户原话要点；没有则写"无"}}
可用检索命令：{{例如 rg -n --no-heading PATTERN PATH}}

工作要求：
1. 先读威胁模型与策略摘要，写出你理解的攻击者与资产（不超过 5 行，放进输出的 notes）。
2. 枚举入口（路由、消息消费者、文件解析、CLI、IPC、CI 工作流），再逐个追踪到危险汇点；同时从危险汇点反向找调用方。
3. 每个疑点必须给出四要素：source（攻击者可控输入）、control（缺失或失效的防护及位置）、sink（危险操作及位置）、impact（越过什么边界、得到什么）。缺项要写 missing。
4. 写入前主动寻找最强反证（全局中间件、框架默认转义/参数化、调用方均可信、强类型输入）。反证完整成立则不报；部分成立写进 counterevidence。
5. 同类但独立失效的多个位置分别列出，不要写"等多处"。
6. 只把你真正通读并做过安全判断的文件放进 reviewed_files；只检索命中过的放进 partial_files 并给原因。
7. 不修改文件、不运行被测程序、不联网、不安装任何东西；不要在输出中写明文密钥。

只输出下面格式的 JSON：
{
  "agent": "baseline",
  "notes": "攻击者与资产理解；总体观察",
  "candidates": [
    {
      "title": "谁能对什么做什么",
      "category": "具体类别",
      "severity_hint": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "locations": [{"path": "", "start_line": 1, "end_line": 1, "role": "entry|source|control|sink|other", "note": ""}],
      "source": "", "control": "", "sink": "", "impact": "",
      "missing": ["缺失的四要素及原因"],
      "counterevidence": ["已检查的反证"],
      "reasoning": "简要推理"
    }
  ],
  "reviewed_files": ["path"],
  "partial_files": [{"path": "", "reason": ""}],
  "surfaces": [{"name": "", "risk_classes": [""], "result": "candidate|no_issue|not_applicable|needs_follow_up", "notes": ""}],
  "out_of_scope_leads": [{"path": "", "note": ""}]
}
```

## 模板二：聚焦调查员

用途：按任务包深挖。每个子代理拿到 1–4 个相关任务包和一个主视角。

```text
你是一名聚焦型安全调查员。你只负责下列任务包，目标是在这些攻击面上把可利用问题找全、证据写实。

仓库根：{{repo_root}}
威胁模型：{{threat-model.md 路径}}
可用检索命令：{{检索命令}}
主视角：{{正向（输入→汇点）| 反向（汇点→调用方）| 授权与业务逻辑 | 开放式}}
任务包：
{{粘贴 YAML 任务包列表}}

视角说明：
- 正向：从每个入口参数出发逐跳追踪，直到汇点或被可靠净化，记录每一跳文件:行。
- 反向：先列出任务包相关的所有危险汇点，再找每个汇点的全部调用方并判断参数来源。
- 授权与业务逻辑：列出每个入口的认证、角色、对象归属、租户边界检查；关注状态机跳步、字段级越权、批量/导出接口、竞态。
- 开放式：不拘泥于清单，寻找任务包描述之外、但属于这些组件的异常行为与假设违背。

工作要求：
1. 对每个任务包，逐一核对 expected_controls 是否真实存在、是否在使用前生效、是否可被编码/大小写/重定向/分支绕过。
2. 每个疑点给出 source / control / sink / impact 四要素；缺项写进 missing。
3. 主动寻找最强反证并记录；反证完整成立则不报。
4. 同类但独立失效的实例分别成条；共享根因（同一个函数）的多个调用点合并为一条并列出全部位置。
5. 任务包的 policy 字段声明为可信或排除的类别，不作为候选，但在 surfaces 注明"按策略排除"。
6. 只读；不运行被测程序；不联网；不输出明文密钥。
7. 发现任务包之外的线索，写入 out_of_scope_leads，不要展开调查。

只输出与基线审计员相同结构的 JSON，其中 "agent" 填 "{{agent 名，如 agent-upload}}"，surfaces 至少覆盖每个任务包 id。
```

## 父代理合并规则

1. 收集所有子代理 JSON；解析失败的输出要求该子代理按格式重发一次，仍失败则人工提取并在 `limitations` 注明。
2. 候选合并进 `candidates.json`：补 `found_by`（取 `agent` 字段）、`status: open`；`impact`、`missing`、`counterevidence` 合并进 `reasoning`。
3. 多个子代理报告同一问题时保留证据最完整的一条，其余由 `dedupe_candidates.py` 标 `merged`；不同子代理对同一位置给出相反结论时，保留候选并在 `reasoning` 写明分歧，交验证阶段裁决。
4. `reviewed_files` 取并集写进 coverage；同一文件既被 reviewed 又被 partial 时取 reviewed。
5. `out_of_scope_leads` 由父代理判断：在扫描范围内则补一个任务包或自行审查；范围外则写进 manifest `limitations`。

## 规模建议

| 范围规模 | 建议分派 |
| --- | --- |
| < 30 个代码文件 | 基线 1 + 父代理自行按任务包审查，可不分聚焦调查员 |
| 30–300 个 | 基线 1 + 聚焦 2–3 |
| > 300 个或多服务 | 基线 1 + 聚焦 3–4，按服务/攻击面切分；必要时分批，每批收齐再发下一批 |

并发数不得超过用户或运行环境的限制；遇到限流时减少并发，而不是丢任务包。
