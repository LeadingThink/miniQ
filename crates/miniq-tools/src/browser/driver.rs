use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use miniq_protocol::BrowserCapabilities;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDriverRequest {
    pub session_id: String,
    pub operation: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDriverResponse {
    pub capabilities: BrowserCapabilities,
    #[serde(default)]
    pub result: Value,
}

#[async_trait]
pub trait BrowserDriver: Send + Sync {
    async fn execute(
        &self,
        request: BrowserDriverRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<BrowserDriverResponse, String>;
}
