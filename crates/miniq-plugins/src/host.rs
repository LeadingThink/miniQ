use std::sync::Arc;

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use miniq_tools::{Tool, ToolContext, ToolError};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{IoView, WasiCtx, WasiCtxBuilder, WasiView};

use crate::error::{PluginError, PluginFailureKind, PluginLimits};
use crate::manifest::{PluginManifest, PluginPermission};

const EPOCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

pub mod bindings {
    wasmtime::component::bindgen!({
        world: "tool-plugin",
        path: "wit/v1",
        async: true,
        trappable_imports: true,
    });
}

struct HostState {
    plugin_id: String,
    log_enabled: bool,
    max_log_bytes: usize,
    limits: StoreLimits,
    wasi: WasiCtx,
    table: ResourceTable,
}

impl IoView for HostState {
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

impl WasiView for HostState {
    fn ctx(&mut self) -> &mut WasiCtx {
        &mut self.wasi
    }
}

impl bindings::miniq::plugin::host::Host for HostState {
    async fn log(
        &mut self,
        level: bindings::miniq::plugin::host::LogLevel,
        message: String,
    ) -> wasmtime::Result<()> {
        if !self.log_enabled {
            return Err(wasmtime::Error::msg("log permission denied"));
        }
        if message.len() > self.max_log_bytes {
            return Err(wasmtime::Error::msg("log message exceeds configured limit"));
        }
        let level = format!("{level:?}");
        tracing::info!(plugin_id = %self.plugin_id, plugin_level = %level, "{message}");
        Ok(())
    }
}

pub(crate) struct WasmPlugin {
    engine: Engine,
    component: Component,
    manifest: PluginManifest,
    limits: PluginLimits,
    semaphore: Arc<Semaphore>,
    epoch_task: tokio::task::JoinHandle<()>,
}

pub(crate) struct ToolMetadata {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

impl WasmPlugin {
    pub(crate) async fn load(
        manifest: PluginManifest,
        wasm: &[u8],
        limits: PluginLimits,
    ) -> Result<(Arc<Self>, Vec<ToolMetadata>), PluginError> {
        limits.validate()?;
        if wasm.len() > limits.max_component_bytes {
            return Err(PluginError::new(
                PluginFailureKind::ResourceLimit,
                "plugin component exceeds configured limit",
            ));
        }
        let mut config = Config::new();
        config.async_support(true);
        config.consume_fuel(true);
        config.epoch_interruption(true);
        let engine = Engine::new(&config)
            .map_err(|error| PluginError::new(PluginFailureKind::Compile, error.to_string()))?;
        let component = Component::new(&engine, wasm)
            .map_err(|error| PluginError::new(PluginFailureKind::Compile, error.to_string()))?;
        let epoch_engine = engine.clone();
        let epoch_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(EPOCH_INTERVAL);
            loop {
                interval.tick().await;
                epoch_engine.increment_epoch();
            }
        });
        let plugin = Arc::new(Self {
            engine,
            component,
            semaphore: Arc::new(Semaphore::new(limits.max_concurrent_calls)),
            manifest,
            limits,
            epoch_task,
        });
        let (identity, tools) = plugin.probe().await?;
        if identity.id != plugin.manifest.id
            || identity.version != plugin.manifest.version.to_string()
            || identity.api_version != plugin.manifest.api_version.to_string()
        {
            return Err(PluginError::new(
                PluginFailureKind::IdentityMismatch,
                "component identity does not match manifest",
            ));
        }
        if tools.is_empty() {
            return Err(PluginError::new(
                PluginFailureKind::InvalidMetadata,
                "component exports no tools",
            ));
        }
        let mut metadata = Vec::with_capacity(tools.len());
        for tool in tools {
            validate_tool_name(&tool.name)?;
            let input_schema = serde_json::from_str(&tool.input_schema_json).map_err(|_| {
                PluginError::new(
                    PluginFailureKind::InvalidMetadata,
                    "invalid input JSON Schema",
                )
            })?;
            let output_schema = serde_json::from_str(&tool.output_schema_json).map_err(|_| {
                PluginError::new(
                    PluginFailureKind::InvalidMetadata,
                    "invalid output JSON Schema",
                )
            })?;
            metadata.push(ToolMetadata {
                name: tool.name,
                description: tool.description,
                input_schema,
                output_schema,
            });
        }
        Ok((plugin, metadata))
    }

    async fn probe(
        &self,
    ) -> Result<
        (
            bindings::exports::miniq::plugin::guest::PluginIdentity,
            Vec<bindings::exports::miniq::plugin::guest::ToolMetadata>,
        ),
        PluginError,
    > {
        let cancel = CancellationToken::new();
        let (mut store, bindings) = self.instantiate(&cancel).await?;
        let guest = bindings.miniq_plugin_guest();
        store.set_epoch_deadline(self.epoch_deadline_ticks());
        let identity = self
            .bounded_call(guest.call_identity(&mut store), &cancel)
            .await?;
        store.set_epoch_deadline(self.epoch_deadline_ticks());
        let tools = self
            .bounded_call(guest.call_tools(&mut store), &cancel)
            .await?;
        Ok((identity, tools))
    }

    async fn execute(
        &self,
        tool_name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, PluginError> {
        let tool_name = tool_name
            .strip_prefix(&format!("{}.", self.manifest.id))
            .unwrap_or(tool_name);
        let input = serde_json::to_string(&input).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidMetadata, error.to_string())
        })?;
        if input.len() > self.limits.max_input_bytes {
            return Err(PluginError::new(
                PluginFailureKind::ResourceLimit,
                "plugin input exceeds configured limit",
            ));
        }
        let _permit = tokio::select! {
            permit = self.semaphore.acquire() => permit.map_err(|_| PluginError::new(PluginFailureKind::Cancelled, "plugin is unloading"))?,
            _ = cancel.cancelled() => return Err(PluginError::new(PluginFailureKind::Cancelled, "plugin call cancelled")),
        };
        let (mut store, bindings) = self.instantiate(&cancel).await?;
        let guest = bindings.miniq_plugin_guest();
        store.set_epoch_deadline(self.epoch_deadline_ticks());
        let call = guest.call_execute(&mut store, tool_name, &input);
        let result = self.bounded_call(call, &cancel).await?;
        match result {
            bindings::exports::miniq::plugin::guest::ExecutionResult::Ok(json) => {
                if json.len() > self.limits.max_output_bytes {
                    return Err(PluginError::new(
                        PluginFailureKind::OutputLimit,
                        "plugin output exceeds configured limit",
                    ));
                }
                serde_json::from_str(&json).map_err(|_| {
                    PluginError::new(
                        PluginFailureKind::InvalidMetadata,
                        "plugin returned invalid JSON",
                    )
                })
            }
            bindings::exports::miniq::plugin::guest::ExecutionResult::Error(message) => {
                Err(PluginError::new(PluginFailureKind::Trap, message))
            }
        }
    }

    async fn instantiate(
        &self,
        cancel: &CancellationToken,
    ) -> Result<(Store<HostState>, bindings::ToolPlugin), PluginError> {
        let mut linker = Linker::new(&self.engine);
        bindings::miniq::plugin::host::add_to_linker(&mut linker, |state| state)
            .map_err(|error| PluginError::new(PluginFailureKind::Instantiate, error.to_string()))?;
        wasmtime_wasi::add_to_linker_async(&mut linker)
            .map_err(|error| PluginError::new(PluginFailureKind::Instantiate, error.to_string()))?;
        let state = HostState {
            plugin_id: self.manifest.id.clone(),
            log_enabled: self.manifest.permissions.contains(&PluginPermission::Log),
            max_log_bytes: self.limits.max_log_bytes,
            limits: StoreLimitsBuilder::new()
                .memory_size(self.limits.max_memory_bytes)
                .build(),
            wasi: WasiCtxBuilder::new().build(),
            table: ResourceTable::new(),
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store.set_fuel(self.limits.fuel_per_call).map_err(|error| {
            PluginError::new(PluginFailureKind::ResourceLimit, error.to_string())
        })?;
        store
            .fuel_async_yield_interval(Some(100_000))
            .map_err(|error| {
                PluginError::new(PluginFailureKind::ResourceLimit, error.to_string())
            })?;
        store.set_epoch_deadline(self.epoch_deadline_ticks());
        let bindings = self
            .bounded_call(
                bindings::ToolPlugin::instantiate_async(&mut store, &self.component, &linker),
                cancel,
            )
            .await
            .map_err(|error| {
                if matches!(error.kind, PluginFailureKind::Trap) {
                    PluginError::new(PluginFailureKind::Instantiate, error.message)
                } else {
                    error
                }
            })?;
        Ok((store, bindings))
    }

    async fn bounded_call<T>(
        &self,
        call: impl std::future::Future<Output = wasmtime::Result<T>>,
        cancel: &CancellationToken,
    ) -> Result<T, PluginError> {
        tokio::pin!(call);
        let timeout = tokio::time::sleep(self.limits.call_timeout);
        tokio::pin!(timeout);
        let result = tokio::select! {
            result = &mut call => result,
            _ = &mut timeout => {
                return Err(PluginError::new(
                PluginFailureKind::Timeout,
                "plugin call exceeded wall-clock timeout",
                ));
            }
            _ = cancel.cancelled() => {
                return Err(PluginError::new(
                    PluginFailureKind::Cancelled,
                    "plugin call cancelled",
                ));
            }
        };
        match result {
            Err(error) => {
                let text = error.to_string();
                let kind = if text.contains("epoch deadline") || text.contains("interrupt") {
                    PluginFailureKind::Timeout
                } else if text.contains("fuel") {
                    PluginFailureKind::FuelExhausted
                } else if text.contains("memory") || text.contains("resource limit") {
                    PluginFailureKind::ResourceLimit
                } else {
                    PluginFailureKind::Trap
                };
                Err(PluginError::new(kind, text))
            }
            Ok(value) => Ok(value),
        }
    }

    fn epoch_deadline_ticks(&self) -> u64 {
        let interval_millis = EPOCH_INTERVAL.as_millis().max(1);
        let timeout_millis = self.limits.call_timeout.as_millis();
        timeout_millis.div_ceil(interval_millis).max(1) as u64
    }
}

impl Drop for WasmPlugin {
    fn drop(&mut self) {
        self.epoch_task.abort();
    }
}

pub(crate) struct WasmTool {
    public_name: String,
    guest_name: String,
    description: String,
    input_schema: Value,
    #[allow(dead_code)]
    output_schema: Value,
    plugin: Arc<WasmPlugin>,
    cancellation: CancellationToken,
}

impl WasmTool {
    pub(crate) fn new(
        plugin: Arc<WasmPlugin>,
        metadata: ToolMetadata,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            public_name: format!("{}.{}", plugin.manifest.id, metadata.name),
            guest_name: metadata.name,
            description: metadata.description,
            input_schema: metadata.input_schema,
            output_schema: metadata.output_schema,
            plugin,
            cancellation,
        }
    }
}

#[async_trait]
impl Tool for WasmTool {
    fn name(&self) -> &str {
        &self.public_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> Value {
        self.input_schema.clone()
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "sandboxed WASM pure-compute plugin".into(),
        }
    }

    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        self.plugin
            .execute(&self.guest_name, input, self.cancellation.child_token())
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
    }
}

fn validate_tool_name(name: &str) -> Result<(), PluginError> {
    if name.is_empty()
        || name.len() > 64
        || !name.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '_'
                || character == '-'
        })
    {
        return Err(PluginError::new(
            PluginFailureKind::InvalidMetadata,
            "tool name must contain only lowercase ASCII letters, digits, '_' or '-'",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use semver::Version;

    use super::*;
    use crate::manifest::PluginCapability;
    use miniq_protocol::PluginRuntime;

    fn manifest() -> PluginManifest {
        PluginManifest {
            id: "dev.miniq.fixture".into(),
            name: "Fixture".into(),
            version: Version::new(1, 0, 0),
            api_version: Version::new(1, 0, 0),
            runtime: PluginRuntime::Wasm,
            entry: "plugin.wasm".into(),
            capabilities: vec![PluginCapability::Tool],
            permissions: Vec::new(),
            enabled: true,
            description: None,
            author: None,
            engine: None,
        }
    }

    #[tokio::test]
    async fn malformed_bytes_are_a_compile_failure() {
        let error = match WasmPlugin::load(manifest(), b"not wasm", PluginLimits::default()).await {
            Ok(_) => panic!("malformed bytes must fail"),
            Err(error) => error,
        };

        assert_eq!(error.kind, PluginFailureKind::Compile);
    }

    #[tokio::test]
    async fn component_without_guest_export_is_an_instantiate_failure() {
        let error =
            match WasmPlugin::load(manifest(), b"(component)", PluginLimits::default()).await {
                Ok(_) => panic!("component without guest export must fail"),
                Err(error) => error,
            };

        assert_eq!(error.kind, PluginFailureKind::Instantiate);
    }
}
