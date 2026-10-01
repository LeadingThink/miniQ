---
name: security-validation
displayName: 安全验证（扫描阶段 3）
description: "安全扫描阶段 3：对 candidates.json 中每个候选建立评判标准，在本地一次性环境用 PoC、单元测试、动态运行或静态追踪验证真伪，产出 validation/<候选ID>/ 证据与结论。在发现阶段之后或用户要求验证某个疑似漏洞时使用；不用于定级或修复。"
version: 1
---

# 安全验证（扫描阶段 3）

目标：对每个候选给出"成立 / 不成立 / 证据不足"的结论，并留下可复核的证据。验证回答的是"攻击者输入能否真的到达汇点并产生声称的效果"，不回答"有多严重"（那是 `security-attack-path` 的工作），也不修代码（那是 `security-fix-finding` 的工作）。

## 触发场景

- `security-scan` / `security-deep-scan` / `security-diff-scan` 编排到阶段 3 时调用。
- 用户指着一条候选或一个疑似漏洞说"帮我确认这是不是真的""写个 PoC 证明一下"。
- 发现阶段产出 `confidence: low` 的候选，需要补证据。

不适用 / 应转交：

- 还没有候选 → `security-finding-discovery`。
- 外部提交的报告/告警、需要判断重复与优先级 → `security-triage-finding`。
- 已验证、需要可达性与严重度 → `security-attack-path`。
- 需要修复或验证修复是否有效 → `security-fix-finding`。
- 目标是生产系统、第三方服务或任何未授权环境 → 拒绝动态验证，只能做静态追踪，必要时 `ask_user` 确认授权范围。

## 前置条件

1. 扫描目录中存在 `candidates.json`（格式见 `../security-scan/references/scan-artifacts.md`），或用户给出单个候选的明确描述（此时先按同一字段整理成一条候选）。
2. 拥有目标仓库的只读访问；动态验证需要本地可构建/可运行，且只在本机或一次性容器中执行。
3. 已了解 finding 的置信度与状态定义：`../security-scan/references/finding-schema.md`。
4. manifest 的 `phases.validation` 为 `pending`/`running`。

## 分步流程

### 第 1 步：装载候选并排序

- 用 `file_read` 读 `candidates.json`、`threat-model.md`、manifest。只处理 `status: open` 的候选；`merged` 的跟随其保留项。
- 按 `severity_hint` 从高到低、`confidence` 从低到高排序（高严重但证据弱的最需要验证）。
- 用 `file_edit` 把 `phases.validation` 设为 `running`。

### 第 2 步：为每个候选建立评判标准（≤5 条）

在动手前写下"怎样算成立"。每条标准必须可观察、可判定，例如：

1. 未登录请求 `GET /api/export?id=2` 返回 200；
2. 响应体包含 `owner_id != 当前用户` 的记录；
3. 路由链上不存在其他拦截（中间件列表已核对）。

标准写入 `validation/<候选ID>/notes.md` 开头。标准不得超过 5 条，也不得事后修改以迁就结果；如确需修改，保留原标准并注明修改理由。编写方法见 `references/validation-guide.md`。

### 第 3 步：识别攻击者输入、汇点、前提

- 用 `file_read` / `file_grep` 确认：攻击者是谁、能控制的具体输入（参数名、字节布局、文件字段）、汇点（文件:行）、到达汇点所需的前提（登录、角色、配置开关、特定版本、竞态窗口）。
- 前提若需要攻击者已拥有同等或更高权限，记录下来——它会影响后续判定。

### 第 4 步：按强弱选择验证路径

从强到弱依次尝试，选能做到的最强一档：

| 档位 | 方法 | `validation.method` |
| --- | --- | --- |
| 1 | 可运行 PoC：以攻击者身份对本地实例发起请求/输入，观察到声称的效果 | `poc` |
| 2 | 单元/集成测试：调用真实代码路径，用断言证明控制失效或汇点接收到载荷 | `test` |
| 3 | 本地动态：在调试器、日志插桩、REPL 中运行真实函数观察行为 | `dynamic` |
| 4 | 调试/消毒构建（编译栈）：ASan/UBSan、调试断言下触发崩溃或越界 | `dynamic` |
| 5 | 静态追踪：逐跳引用源码闭合 source→control→sink→impact | `static` |

非编译栈（Python/JS/Ruby/PHP 等）优先写最小脚本直接导入目标模块或启动本地开发服务器；编译栈（C/C++/Rust/Go/Java）优先写测试用例或最小 harness，用调试或消毒构建观察。具体做法见 `references/validation-guide.md`。

### 第 5 步：在隔离环境中执行

- 所有 PoC、输入、脚本、日志只写到 `<扫描目录>/validation/<候选ID>/`（用 `file_write`），不写进仓库源码目录；需要临时构建时复制到临时目录进行。
- 用 `shell_run` 执行，设置超时；依赖安装仅限本地虚拟环境/容器，且先 `ask_user` 获得同意。
- 服务只绑定 `127.0.0.1`；不访问外部网络目标、生产地址、真实用户数据；不使用真实凭据，需要账号时创建测试账号。
- 对破坏性载荷（删除、覆盖、fork 炸弹）改用无害的等价证明（写入标记文件、`id` 命令、读取无害文件）。
- 运行输出用 `shell_run` 重定向到 `validation/<候选ID>/run.log`，敏感值打码。

### 第 6 步：逐条判定并保留实例

- 对照第 2 步的每条标准写"满足 / 不满足 / 无法判断"与证据指针（日志行、测试名、源码行）。
- 同一类漏洞的多个实例**逐个验证**、逐个下结论，不因"同类已验证"就推断其他实例成立或不成立；只有共享同一根因代码的调用点可以一起验证，但仍列出每个调用点。
- 结论规则：全部关键标准满足 → `validated`；找到决定性反证 → `rejected`（反证写入 `counterevidence`）；既无复现也无决定性反证 → 保持 `open` 并标记证据缺口（最终以 `plausible` 进入 findings）。

### 第 7 步：记录结论与证据缺口

- 用 `file_write` 写 `validation/<候选ID>/notes.md`，格式见 `references/validation-report-template.md`。
- 无法验证时必须写 `proof_gaps`：缺什么（运行环境、配置、账号、依赖）、为什么缺、谁能补、补了之后预计如何判定。
- 用 `file_edit` 更新 `candidates.json` 对应条目的 `status`、`confidence`，并追加 `validation` 对象（`method`、`evidence`、`proof_gaps`）。
- 全部处理完后用 `shell_run` 执行 `python3 <插件目录>/security-scan/scripts/validate_findings.py <扫描目录>/candidates.json --kind candidates`，并把 manifest `phases.validation` 设为 `done`。

## 工具与参数要点

- `shell_run`：运行 PoC/测试，务必加超时（如 `timeout 60`）；工作目录用临时副本或 `validation/<候选ID>/`。
- `file_write`：只写扫描目录内；不改被测源码。确需插桩时在临时副本里改。
- `agent_run`：候选很多且彼此独立时，可按候选分组 `runInBackground=true` 并行验证，每个子代理只负责自己的候选 ID 与自己的 `validation/<候选ID>/` 目录；共享的本地服务端口、数据库需错开或串行。用 `process_output` 收集。
- `browser_automation`：仅用于本地实例上的前端类问题（XSS、CSRF、点击劫持），不打开外部站点。
- `http_request`：仅限 `127.0.0.1`/`localhost` 本地实例。
- `ask_user`：安装依赖、启动容器、需要测试账号、授权范围不清时询问。

## 质量检查

- [ ] 每个候选都有 ≤5 条事先写下的评判标准。
- [ ] 每个结论都能指向具体证据（日志行、测试名、源码行），不是"看起来成立"。
- [ ] `validated` 且 `method` 为 `static` 的，四元组每一跳都有源码引用；否则置信度不高于 `medium`。
- [ ] 同类实例没有被合并判定。
- [ ] 所有产物都在 `validation/<候选ID>/`，仓库工作区无残留（用 `git_status` 核对）。
- [ ] 没有访问外部目标，没有使用真实凭据，日志中无明文密钥。

## 失败回退

- 无法构建/运行：退到档位 3–5；在 `proof_gaps` 写明构建失败原因与报错摘要。
- 依赖需要联网而用户未授权：不安装，改静态追踪。
- PoC 不成功：先检查 PoC 本身（端点、编码、认证头）再下结论；排除 PoC 错误后仍不成功，记录为"未复现"，只有找到阻断性代码才判 `rejected`。
- 结果不稳定（竞态、时序）：重复多次记录成功率；不稳定不等于不成立。
- 时间不足：优先完成高初判候选，其余保持 `open` 并在 manifest `limitations` 列出。

## 交付格式

向调用方返回：

```
阶段 3 验证完成（或：部分完成）
- 已处理 N 条：validated a / rejected b / 仍 open c
- 验证方式分布：poc x / test y / dynamic z / static w
- 证据目录：<扫描目录>/validation/
- 证据缺口：C-00k —— 缺少 …（建议 …）
下一步：security-attack-path（对 validated 与仍 open 的候选）
```
