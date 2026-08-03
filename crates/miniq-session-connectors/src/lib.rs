//! Discovery and lossless parsing for sessions created by external agents.

mod claude;
mod codex;
mod common;
mod model;
mod opencode;
mod projection;
mod registry;

pub use miniq_protocol::{ExternalSessionEvent, ExternalSessionMessage, ExternalSessionSnapshot};
pub use model::{ConnectorError, ConnectorScan};
pub use registry::{builtin_registry, ConnectorRegistry, SessionConnector};
