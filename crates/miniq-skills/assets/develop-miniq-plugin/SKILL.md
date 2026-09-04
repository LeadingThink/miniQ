---
name: develop-miniq-plugin
description: 为 miniQ 设计、编写、构建或排查 API v1 插件，包括 Rust WASM Component 与可信 Node.js/TypeScript 插件
origin: bundled
---

## 适用场景

用户要求创建、修改、迁移或调试 miniQ 插件，或询问插件 manifest、工具协议、WASM ABI、Node.js SDK、安装与验证方式。

## 开始前

1. 先读取当前仓库的 `AGENTS.md` 和目标目录附近的实现，不凭记忆猜协议。
2. 将以下文件视为 API v1 的权威来源：
   - `crates/miniq-plugins/src/manifest.rs`
   - `crates/miniq-plugins/wit/v1/plugin.wit`
   - `packages/node-plugin-host/src/index.ts`
   - `examples/plugins/text-stats/`
3. 复用现有 `PluginManager`、`manifest.toml`、权限、信任确认和 `ToolRouter`。不得建立第二套插件注册表、manifest、权限系统或插件管理 UI。
4. 先明确工具输入、输出、错误语义和所需权限，再选择运行时。不要先写框架代码。

## 选择运行时

- 默认选择 WASM：适合纯计算、文本转换、解析和不需要宿主资源的工具。它通过 Wasmtime 隔离，优先用于不可信代码。
- 选择 Node.js：仅当插件确实需要 JavaScript/TypeScript 或 npm 生态。Node 插件是可信本地代码，默认禁用，首次启用必须由用户确认信任。
- 不要为同一个功能同时保留 WASM 和 Node 两套实现，除非用户明确要求并说明用途。

## 通用 manifest

每个插件目录必须包含 `manifest.toml`。字段必须与 API v1 严格一致，未知字段会被拒绝。

```toml
id = "dev.example.my-plugin"
name = "My Plugin"
version = "1.0.0"
api_version = "1.0.0"
runtime = "wasm"
entry = "plugin.wasm"
capabilities = ["tool"]
permissions = []
enabled = true
description = "A concise description."
author = "Example"
```

约束：

- `id` 使用至少三段的小写反向域名标识；每段只使用小写字母、数字和中划线，且必须以小写字母开头。
- 插件目录名必须与 `id` 完全一致。
- `version` 与 `api_version` 必须是合法语义化版本；当前 `api_version` 只能是 `1.0.0`。
- `entry` 必须是插件目录内无 `..` 的相对路径。WASM 使用 `.wasm`，Node 使用 `.js` 或 `.mjs`。
- `capabilities` 当前必须恰好为 `["tool"]`。
- 权限枚举只有 `log`、`workspace_read`、`workspace_write`、`http_client`、`memory_read`、`memory_write`。只声明实际需要的权限。
- API v1 的 WASM 插件只支持无权限或 `log`；其他 WASM 权限会被拒绝。

宿主公开的工具名为 `<plugin-id>.<short-tool-name>`。插件内部只能注册短名，例如 `count`，不要注册 `dev.example.my-plugin.count`。

## 编写 WASM 插件

1. 从 `crates/miniq-plugins/wit/v1/plugin.wit` 复制 WIT，保持内容一致。
2. Rust crate 使用 `wit-bindgen` 生成 `tool-plugin` world 的绑定，并实现 guest 接口：
   - `identity()` 返回与 manifest 完全一致的 `id`、`version`、`api_version`。
   - `tools()` 返回短工具名、说明及输入输出 JSON Schema 字符串。
   - `execute()` 按短工具名分派，解析参数 JSON，并返回 JSON 字符串或明确错误。
3. 输入和输出 Schema 必须是对象，准确声明类型、`required` 和 `additionalProperties`。运行时解析逻辑必须与 Schema 一致。
4. 使用 `wasm32-wasip2` 构建：

```powershell
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
```

5. 将产物按 manifest 的 `entry` 名称放入插件目录。不要提交或安装普通宿主平台二进制代替 WASM Component。

## 编写 Node.js/TypeScript 插件

Node manifest 使用以下差异：

```toml
runtime = "node"
entry = "dist/index.js"
enabled = false

[engine]
node = ">=22"
```

入口模块必须 `export default` 一个插件对象：

```js
export default {
  id: "dev.example.my-plugin",
  version: "1.0.0",
  activate(context) {
    context.tools.register({
      name: "transform",
      description: "Transform text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute(input, signal) {
        if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
        return { text: input.text };
      },
    });
  },
};
```

约束：

- 模块的 `id`、`version` 必须与 manifest 完全一致。
- 工具短名匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，同一插件内不得重复。
- `activate(context)` 中注册工具；可选的 `deactivate()` 负责释放插件自身资源。
- 长任务必须监听 `AbortSignal`。不要吞掉取消或把取消报告为成功。
- stdout 专用于宿主 NDJSON 协议；日志使用 `context.log` 或 stderr，不能向 stdout 打印任意文本。
- Node 插件保持 `enabled = false`，让用户通过 miniQ 明确信任并启用，不得在 manifest 或代码中自行授权。
- TypeScript 必须先编译到 manifest 指向的 `.js`/`.mjs` 文件，不能把 `.ts` 作为入口。

## 安装与验证

1. 插件目录最终至少包含 `manifest.toml` 和构建后的入口文件，不要把源码目录误当成已构建插件。
2. 通过 miniQ 插件页面的“添加插件”安装，或放入 `<data-dir>/plugins/<plugin-id>/` 后重启/重扫。不要直接修改数据库来注册插件。
3. 检查插件状态为 `active`，工具列表包含 `<plugin-id>.<short-tool-name>`。
4. 分别测试有效输入、Schema 拒绝的输入、未知工具、执行错误和取消路径。
5. Node 插件还要测试禁用、首次可信确认、重载、进程退出后的失败状态和卸载；WASM 插件要测试无宿主权限时仍可执行。
6. 修改仓库代码后运行最小相关测试、格式检查和类型检查。若仓库使用 `uv`，Python 命令必须通过 `uv run`。

## 常见错误

- `InvalidManifest`：检查目录名、反向域名 ID、语义版本、API 版本、入口扩展名和未知字段。
- `unknown tool`：插件内部应使用短工具名，公开名才带插件 ID 前缀。
- Node 身份不匹配：默认导出的 `id` 或 `version` 与 manifest 不一致。
- Node 握手超时：检查入口是否存在、Node 是否满足 `engine.node`、stdout 是否被普通日志污染，并查看 daemon stderr。
- WASM 实例化失败：确认产物是匹配 `tool-plugin` world 的 WASI Preview 2 Component，且 WIT 与宿主 API v1 一致。

## 完成标准

- manifest 可被当前 `PluginManifest` 解析和验证。
- 构建产物存在于 manifest 指定位置。
- 插件可安装、启用、重载、禁用和卸载，不产生额外的伪插件记录。
- 每个工具通过统一 `ToolRouter` 注册，公开名称正确，输入输出符合 Schema。
- 相关测试、格式检查和类型检查通过，并向用户说明运行时选择、权限与可信代码影响。