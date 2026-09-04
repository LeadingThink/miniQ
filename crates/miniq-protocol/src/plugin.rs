use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginStatus {
    Discovered,
    Disabled,
    Loading,
    Active,
    Failed,
    Unloading,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntime {
    Wasm,
    Node,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginProcessState {
    NotApplicable,
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub status: PluginStatus,
    pub tools: Vec<String>,
    pub error: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub runtime: PluginRuntime,
    pub capabilities: Vec<String>,
    pub permissions: Vec<String>,
    pub trusted_code: bool,
    pub process_state: PluginProcessState,
    pub entry: String,
    pub engine_node: Option<String>,
    pub trust_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub plugins: Vec<PluginInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIdParams {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInstallParams {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSetEnabledParams {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub confirm_trusted_code: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnosticsResult {
    pub plugin: PluginInfo,
}
