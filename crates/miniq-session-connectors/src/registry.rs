use std::path::Path;

use miniq_protocol::ExternalProvider;
use rayon::prelude::*;

use crate::claude::ClaudeConnector;
use crate::codex::CodexConnector;
use crate::opencode::OpenCodeConnector;
use crate::{ConnectorError, ConnectorScan, ExternalSessionSnapshot};

pub trait SessionConnector: Send + Sync {
    fn provider(&self) -> ExternalProvider;
    fn root(&self) -> &Path;
    fn scan(&self) -> ConnectorScan;
    fn load(
        &self,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, ConnectorError>;
}

pub struct ConnectorRegistry {
    connectors: Vec<Box<dyn SessionConnector>>,
}

impl ConnectorRegistry {
    pub fn new(connectors: Vec<Box<dyn SessionConnector>>) -> Self {
        Self { connectors }
    }

    pub fn scan_all(&self) -> Vec<ConnectorScan> {
        self.connectors
            .par_iter()
            .map(|connector| connector.scan())
            .collect()
    }

    pub fn scan_provider(&self, provider: ExternalProvider) -> Option<ConnectorScan> {
        self.connectors
            .iter()
            .find(|connector| connector.provider() == provider)
            .map(|connector| connector.scan())
    }

    pub fn load(
        &self,
        provider: ExternalProvider,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, ConnectorError> {
        let connector = self
            .connectors
            .iter()
            .find(|connector| connector.provider() == provider)
            .ok_or_else(|| {
                ConnectorError::InvalidData("external connector is unavailable".to_owned())
            })?;
        connector.load(external_id, source_path)
    }
}

pub fn builtin_registry() -> ConnectorRegistry {
    ConnectorRegistry::new(vec![
        Box::new(CodexConnector::from_environment()),
        Box::new(ClaudeConnector::from_environment()),
        Box::new(OpenCodeConnector::from_environment()),
    ])
}
