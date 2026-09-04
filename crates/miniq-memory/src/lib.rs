//! miniq-memory: SQLite-backed persistence for workspaces, sessions,
//! messages, tool calls, approvals, memories and audit events.
//!
//! This crate only handles persistence. Business flow (agent loop, approval
//! decisions) lives elsewhere.

mod store;

pub use store::{
    new_id, now_iso, CheckpointRow, ExternalImportOutcome, MemoryError, MemoryRow,
    ModelContextSnapshot, SessionRecovery, StartupRecovery, Store,
};
