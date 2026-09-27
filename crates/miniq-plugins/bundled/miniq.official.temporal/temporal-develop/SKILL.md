---
name: temporal-develop
description: 当用户要用 Temporal SDK 编写或修改 Workflow、Activity、Worker，并在本地开发服务器上运行和测试时使用
origin: installed
requires:
  bins:
    - temporal
---

## 适用场景

- 新建或改造 Temporal 应用：定义 Workflow / Activity、启动 Worker、配置重试与超时、加入 Signal / Query / Update。
- 为已上线的 Workflow 做安全改动（版本化），或为 Workflow 写单元/回放测试。
- 支持 Go、Java、TypeScript、Python、.NET、PHP、Ruby 等官方 SDK，以项目现有语言为准。

## 前置条件

1. 安装 CLI：macOS `brew install temporal`（安装前 `ask_user`）；其他平台从 https://temporal.download/cli/archive/latest 下载。用 `temporal --version` 确认。
2. 本地开发服务器：`temporal server start-dev`（gRPC `localhost:7233`，Web UI http://localhost:8233）。默认数据在进程退出后丢失，需要持久化时加 `--db-filename temporal.db`；额外命名空间用 `--namespace <ns>`；端口用 `--port` / `--ui-port`。
3. 连接 Temporal Cloud 时，凭据放在环境变量 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`TEMPORAL_API_KEY`（或 `temporal.toml` 配置文件 profile，经 `TEMPORAL_PROFILE` 选择）；miniQ 不索要、不回显密钥。

## 步骤

1. 了解项目（`file_glob` / `file_grep` / `file_read`）：识别 SDK 语言与版本（`go.mod`、`package.json` 中的 `@temporalio/*`、`pyproject.toml` 中的 `temporalio` 等），找到现有 Workflow、Activity、Worker 注册代码与 Task Queue 名。
2. 查阅文档（`web_fetch`）：以 https://docs.temporal.io/llms.txt 为索引，读取对应语言 SDK 的开发指南，确认 API 名称后再写代码，不凭记忆猜 API。
3. 设计与编写（`file_write` / `file_edit` / `apply_patch`）：
   - Workflow 只做编排，必须确定性：不直接读系统时间、随机数、环境变量，不做网络/文件 I/O，不用原生线程/协程休眠；改用 SDK 提供的 `workflow.now`、`sleep`/timer、side effect 等等价物。
   - 所有外部副作用放进 Activity；为 Activity 设置 `StartToClose` 或 `ScheduleToClose` 超时和 Retry Policy（初始间隔、退避系数、最大次数、不可重试错误类型），Activity 要尽量幂等。
   - 需要外部交互时加 Signal（异步写入）、Query（只读查询）、Update（带返回的同步写入）。
   - 长时间运行、历史很长的 Workflow 用 Continue-As-New 截断历史。
   - 修改已有执行在用的 Workflow 逻辑时，必须用 SDK 的版本化机制（patching / `GetVersion` 或 Worker Versioning），否则会引发非确定性错误。
4. 本地运行（`shell_run`）：
   - 后台启动开发服务器：`shell_run` 设 `runInBackground` 运行 `temporal server start-dev`。
   - 后台启动 Worker（按项目语言，例如 `go run ./worker`、`npm run worker`、`python worker.py`）。
   - 启动并等待结果：`temporal workflow execute --workflow-id demo-1 --type YourWorkflow --task-queue YourTaskQueue --input '{"key": "value"}'`；只启动不等待用 `temporal workflow start`（同参数）。
   - 交互验证：`temporal workflow signal --workflow-id demo-1 --name YourSignal --input '{...}'`、`temporal workflow query --workflow-id demo-1 --type YourQueryType`、`temporal workflow result --workflow-id demo-1`。
   - 查看事件历史：`temporal workflow show --workflow-id demo-1 --output json`；需要可视化时用 `browser_automation` 打开 http://localhost:8233。
5. 测试（`shell_run`）：使用 SDK 自带测试框架（时间跳跃测试环境、Activity mock）；对改动过的 Workflow 用 `temporal workflow show --workflow-id <id> --output json > history.json` 导出历史，再用 SDK 的 Replayer 回放，确认新代码对旧历史仍然确定。
6. 汇报：列出新增/修改的 Workflow、Activity、Task Queue、运行命令和测试结果。

## 注意事项 / 安全

- 本技能默认只针对本地开发服务器操作；对 Temporal Cloud 或共享环境启动、发信号、更新 Workflow 前必须先 `ask_user`。
- Workflow 输入、历史和结果可能含业务数据，引用时只摘必要字段；生产环境建议配合 Data Converter 加密负载。
- 不要为“修复”非确定性错误而直接删除版本化分支，除非确认旧执行已全部结束。
- 安装软件、修改 `temporal.toml` 或 CLI profile 前先 `ask_user`。

## 如何确认完成

Workflow 在本地开发服务器上能被 Worker 执行完成并返回预期结果；测试（含回放测试，如涉及改动）通过；用户知道如何启动 Worker 和触发 Workflow。
