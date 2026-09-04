# Local WASM plugins

miniQ loads local tool plugins from its data directory. Each plugin occupies one directory whose name exactly matches its reverse-domain ID:

```text
<data_dir>/plugins/dev.example.my-plugin/manifest.toml
<data_dir>/plugins/dev.example.my-plugin/plugin.wasm
```

The entry must be a WebAssembly Component implementing `crates/miniq-plugins/wit/v1/plugin.wit`. API v1 supports tool exports and an optional host-controlled log import. It does not expose WASI, filesystem paths, environment variables, network sockets, processes, SQLite, model credentials, providers, memory stores, or AgentLoop replacement.

## Manifest

```toml
id = "dev.example.my-plugin"
name = "My Plugin"
version = "1.0.0"
api_version = "1.0.0"
runtime = "wasm"
entry = "plugin.wasm"
capabilities = ["tool"]
permissions = ["log"]
enabled = true
description = "Optional description"
author = "Optional author"
```

Unknown fields are rejected. Versions must be semantic versions, the API version must be exactly `1.0.0`, and the canonicalized entry must remain inside the plugin directory. API v1 rejects permissions other than `log`.

Guest tool names use lowercase ASCII letters, digits, `_`, or `-`. The host registers each tool as `<plugin-id>.<tool-name>` in the existing `ToolRouter`. Plugin tools therefore use the same risk evaluation, approval, audit, persistence, checkpoint, hook, and observer pipeline as built-in tools.

## Resource limits

The host accepts components up to 16 MiB and creates a fresh Store and Component instance for each call. Default limits are 32 MiB linear memory, 10 million fuel units, a 5 second wall-clock timeout, 1 MiB input, 4 MiB output, four concurrent calls per plugin, and 16 KiB per log message. Unload and disable cancel queued or running calls and drop every `RegistrationHandle`.

## Development

Use a Component-capable toolchain such as Rust's `wasm32-wasip2` target. The complete `examples/plugins/text-stats` project builds one pure-compute tool without host permissions. Copy its manifest and renamed `.wasm` output into the data directory layout above.

Open Settings to inspect discovered plugins, enable or disable them, and reload changed components. A failed plugin remains visible with a structured diagnostic and does not prevent other plugins or the daemon from loading.