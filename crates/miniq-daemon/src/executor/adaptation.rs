use miniq_models::ToolCallRequest;
use serde_json::{json, Value};

pub(super) fn unknown_tool_output(
    available_tools: Vec<String>,
    call: &ToolCallRequest,
    error: &miniq_tools::ToolError,
) -> Value {
    json!({
        "error": {
            "code": "unknown_tool",
            "message": error.to_string(),
            "requestedTool": call.name,
            "availableTools": available_tools,
            "recovery": "Use one of availableTools with its advertised JSON schema. Supported provider-native names are adapted automatically."
        }
    })
}
