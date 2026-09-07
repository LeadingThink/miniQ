use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ComputerPermissionState {
    Granted,
    Denied,
    NotRequired,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComputerPermissions {
    pub platform: String,
    pub process_id: u32,
    pub executable: String,
    pub screen_recording: ComputerPermissionState,
    pub accessibility: ComputerPermissionState,
    pub display_server: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ComputerPermission {
    ScreenRecording,
    Accessibility,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerPermissionRequest {
    pub permission: ComputerPermission,
}
