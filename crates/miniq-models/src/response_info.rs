use miniq_protocol::ProviderResponseInfo;
use serde_json::Value;

use crate::ChatDelta;

/// Preserve provider fields; merging cumulative usage happens at observation.
pub(crate) fn response_info(value: &Value, stop_reason: Option<&str>) -> Option<ChatDelta> {
    let info = ProviderResponseInfo {
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        response_id: value.get("id").and_then(Value::as_str).map(str::to_owned),
        usage: value
            .get("usage")
            .filter(|value| value.is_object())
            .cloned(),
        stop_reason: stop_reason.map(str::to_owned),
    };
    (info != ProviderResponseInfo::default()).then_some(ChatDelta::ResponseInfo(info))
}
