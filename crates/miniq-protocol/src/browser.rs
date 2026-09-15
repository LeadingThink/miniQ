use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub navigation_control: bool,
    pub dom_snapshot: bool,
    pub screenshot: bool,
    pub tabs: bool,
    pub pointer_input: bool,
    pub keyboard_input: bool,
    pub select_input: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDriverRequest {
    pub id: String,
    pub session_id: String,
    pub browser_session_id: String,
    pub operation: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDriverResult {
    pub capabilities: BrowserCapabilities,
    pub result: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDriverResolution {
    pub request_id: String,
    pub result: Option<BrowserDriverResult>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_driver_protocol_uses_camel_case_fields() {
        let request = BrowserDriverRequest {
            id: "request-1".into(),
            session_id: "session-1".into(),
            browser_session_id: "task-1".into(),
            operation: "snapshot".into(),
            arguments: json!({"nextObservationId":"observation-1"}),
        };
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["sessionId"], "session-1");
        assert_eq!(encoded["browserSessionId"], "task-1");
        assert!(encoded.get("browser_session_id").is_none());
        assert_eq!(
            serde_json::from_value::<BrowserDriverRequest>(encoded)
                .unwrap()
                .browser_session_id,
            "task-1"
        );

        let capabilities = serde_json::to_value(BrowserCapabilities {
            navigation_control: true,
            dom_snapshot: true,
            screenshot: false,
            tabs: false,
            pointer_input: true,
            keyboard_input: true,
            select_input: true,
        })
        .unwrap();
        assert_eq!(capabilities["navigationControl"], true);
        assert_eq!(capabilities["domSnapshot"], true);
        assert_eq!(capabilities["pointerInput"], true);
    }

    #[test]
    fn browser_resolution_schema_exposes_result_and_error() {
        let schema = serde_json::to_value(schemars::schema_for!(BrowserDriverResolution)).unwrap();
        assert!(schema["properties"].get("requestId").is_some());
        assert!(schema["properties"].get("result").is_some());
        assert!(schema["properties"].get("error").is_some());
    }
}
