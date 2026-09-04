//! Sandboxed local WebAssembly Component plugins for miniQ.
//!
//! This crate owns admission, execution limits, lifecycle and adaptation to
//! `miniq_tools::Tool`. It has no daemon, RPC, UI or persistence dependency.

mod error;
mod host;
mod manager;
mod manifest;
mod node;

pub use error::{PluginError, PluginFailureKind, PluginLimits};
pub use manager::PluginManager;
pub use manifest::{
    ManifestError, PluginCapability, PluginEngine, PluginManifest, PluginPermission, API_VERSION,
};
pub use miniq_protocol::{PluginInfo, PluginProcessState, PluginRuntime, PluginStatus};
