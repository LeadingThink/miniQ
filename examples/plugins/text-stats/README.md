# Text Stats plugin

This example exports one miniQ tool, `dev.miniq.text-stats.count`, as a WebAssembly Component.

## Build

Install the Rust target once, then build from this directory:

```powershell
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
```

Copy `manifest.toml` and the built component to miniQ's data directory:

```text
<data_dir>/plugins/dev.miniq.text-stats/manifest.toml
<data_dir>/plugins/dev.miniq.text-stats/plugin.wasm
```

The component is produced at `target/wasm32-wasip2/release/miniq_example_text_stats.wasm`; rename it to `plugin.wasm` when installing. Open Settings to enable, reload, or inspect failures. Daemon logs include host-approved plugin log messages only.

The copied WIT file is the v1 ABI contract. Keep it byte-for-byte aligned with `crates/miniq-plugins/wit/v1/plugin.wit` when developing against a newer host.