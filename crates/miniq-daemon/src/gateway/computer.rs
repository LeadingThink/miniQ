use miniq_protocol::{ComputerPermissionRequest, ErrorCode, RpcError};
use serde_json::Value;

use super::common::{params, to_value};

pub(super) async fn permissions() -> Result<Value, RpcError> {
    let status = tokio::task::spawn_blocking(miniq_tools::desktop_permissions)
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    to_value(status)
}

pub(super) async fn request(value: Option<Value>) -> Result<Value, RpcError> {
    let params: ComputerPermissionRequest = params(value)?;
    let status = tokio::task::spawn_blocking(move || {
        miniq_tools::request_desktop_permission(params.permission)
    })
    .await
    .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?
    .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    to_value(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_invalid_requests_before_any_system_action() {
        for value in [
            None,
            Some(serde_json::json!({})),
            Some(serde_json::json!({"permission":"shell"})),
            Some(serde_json::json!({"permission":"accessibility","command":"open"})),
        ] {
            assert!(request(value).await.is_err());
        }
    }

    #[tokio::test]
    async fn diagnostics_serialize_the_execution_process_without_prompting() {
        let status = permissions().await.unwrap();
        assert_eq!(status["processId"], std::process::id());
        assert!(status["screenRecording"].is_string());
        assert!(status["accessibility"].is_string());
        assert_eq!(status["platform"], std::env::consts::OS);
    }
}
