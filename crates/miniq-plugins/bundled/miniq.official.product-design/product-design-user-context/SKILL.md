---
name: product-design-user-context
displayName: 产品上下文
description: 保存与读取产品设计上下文 user-context.md（产品定位、用户、平台、地址、代码库与设计系统、品牌、分享偏好），并提供预检脚本。每个设计任务开始时运行预检；首次使用、要求记住产品信息或更新偏好时做引导
version: 1
---

# 产品上下文

把设计师反复需要的产品与设计信息存成一份 `user-context.md`，让构思、原型、还原、审计都默认贴合真实产品。同时提供预检脚本，一次性检查上下文、本地原型、运行环境与空闲端口。

## 触发场景

- 任一产品设计技能开始时（运行预检，读取上下文）
- “初始化产品设计插件”“记住我们的产品信息”“你记得我们的品牌色吗”
- 用户给出应长期保存的信息：产品地址、代码库路径、token 文件、品牌资产、分享目标
- “更新/删除某项设置”

## 前置条件

- `shell_run` 可调用 `python3`（仅标准库）。
- 上下文文件位置（脚本自动定位）：
  1. 项目级 `<工作区>/design/user-context.md`（存在时优先）
  2. 全局 `$MINIQ_DATA_DIR/product-design/user-context.md`，未设置时为 `~/.local/share/miniq/product-design/user-context.md`
- 引导细则见 `references/onboarding.md`。

## 分步流程

### A. 预检（每个设计任务开始时）

1. `shell_run`：`python3 <本技能目录>/scripts/preflight.py check --workspace <工作区绝对路径>`
2. 读输出最后一行 JSON：
   - `context_exists=false`：继续当前任务；若判断为长期产品，按 B 提议一次引导（不阻塞）。
   - `missing_required` 非空：当前任务中这些信息以用户本轮描述为准；若简报关卡需要，再补问。
   - `filled`：作为默认上下文使用（品牌色、平台、视口、组件库等）。
   - `prototypes` / `qa_reports`：已有原型与 QA 报告，避免重复新建或覆盖。
   - `tools` / `free_port`：决定原型技术路线与预览端口。
3. **只读取当前任务需要的引用**：例如做还原时才去 `view_image` 参考截图，不要把所有保存的链接都打开一遍。

### B. 首次引导

1. 确认可写：`preflight.py init` 能成功创建文件即视为可持久化；失败则告诉用户“本次对话内可以用，但无法保存到以后”，不要声称已保存。
2. 按 `references/onboarding.md` 用 `ask_user` 一次问清（必填 2 题 + 选填若干）。
3. 用 `preflight.py set --field <字段> --value <值>` 或 `file_edit` 写入。
4. `preflight.py show` 回读确认。

### C. 更新与删除

1. `preflight.py show` 读出现值。
2. 修改：`set` 覆盖同名字段；未知字段会自动追加到“备注”之前。
3. 删除：`set --field <字段> --value ""`，恢复为“（待填写）”。

## 工具与参数要点

- `shell_run`：`preflight.py check|init|show|set|port`；`--workspace` 用绝对路径；`init --scope global` 写全局；`--force` 才会覆盖已有文件（覆盖前必须 `ask_user`）。
- `file_read` / `file_edit`：直接查看或精修 `user-context.md`。
- `view_image`：用户提供的参考截图在保存前先看一遍，确认是正确的界面。
- `memory_write`：仅在用户同意时保存跨项目的个人偏好摘要。

## 质量检查

- 回读确认写入值与用户原话一致，无错别字、无推测内容。
- 保存的参考图用 `view_image` 核验内容正确、非空白、非错误页。
- 文件中不含任何密钥、密码、令牌。

## 失败回退

- `python3` 不可用：用 `file_read` / `file_write` 直接按骨架格式（“- 字段: 值”）读写 `design/user-context.md`。
- 目录不可写：只在本轮使用信息，并明确告知未保存。
- 文件格式被手动改乱：保留原文件，另存 `user-context.md.bak` 前先 `ask_user`，再用 `init --force` 重建并迁移可识别字段。

## 交付格式

- 预检：不单独向用户汇报，结果直接用于后续技能（除非发现阻塞问题）。
- 引导/更新：2–3 行，说明记住了什么、还缺什么必填，结尾一个下一步建议。
