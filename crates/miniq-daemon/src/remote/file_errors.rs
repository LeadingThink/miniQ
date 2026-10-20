//! Stable file-transfer failures, separate from malformed RPC parameters.
use miniq_protocol::{ErrorCode, RpcError};
use serde_json::json;

pub(super) fn rpc_error(message: String) -> RpcError {
    let (code, reason) = match message.as_str() {
        "File storage unavailable" => (ErrorCode::InternalError, "file_storage_unavailable"),
        "File storage signing failed" => (ErrorCode::InternalError, "file_storage_failed"),
        "File transfer budget exceeded; retry after 60 seconds" => {
            (ErrorCode::InternalError, "file_budget_exceeded")
        }
        "File ticket timed out" | "File connection closed" | "File peer disconnected" => {
            (ErrorCode::InternalError, "file_connection_unavailable")
        }
        "File ticket permission denied" => (ErrorCode::Unauthorized, "file_ticket_forbidden"),
        "File transfer cancelled" => (ErrorCode::Cancelled, "file_transfer_cancelled"),
        _ => return RpcError::new(ErrorCode::InvalidParams, message),
    };
    let mut error = RpcError::new(code, message);
    error.data = Some(if reason == "file_budget_exceeded" {
        json!({"reason": reason, "retryAfterMs": 60000})
    } else {
        json!({"reason": reason})
    });
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operational_failures_do_not_blame_user_parameters() {
        for message in [
            "File storage unavailable",
            "File storage signing failed",
            "File ticket timed out",
        ] {
            let error = rpc_error(message.into());
            assert_eq!(error.code, ErrorCode::InternalError as i64);
            assert!(error.data.is_some());
        }
        let budget = rpc_error("File transfer budget exceeded; retry after 60 seconds".into());
        assert_eq!(budget.data.unwrap()["retryAfterMs"], 60000);
        assert_eq!(
            rpc_error("File transfer cancelled".into()).code,
            ErrorCode::Cancelled as i64
        );
        assert_eq!(
            rpc_error("File ticket permission denied".into()).code,
            ErrorCode::Unauthorized as i64
        );
        assert_eq!(
            rpc_error("Invalid file size or SHA-256".into()).code,
            ErrorCode::InvalidParams as i64
        );
    }
}
