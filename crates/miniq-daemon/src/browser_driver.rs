use std::time::Duration;

use async_trait::async_trait;
use miniq_protocol::{BrowserDriverRequest as ProtocolRequest, Event};
use miniq_tools::{BrowserDriver, BrowserDriverRequest, BrowserDriverResponse};

use crate::state::AppState;

pub(crate) struct DaemonBrowserDriver {
    pub state: AppState,
    pub session_id: String,
}

#[async_trait]
impl BrowserDriver for DaemonBrowserDriver {
    async fn execute(
        &self,
        request: BrowserDriverRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<BrowserDriverResponse, String> {
        let request_id = miniq_memory::new_id("browser");
        let receiver = self.state.register_browser_request(&request_id);
        self.state.emit(Event::BrowserDriverRequested {
            request: ProtocolRequest {
                id: request_id.clone(),
                session_id: self.session_id.clone(),
                browser_session_id: request.session_id,
                operation: request.operation,
                arguments: request.arguments,
            },
        });
        let response = tokio::select! {
            _ = cancellation.cancelled() => Err("browser request cancelled".into()),
            _ = tokio::time::sleep(Duration::from_secs(60)) => Err("embedded browser client did not respond within 60 seconds".into()),
            response = receiver => response.map_err(|_| "embedded browser client disconnected".to_string())?,
        };
        self.state.finish_browser_request(&request_id);
        let response = response?;
        Ok(BrowserDriverResponse {
            capabilities: response.capabilities,
            result: response.result,
        })
    }
}
