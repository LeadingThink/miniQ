//! miniq-protocol: JSON-RPC 2.0 request/response/event types shared between
//! the desktop UI and the local agent daemon.
//!
//! This crate only contains protocol types. It must not depend on UI, agent
//! runtime, tools or storage.

pub mod computer;
pub mod event;
pub mod execution;
pub mod external;
pub mod history;
pub mod model;
pub mod node_plugin;
pub mod plugin;
pub mod rpc;
pub mod types;

pub use computer::*;
pub use event::*;
pub use execution::*;
mod execution_events;
pub use execution_events::*;
mod agent_history;
pub use agent_history::*;
mod session_approval;
pub use external::*;
pub use history::*;
pub use model::*;
pub use node_plugin::*;
pub use plugin::*;
pub use rpc::*;
pub use session_approval::*;
mod approval_inbox;
pub use approval_inbox::*;
pub use types::*;

/// Protocol schema version. Bumped on breaking changes; no compatibility
/// layers are kept for older versions.
pub const PROTOCOL_VERSION: u32 = 1;
