use miniq_models::ToolCallRequest;
use miniq_tools::ToolRouter;
use serde_json::{json, Value};

pub(super) fn unknown_tool_output(
    router: &ToolRouter,
    call: &ToolCallRequest,
    error: &miniq_tools::ToolError,
) -> Value {
    let available_tools = router
        .specs()
        .into_iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>();
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
