//! Server builds have no desktop capture/input libraries or advertised GUI tools.

use async_trait::async_trait;
use miniq_protocol::{ComputerPermission, ComputerPermissionState, ComputerPermissions};
use miniq_sandbox::Risk;
use serde_json::Value;

use crate::{Tool, ToolContext, ToolError};

const UNSUPPORTED: &str = "computer_unsupported: this server build has no native desktop; use browser_automation, shell and file tools, or install the desktop edition on a graphical host";

pub fn desktop_permissions() -> ComputerPermissions {
    ComputerPermissions {
        platform: std::env::consts::OS.into(),
        process_id: std::process::id(),
        executable: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        screen_recording: ComputerPermissionState::Unsupported,
        accessibility: ComputerPermissionState::Unsupported,
        display_server: None,
    }
}

pub fn request_desktop_permission(_: ComputerPermission) -> Result<ComputerPermissions, String> {
    Err(UNSUPPORTED.into())
}

// Keep the public Rust tool type available for integrations; the default server
// catalog does not register it. Explicit use fails without touching the desktop.
#[derive(Default)]
pub struct ComputerUseTool;

#[async_trait]
impl Tool for ComputerUseTool {
    fn name(&self) -> &str {
        "computer_use"
    }
    fn description(&self) -> &str {
        UNSUPPORTED
    }
    fn parameters_schema(&self) -> Value {
        serde_json::json!({"not": {}})
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: miniq_protocol::RiskLevel::High,
            reason: UNSUPPORTED.into(),
        }
    }
    async fn execute(&self, _: &ToolContext, _: Value) -> Result<Value, ToolError> {
        Err(ToolError::ExecutionFailed(UNSUPPORTED.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn server_catalog_preserves_tasks_but_never_advertises_desktop_control() {
        let tools = crate::default_router().catalog()();
        for required in ["shell_run", "file_read", "browser_automation", "agent_run"] {
            assert!(tools.iter().any(|tool| tool.name == required), "{required}");
        }
        assert!(!tools
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "computer_use" | "app_automation")));
        assert_eq!(
            desktop_permissions().accessibility,
            ComputerPermissionState::Unsupported
        );
        assert!(request_desktop_permission(ComputerPermission::Accessibility).is_err());
        let error = ComputerUseTool
            .execute(&ToolContext::new(std::env::temp_dir()), Value::Null)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("computer_unsupported"));
    }
}
