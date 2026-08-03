use std::path::PathBuf;

use miniq_protocol::{ExternalProvider, ExternalProviderStatus, ExternalSessionSummary};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("failed to read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid JSON in {path} at line {line}: {source}")]
    JsonLine {
        path: PathBuf,
        line: usize,
        source: serde_json::Error,
    },
    #[error("invalid connector data: {0}")]
    InvalidData(String),
    #[error("sqlite error in {path}: {source}")]
    Sqlite {
        path: PathBuf,
        source: rusqlite::Error,
    },
}

#[derive(Debug)]
pub struct ConnectorScan {
    pub status: ExternalProviderStatus,
    pub sessions: Vec<ExternalSessionSummary>,
    pub errors: Vec<ConnectorError>,
}

impl ConnectorScan {
    pub fn unavailable(provider: ExternalProvider, root: PathBuf) -> Self {
        Self {
            status: ExternalProviderStatus {
                provider,
                root: root.to_string_lossy().into_owned(),
                available: false,
                session_count: 0,
                message_count: 0,
                error: None,
            },
            sessions: Vec::new(),
            errors: Vec::new(),
        }
    }
}
