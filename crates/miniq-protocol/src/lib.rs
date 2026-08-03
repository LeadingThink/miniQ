//! miniq-protocol: JSON-RPC 2.0 request/response/event types shared between
//! the desktop UI and the local agent daemon.
//!
//! This crate only contains protocol types. It must not depend on UI, agent
//! runtime, tools or storage.

pub mod event;
pub mod external;
pub mod rpc;
pub mod types;

pub use event::*;
pub use external::*;
pub use rpc::*;
pub use types::*;

/// Protocol schema version. Bumped on breaking changes; no compatibility
/// layers are kept for older versions.
pub const PROTOCOL_VERSION: u32 = 1;
