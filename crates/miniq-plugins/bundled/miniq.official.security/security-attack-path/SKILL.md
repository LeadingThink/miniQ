---
name: security-attack-path
description: "为已验证或可信的安全候选构建攻击路径：确认入口可达性、攻击者前置条件、控制是否有效、最终影响，并按 impact × likelihood 矩阵统一定级。发现候选请用 security-finding-discovery，证明真伪请用 security-validation。"
version: 1
---

# 攻击路径与严重度校准（security-attack-path）

回答两个问题：**真实攻击者能不能从外部走到这个缺陷？走到之后最坏能造成什么？**然后用统一矩阵得出 severity 与 priority。对应 `security-scan` 的阶段 4，也可单独对一条或一批 finding 使用。

## 触发场景

- 扫描流程中，候选已经过 `security-validation`（状态为 validated 或 plausible），需要定级与排序。
- 用户问"这个漏洞到底有多严重""能不能从公网打到""这几个问题能不能串起来"。
- 对已有 findings.json 做严重度复核或统一口径（例如合并多个扫描的结果后）。

不适用（转交）：

- 还没有候选、需要找问题 → `security-finding-discovery`。
- 还不确定问题是否真实存在 → 先 `security-validation`。
- 外部报告的漏洞需要分诊 → `security-triage-finding`（它会调用本技能的脚本定级）。
- 需要写对外披露文档 → `security-writeup`。

## 前置条件

- 有 `candidates.json`/`findings.json`，或用户描述的单个问题（先按 `../security-scan/references/finding-schema.md` 整理字段）。
- 已阅读 `references/severity-policy.md`。
- 若在扫描目录中，`threat-model.md` 可用来确定信任边界与部署假设；没有时在报告中写明假设。

## 分步流程

1. **收集部署上下文**（file_read / file_grep）：路由注册、网关/反向代理配置、鉴权中间件、Dockerfile/Helm/Terraform、环境变量默认值。目标是确定每个入口是公网、登录后、内网还是本地。拿不到的信息列为假设。
2. **逆向追踪入口**：从 finding 的 `sink` 位置出发，用 `file_grep` 找调用方，逐层向上直到遇到入口（HTTP 路由、消息消费者、CLI 参数、文件导入、定时任务）。把完整链路写入 `locations`（role 依次为 entry/source/control/sink）。
3. **逐个检查控制**：链路上每个鉴权、授权、校验、转义、限流、沙箱点，判断它是"有效/可绕过/缺失/不在链路上"。只有读代码或运行确认过的"有效"才能用来降级；推测的缓解写入 `counterevidence`。
4. **写攻击路径**：`attack_path` 以攻击者视角编号，每步一句话，从"攻击者以 X 身份访问 Y"开始，到"获得/破坏 Z"结束。`preconditions` 列出所需身份、配置、用户交互、时序等。
5. **组合链路**：检查同一扫描中其他 finding 能否与本条串联（例如 SSRF + 云元数据、XSS + CSRF 令牌泄露、信息泄露 + IDOR）。能串联时在两条的 `attack_path` 中互相引用编号，并按串联后的结果评估 impact。
6. **评定两个维度**：按 `references/severity-policy.md` 写入 `impact` 与 `likelihood`，每个维度在 `reasoning` 或 `summary` 中给一句理由。
7. **计算定级**（shell_run）：

```bash
python3 <插件目录>/security-attack-path/scripts/severity_calc.py <扫描目录>/findings.json --apply --explain
```

   单条问题可用 `--impact <级别> --likelihood <级别> --explain`。确需偏离矩阵时写 `severity_override`（必须有理由）。
8. **复核与排序**：检查 critical/high 是否都有完整攻击路径和至少 medium 置信度；按 severity → confidence → 入口暴露度排序后，交回 `security-scan` 阶段 5 重新编号与出报告。更新 manifest `phases.attack_path` 为 `done`。

## 工具与参数要点

- `file_grep` 追踪调用方时，同时搜函数名、路由字符串、依赖注入的接口名；动态语言还要搜字符串形式的方法名（反射、`getattr`、事件名）。
- `severity_calc.py`：`--check` 只检查不写（不一致时退出码 1，适合复核）；`--apply` 写回；两者互斥。缺 impact/likelihood 的条目会被跳过并列出，应补齐后复跑。
- 大批量（>30 条）时，可用 `agent_run`（runInBackground）按 finding 编号分组并行追踪，每组 5–10 条，输出各自的 JSON 片段，最后由主线程合并写入；不要让多个子代理同时写 findings.json。

## 质量检查

- [ ] 每条 high 及以上都有从入口到影响的完整 `attack_path`，且 `locations` 至少包含 entry 与 sink。
- [ ] 用于降级的控制都已确认有效；未确认的只出现在 `counterevidence`。
- [ ] 每条都有 impact 与 likelihood；`unknown` 已在 `proof_gaps` 说明缺什么。
- [ ] `severity_calc.py findings.json --check` 退出码为 0。
- [ ] 所有 `severity_override` 都写了 reason。
- [ ] 置信度没有被混入严重度（例如"不确定所以定 low"是错误做法，应是 severity 按影响定、confidence 标 low）。

## 失败回退

- 找不到入口：可能是死代码或入口在未提供的仓库里。likelihood 标 `low` 或 `unknown`，在 `proof_gaps` 写"未找到调用方"，不要直接 rejected，除非确认代码不会被部署。
- 部署方式未知：按最常见部署假设评估（例如 Web 服务默认公网可达），在报告"假设"一节列出，并请用户确认。
- 脚本不可用：按 `references/severity-policy.md` 的矩阵手工查表，并在报告中注明"手工定级"。
- 与用户对严重度有分歧：记录双方理由，使用 `severity_override` 采纳用户决定，不静默修改 impact/likelihood 来凑结果。

## 交付格式

- 在扫描流程中：更新后的 `findings.json`（含 attack_path、preconditions、impact、likelihood、severity、priority），manifest 阶段状态更新，并在聊天中给出定级变化摘要（哪几条升级/降级及原因）。
- 单独使用时，在聊天中逐条输出：

```
F-003 ｜ 高危 P1 ｜ 置信度 中
入口：POST /api/import（登录用户）
路径：1. 攻击者上传含 ../ 的压缩包 → 2. extract_all 未校验成员路径 → 3. 覆盖 templates/ 下文件 → 4. 下次渲染执行任意模板代码
前置条件：普通账号；导入功能默认开启
关键控制：上传大小限制（有效，但不相关）；路径校验（缺失）
定级：影响 高 × 可能性 中 → 高危
仍缺证据：未确认生产环境模板目录是否只读
```
