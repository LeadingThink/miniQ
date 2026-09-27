# 验证记录模板（validation/<候选ID>/notes.md）

每个候选一份，写在扫描目录内。复制以下结构填写，未用到的小节写"无"，不要删除标题。

```markdown
# <候选ID>：<候选标题>

- 结论：validated | rejected | open
- 验证方式：poc | test | dynamic | static | none
- 置信度：high | medium | low
- 验证人：<主线程或子代理名称>
- 时间：<ISO 8601>
- 被测版本：<git SHA 或"工作区未提交改动">

## 评判标准（动手前写定）

1. …
2. …
3. …

（如有修改：保留原文，另起一行写"修改：… 理由：…"）

## 攻击者模型

- 身份：未登录 / 普通用户 / 租户管理员 / 本地用户 …
- 可控输入：<参数名、字段、文件格式、字节布局>
- 前提：<配置开关、版本、竞态窗口、用户交互>

## 路径

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| entry | src/…:行 | … |
| source | … | … |
| control | … | 有效 / 可绕过 / 缺失 |
| sink | … | … |

## 执行记录

- 环境：<临时副本路径、虚拟环境、启动命令，均绑定 127.0.0.1>
- 命令：`…`
- 输入文件：`validation/<候选ID>/input-…`
- 输出日志：`validation/<候选ID>/run.log`（敏感值已打码）

## 逐条判定

| 标准 | 结果 | 证据 |
| --- | --- | --- |
| 1 | 满足 / 不满足 / 无法判断 | run.log 第 N 行；测试 test_xxx；src/…:行 |

## 反证

- 已检查：… → 结论：…

## 证据缺口（proof_gaps）

- 缺什么：…
- 为什么缺：…
- 谁能补 / 如何补：…
- 补齐后预期如何判定：…

## 其他实例

- 同根因调用点：<文件:行列表，逐个注明是否已验证>
```

写完后把结论同步到 `candidates.json` 对应条目：`status`、`confidence`，以及

```json
"validation": {
  "method": "test",
  "evidence": "validation/C-004/notes.md；test_export_idor 断言通过",
  "proof_gaps": []
}
```
