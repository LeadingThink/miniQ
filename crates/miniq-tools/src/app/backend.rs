//! Platform boundary for application-scoped interaction, never global input.

use image::RgbaImage;
use miniq_protocol::ComputerPermissions;
use serde::Serialize;
use serde_json::Value;

use super::input::AppInput;
use crate::ToolContext;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppWindow {
    pub window_id: u32,
    pub pid: i32,
    /// OS process start identity; distinguishes a restarted app reusing the PID.
    pub process_instance: String,
    /// Discovery includes inaccessible windows, but they cannot be granted control.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl AppWindow {
    /// Titles are content (editing a document can change one), not window identity.
    pub fn same_target(&self, other: &Self) -> bool {
        self.window_id == other.window_id
            && self.pid == other.pid
            && self.process_instance == other.process_instance
            && self.app_name == other.app_name
            && self.x == other.x
            && self.y == other.y
            && self.width == other.width
            && self.height == other.height
    }
}

pub(super) trait AppBackend: Send + Sync {
    fn supported(&self) -> bool;
    fn permissions(&self) -> ComputerPermissions;
    fn windows(&self) -> Result<Vec<AppWindow>, String>;
    /// Retains references to this exact window and its AX controls. No activation.
    fn snapshot(&self, target: &AppWindow) -> Result<Box<dyn AppSnapshot>, String>;
    fn capture(&self, target: &AppWindow) -> Result<RgbaImage, String>;
}

pub(super) trait AppSnapshot: Send {
    /// Reject a closed/replaced window, process restart, or changed geometry.
    /// Changes to the user's foreground app are irrelevant to this target.
    fn validate(&self) -> Result<(), String>;
    /// Lazily expose children, public AXBrowser columns and AXScrollArea contents,
    /// preserving every value, nextOffset and explicit relationship sources.
    /// IDs are retained AX references, scoped to this snapshot. No password values.
    fn page(
        &mut self,
        parent_id: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<Value, String>;
    /// Check the element still belongs to this target, is enabled and supports the
    /// operation. Keyboard/coordinate events must never go to a different window,
    /// global HID, shared clipboard, or change the user's pointer/foreground app.
    fn perform(
        &mut self,
        ctx: &ToolContext,
        input: &AppInput,
        image_size: Option<(u32, u32)>,
    ) -> Result<Value, String>;
}

pub(super) struct NativeApp;

#[cfg(not(all(target_os = "macos", feature = "desktop")))]
impl AppBackend for NativeApp {
    fn supported(&self) -> bool {
        false
    }
    fn permissions(&self) -> ComputerPermissions {
        crate::desktop_permissions()
    }
    fn windows(&self) -> Result<Vec<AppWindow>, String> {
        Err(unsupported())
    }
    fn snapshot(&self, _: &AppWindow) -> Result<Box<dyn AppSnapshot>, String> {
        Err(unsupported())
    }
    fn capture(&self, _: &AppWindow) -> Result<RgbaImage, String> {
        Err(unsupported())
    }
}

#[cfg(not(all(target_os = "macos", feature = "desktop")))]
fn unsupported() -> String {
    "background_app_unsupported: application-scoped control currently requires macOS; browser_automation remains available for web tasks".into()
}
