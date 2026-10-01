//! Sandboxed local WebAssembly Component plugins for miniQ.
//!
//! This crate owns admission, execution limits, lifecycle and adaptation to
//! `miniq_tools::Tool`. It has no daemon, RPC, UI or persistence dependency.

mod bundled;
mod error;
mod host;
mod manager;
mod manifest;
mod node;

pub use bundled::{bundled_plugins, is_bundled, BundledPlugin};
pub use error::{PluginError, PluginFailureKind, PluginLimits};
pub use manager::{EnabledPluginMcpServer, PluginManager};
pub use manifest::{
    ManifestError, PluginCapability, PluginEngine, PluginManifest, PluginMcpServer,
    PluginPermission, API_VERSION,
};
pub use miniq_protocol::{PluginInfo, PluginProcessState, PluginRuntime, PluginStatus};
