---
name: security-deep-scan
description: "对关键仓库做多轮深度安全扫描：每轮换视角独立发现，聚合去重后统一验证与定级，直到新发现收敛。只审差异请用 security-diff-scan，一次性常规扫描请用 security-scan。"
version: 1
---

# 深度安全扫描（security-deep-scan）

单轮扫描容易被第一印象锚定，漏掉跨模块、需要换角度才能看到的问题。深度扫描把"发现"阶段重复多轮（pass），每轮换一种视角或切分方式，再用归并器（reducer）统一去重、验证、定级。流程与产物复用 `security-scan`，本技能只描述多轮部分的差异。

## 触发场景

- 用户明确要求"深度扫描""多轮""尽量找全""发版前全面审计"。
- 高价值目标：鉴权/支付/多租户服务、沙箱、解析器、对外暴露的 SDK。
- 上一次标准扫描覆盖率 `partial` 或用户怀疑有漏报。

不适用（转交）：

- PR、提交、分支差异 → `security-diff-scan`（深度扫描不以 diff 为范围）。
- 时间有限或只要大致结论 → `security-scan` 或 `security-review`。
- 单个已知问题的复核 → `security-validation` / `security-triage-finding`。

## 前置条件

- 满足 `security-scan` 的全部前置条件，并已读 `../security-scan/references/finding-schema.md`、`../security-scan/references/scan-artifacts.md`。
- 与用户确认预算：轮数上限（默认 3，最多 6）、是否允许并行子代理（默认允许 2–4 个）、是否允许动态验证。用 `ask_user` 一次问清，给出默认值。

## 分步流程

### 1. 建立扫描（shell_run）

- `scan_id` 使用 `YYYYMMDD-HHMMSS-deep`，manifest 的 `mode` 为 `deep`，额外记录 `passes_planned` 与 `passes`（每轮的视角、状态、候选数、新增数）。
- **并发保护**：开始前检查 `security-scans/*/scan-manifest.json` 中是否有同仓库 `running` 的扫描；如有，询问用户后再继续。同一深度扫描内，每轮只写自己的 `passes/pass-<n>/`，只有归并器写顶层 `candidates.json` / `findings.json`，避免并行写冲突。
- 执行 `security-scan` 的第 0–2 步（范围清单、威胁模型、攻击面清单），结果放顶层，供所有轮次共用。

### 2. 规划各轮视角

每轮必须与前几轮**有实质差异**，建议顺序（按仓库特点取舍）：

| 轮次 | 视角 | 切分方式 |
| --- | --- | --- |
| 1 | 攻击面优先：从每个外部入口顺着数据流向下追 | 按攻击面分组 |
| 2 | 汇点优先：从危险汇点（执行、SQL、文件、反序列化、出站请求、模板）反向追到入口 | 按汇点类型分组 |
| 3 | 不变量与业务逻辑：鉴权/租户隔离/状态机/金额/配额是否处处成立 | 按资产或业务流程分组 |
| 4 | 配置与供应链：CI 工作流、容器、IaC、依赖可达性、默认配置 | 按文件类型分组 |
| 5 | 反向复查：专门挑前几轮 `rejected` 的候选与 `partial` 文件，寻找被错排的问题 | 按候选 |
| 6 | 变体搜索：以已验证问题为种子，找同一模式在别处的变体 | 按根因 |

规划写入 manifest 的 `passes[]`。

### 3. 执行每一轮（agent_run 可并行）

- 每轮产出 `passes/pass-<n>/candidates.json` 与 `passes/pass-<n>/coverage.json`，遵循 `security-finding-discovery` 的门槛与格式，`found_by` 写 `pass-<n>/<分组>`。
- 同一轮内可用 `agent_run`（`runInBackground: true`）按分组并行；不同轮次之间**默认串行**，因为后一轮要读取前一轮的结果（第 5、6 轮尤其依赖）。第 1–4 轮彼此独立时，可在预算允许下并行启动，然后用 `process_output` 全部收齐。
- 给子代理的提示必须包含：本轮视角、分组文件、已知候选的简短列表（避免重复劳动，但要求"若发现已有候选的新证据也要报告"）、输出路径。
- 每轮结束立即校验：

```bash
python3 <插件目录>/security-scan/scripts/validate_findings.py passes/pass-<n>/candidates.json
```

### 4. 归并（reducer）

```bash
python3 <插件目录>/security-scan/scripts/dedupe_candidates.py passes/pass-*/candidates.json \
  --line-window 10 --renumber -o candidates.json
```

- 主代理复核被合并的条目：若两条只是位置相近但根因不同，手工拆开（把 `status` 改回 `open`，去掉 `merged_into`）。
- 合并各轮 coverage：同一文件取最强状态（reviewed > partial > skipped），攻击面结论取最新且有证据的一条，写顶层 `coverage.json`。
- 统计本轮**新增**候选数（归并后新出现的指纹），写入 manifest。

### 5. 收敛判断

满足任一条件即停止追加轮次：

- 连续一轮没有新增 medium 及以上候选；
- 达到轮数上限；
- 用户叫停。

未收敛就停止时，在 `limitations` 中写明"第 n 轮仍有新增，可能存在漏报"。

### 6. 统一验证、定级与报告

对归并后的 `open` 候选执行 `security-scan` 第 4–6 步（`security-validation` → `security-attack-path` → 生成 findings 与报告）。报告额外增加"各轮概况"表：轮次、视角、候选数、新增数、验证通过数。

## 工具与参数要点

- `agent_run` 每批 2–4 个；给出不重叠的分组、统一门槛与输出文件；等待用 `process_output`（`block: true`），失败只重试失败分组。
- 所有轮次共享同一份 `inventory.json` 和威胁模型；不要每轮重新生成导致范围漂移。
- `dedupe_candidates.py` 的 `--line-window` 默认 10；对超长函数可以调大，对密集的一行多问题代码用 0。
- 变体搜索轮以 `file_grep` 为主：把已验证问题的危险调用写成正则，在全仓搜索，再逐个判定。

## 质量检查

- [ ] 每轮视角确有差异，manifest 中记录了视角与统计。
- [ ] 顶层 `candidates.json`、`findings.json`、manifest 全部通过 `validate_findings.py --strict`。
- [ ] `check_coverage.py` 对顶层 coverage 通过；安全敏感文件至少被一轮 `reviewed`。
- [ ] 归并时没有把根因不同的问题错误合并；被合并项都能追溯到保留项。
- [ ] 报告写明收敛情况与剩余风险。

## 失败回退

- 某轮子代理全部失败：主代理用单线程完成该轮最高优先级分组，其他分组标记 `needs_follow_up`。
- 预算耗尽：停止新增轮次，直接对已归并候选做验证与报告，manifest 设 `partial`。
- 候选数量爆炸（>200）：先按严重度提示与置信度排序，只验证前 50 个与所有 high 以上，其余在报告附录列为"未验证候选"。
- 仓库太大一轮都跑不完：先按顶层目录拆成多个 `security-scan`，再在关键目录上做深度扫描。

## 交付格式

聊天摘要同 `security-scan`，额外包含：轮数与收敛情况、各轮新增数、深度扫描相对单轮额外找到的问题。完整产物在 `security-scans/<scan_id>/`（含 `passes/`）。
