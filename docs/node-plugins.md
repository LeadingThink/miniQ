# Trusted Node.js plugins

miniQ can run local Node.js or TypeScript-authored tool plugins in a dedicated child process. These plugins are trusted code, not a security sandbox: they execute as the current OS user after explicit confirmation in Settings. Use WASM plugins for untrusted or strongly isolated extensions.

Each plugin uses the existing plugin directory, manifest, `PluginManager`, `ToolRouter`, approval path, audit trail, and Settings UI:

```text
<data_dir>/plugins/dev.example.my-plugin/manifest.toml
<data_dir>/plugins/dev.example.my-plugin/dist/index.js
```

## Requirements

- Node.js 22 or newer.
- The manifest entry must be a relative `.js` or `.mjs` path contained by the plugin directory.
- The runtime loads JavaScript, so TypeScript must be compiled before installation.
- The default host protocol is JSON-RPC 2.0 over newline-delimited JSON. Plugin code should use `@miniq/plugin-sdk` and must not read or write the host's standard streams directly.

## Manifest

```toml
id = "dev.example.my-plugin"
name = "My Plugin"
version = "1.0.0"
api_version = "1.0.0"
runtime = "node"
entry = "dist/index.js"
capabilities = ["tool"]
permissions = []
enabled = false

[engine]
node = ">=22"
```

Unknown fields are rejected. IDs, versions, capabilities, entry containment, and Node engine constraints use the same authoritative manifest parser as WASM plugins. Node plugins default to disabled when `enabled` is omitted. Setting `enabled = true` in the file does not authorize execution.

Available permission declarations are `log`, `workspace_read`, `workspace_write`, `http_client`, `memory_read`, and `memory_write`. Declare only what the plugin needs. They are review inputs shown during trusted-code confirmation. They do not turn the Node Permission Model into a complete sandbox, grant host APIs by themselves, or protect against all native/runtime escape paths.

## SDK

```ts
import { definePlugin } from "@miniq/plugin-sdk";

export default definePlugin({
  id: "dev.example.my-plugin",
  version: "1.0.0",
  activate(context) {
    context.tools.register({
      name: "echo",
      description: "Return the supplied value",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: {} },
      },
      outputSchema: {},
      execute(input, signal) {
        signal.throwIfAborted();
        return input;
      },
    });
  },
});
```

Tool names use lowercase ASCII letters, digits, `_`, or `-`. The host publishes them as `<plugin-id>.<tool-name>`. Respect the provided `AbortSignal`; disable, unload, timeout, and session cancellation propagate through it. Logs must use `context.log` so stdout remains reserved for the protocol.

The complete `examples/node-plugins/text-utils` project demonstrates a TypeScript build with no requested permissions:

```powershell
cd examples/node-plugins/text-utils
npm install
npm run typecheck
npm run build
```

Copy the built directory, manifest, and required runtime dependencies into the plugin data directory. Open Settings, inspect the entry, engine, capabilities, and permissions, then explicitly confirm trusted-code execution when enabling it.

## Trust and lifecycle

miniQ stores trust separately from the manifest and binds confirmation to the plugin ID, version, entry path, entry file SHA-256, permissions, capabilities, and Node engine requirement. Changing any of these inputs invalidates trust and requires confirmation again. A plugin cannot self-authorize by editing its manifest.

The host clears inherited environment variables, applies Node's Permission Model launch flags, limits protocol frames and pending requests, and enforces startup, call, and shutdown timeouts. On Windows, the host process and its descendants are assigned to a Job Object and terminated when the plugin unloads. Unexpected exit, malformed output, or an oversized frame cancels active calls, unregisters tools, and reports a failed process state in plugin diagnostics.
