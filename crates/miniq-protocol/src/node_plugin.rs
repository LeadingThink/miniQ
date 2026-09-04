use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const NODE_PLUGIN_PROTOCOL_VERSION: u32 = 1;
pub const NODE_PLUGIN_MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const NODE_PLUGIN_MAX_PENDING_REQUESTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum NodePluginMessage {
    Request(NodePluginRequest),
    Response(NodePluginResponse),
    Notification(NodePluginNotification),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NodePluginRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    pub method: NodePluginDaemonMethod,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NodePluginResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<NodePluginRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NodePluginNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: NodePluginHostMethod,
    pub params: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub enum NodePluginDaemonMethod {
    #[serde(rename = "initialize")]
    Initialize,
    #[serde(rename = "activate")]
    Activate,
    #[serde(rename = "tool.execute")]
    ToolExecute,
    #[serde(rename = "tool.cancel")]
    ToolCancel,
    #[serde(rename = "deactivate")]
    Deactivate,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub enum NodePluginHostMethod {
    #[serde(rename = "hello")]
    Hello,
    #[serde(rename = "activated")]
    Activated,
    #[serde(rename = "tools.register")]
    ToolsRegister,
    #[serde(rename = "tools.unregister")]
    ToolsUnregister,
    #[serde(rename = "tool.result")]
    ToolResult,
    #[serde(rename = "log")]
    Log,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "pong")]
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInitializeParams {
    pub protocol_version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub entry: String,
    pub max_frame_bytes: u32,
    pub max_pending_requests: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeHelloParams {
    pub protocol_version: u32,
    pub host_version: String,
    pub node_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolMetadata {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolsRegisterParams {
    pub tools: Vec<NodeToolMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolsUnregisterParams {
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolExecuteParams {
    pub call_id: String,
    pub tool_name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolCancelParams {
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeToolResultParams {
    pub call_id: String,
    pub result: Option<Value>,
    pub error: Option<NodePluginRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePluginRpcError {
    pub code: NodePluginErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodePluginErrorCode {
    InvalidRequest,
    ProtocolMismatch,
    InvalidPlugin,
    ActivationFailed,
    ToolNotFound,
    ExecutionFailed,
    Cancelled,
    Timeout,
    MessageTooLarge,
    CapacityExceeded,
    Internal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodePluginLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePluginLogParams {
    pub level: NodePluginLogLevel,
    pub message: String,
}
