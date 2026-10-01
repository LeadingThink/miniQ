# 严重度策略

本插件所有技能共用同一套定级规则：先分别评估**影响（impact）**与**可能性（likelihood）**，再查矩阵得到 severity，最后映射为 priority。置信度（confidence）描述证据强弱，**不参与**严重度计算，单独报告。

## 影响（impact）

按"攻击成功后最坏的现实后果"评估，以本系统的真实部署为准，而不是漏洞类别的理论上限。

| 等级 | 判定要点 | 典型例子 |
| --- | --- | --- |
| high | 跨越主要信任边界；任意代码执行；读写全部或大量他人数据；获取管理员/服务身份；可持久化；破坏关键资金或安全功能 | 未鉴权 RCE、多租户数据全量泄露、签名校验绕过 |
| medium | 影响限于单个用户、单个租户或部分数据；需要与其他缺陷组合才能造成 high 后果；可被快速恢复的可用性破坏 | 单对象 IDOR、存储型 XSS（有 CSP 但可绕过）、有限的 SSRF |
| low | 信息价值有限的泄露；只影响攻击者自己；纵深防御缺失但主控制有效 | 版本号泄露、自我 XSS、缺少安全响应头 |
| ignore | 在本系统的安全边界内不构成危害（例如"管理员能做管理员本来就能做的事"） | 本地 CLI 读取用户自己指定的文件 |
| unknown | 缺少判断所需的信息（部署方式、数据敏感度不明） | — |

## 可能性（likelihood）

按"现实攻击者成功利用的难度"评估。

| 等级 | 判定要点 |
| --- | --- |
| high | 未鉴权或任意注册用户即可触发；入口公开可达；利用稳定、无需特殊时机；已有公开利用手法 |
| medium | 需要普通登录用户、特定配置（但是常见配置）、用户交互（点击链接）、或一定的时序/信息收集 |
| low | 需要高权限账号、内网位置、罕见配置、竞态窗口极小、或依赖另一个未发现的缺陷 |
| ignore | 在实际部署中不可达（死代码、仅测试构建、被上游控制完全阻断且已确认） |
| unknown | 可达性无法确定 |

## 矩阵

| impact \ likelihood | high | medium | low |
| --- | --- | --- | --- |
| **high** | critical | high | medium |
| **medium** | high | medium | low |
| **low** | low | low | info |

- 任一维度为 `ignore` → `info`，通常不作为 finding 报告（或标 `rejected` 并写理由）。
- 任一维度为 `unknown` → 按 `medium` 计算，并在 `validation.proof_gaps` 写明缺什么信息；补齐后必须复算。

## priority 映射

critical → P0，high → P1，medium → P2，low → P3，info 不设 priority。

## 升降级因素（先调整 impact/likelihood，再查表）

不要直接改 severity。先把因素折算到两个维度上，保证可复算：

- **提升 likelihood**：入口在互联网上；存在自动化利用可能（可批量）；日志/监控不会发现。
- **降低 likelihood**：需要有效 CSRF 令牌以外的秘密；已有 WAF/网关规则**且已验证**确实拦截；功能默认关闭。
- **提升 impact**：可串联到其他 finding 形成更严重链路（在 `attack_path` 中写明链路并引用另一条编号）；涉及受监管数据（支付、医疗、个人身份信息）。
- **降低 impact**：沙箱/容器隔离**且已验证**；数据已加密且密钥不可同时获取；只读副本。

未验证的缓解措施只能写进 `counterevidence`，不能用于降级。

## 人工覆盖

组织政策或客户合同要求与矩阵不同的等级时，在 finding 上写 `severity_override`：

```json
"severity_override": {"severity": "high", "reason": "支付链路按内部规范一律不低于 high", "by": "安全负责人"}
```

同时把 `severity` 设为覆盖后的值。`severity_calc.py --apply` 会跳过这类条目，但会打印计算值以便对比。

## 计算脚本

```bash
# 单次
python3 <插件目录>/security-attack-path/scripts/severity_calc.py --impact high --likelihood medium --explain
# 批量检查（不一致时退出码 1）
python3 <插件目录>/security-attack-path/scripts/severity_calc.py findings.json --check
# 批量写回
python3 <插件目录>/security-attack-path/scripts/severity_calc.py findings.json --apply --explain
```

退出码：0 正常；1 存在非法取值、覆盖缺理由，或 `--check` 发现不一致；2 参数错误或文件无法读取。
