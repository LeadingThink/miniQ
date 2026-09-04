use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginFailureKind {
    InvalidManifest,
    InvalidEntry,
    Incompatible,
    Process,
    Protocol,
    Compile,
    Instantiate,
    IdentityMismatch,
    InvalidMetadata,
    RegistrationConflict,
    Trap,
    Timeout,
    FuelExhausted,
    ResourceLimit,
    OutputLimit,
    Cancelled,
}

#[derive(Debug, Error)]
#[error("{kind:?}: {message}")]
pub struct PluginError {
    pub kind: PluginFailureKind,
    pub message: String,
}

impl PluginError {
    pub(crate) fn new(kind: PluginFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: sanitize(message.into()),
        }
    }
}

fn sanitize(message: String) -> String {
    let first_line = message.lines().next().unwrap_or("plugin operation failed");
    if first_line.len() <= 512 {
        first_line.to_string()
    } else {
        let boundary = first_line
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= 512)
            .last()
            .unwrap_or(0);
        format!("{}...", &first_line[..boundary])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_unicode_without_splitting_a_character() {
        let error = PluginError::new(PluginFailureKind::Trap, "界".repeat(200));
        assert!(error.message.is_char_boundary(error.message.len()));
        assert!(error.message.len() <= 515);
    }
}

#[derive(Debug, Clone)]
pub struct PluginLimits {
    pub max_component_bytes: usize,
    pub max_memory_bytes: usize,
    pub fuel_per_call: u64,
    pub call_timeout: Duration,
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_concurrent_calls: usize,
    pub max_log_bytes: usize,
    pub node_start_timeout: Duration,
    pub node_handshake_timeout: Duration,
    pub node_shutdown_timeout: Duration,
    pub max_protocol_frame_bytes: usize,
    pub max_pending_requests: usize,
    pub max_stderr_bytes: usize,
}

impl PluginLimits {
    pub fn validate(&self) -> Result<(), PluginError> {
        if self.max_component_bytes == 0
            || self.max_memory_bytes < 64 * 1024
            || self.fuel_per_call == 0
            || self.call_timeout.is_zero()
            || self.max_input_bytes == 0
            || self.max_output_bytes == 0
            || self.max_concurrent_calls == 0
            || self.max_log_bytes == 0
            || self.node_start_timeout.is_zero()
            || self.node_handshake_timeout.is_zero()
            || self.node_shutdown_timeout.is_zero()
            || self.max_protocol_frame_bytes < 1024
            || self.max_pending_requests == 0
            || self.max_stderr_bytes == 0
        {
            return Err(PluginError::new(
                PluginFailureKind::ResourceLimit,
                "all plugin limits must be positive and memory must allow one Wasm page",
            ));
        }
        Ok(())
    }
}

impl Default for PluginLimits {
    fn default() -> Self {
        Self {
            max_component_bytes: 16 * 1024 * 1024,
            max_memory_bytes: 32 * 1024 * 1024,
            fuel_per_call: 10_000_000,
            call_timeout: Duration::from_secs(5),
            max_input_bytes: 1024 * 1024,
            max_output_bytes: 4 * 1024 * 1024,
            max_concurrent_calls: 4,
            max_log_bytes: 16 * 1024,
            node_start_timeout: Duration::from_secs(5),
            node_handshake_timeout: Duration::from_secs(5),
            node_shutdown_timeout: Duration::from_secs(2),
            max_protocol_frame_bytes: miniq_protocol::NODE_PLUGIN_MAX_FRAME_BYTES,
            max_pending_requests: miniq_protocol::NODE_PLUGIN_MAX_PENDING_REQUESTS,
            max_stderr_bytes: 256 * 1024,
        }
    }
}
