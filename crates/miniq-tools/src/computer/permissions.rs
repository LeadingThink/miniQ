use miniq_protocol::{ComputerPermission, ComputerPermissionState as State, ComputerPermissions};

/// Preflight only. Called in the daemon, which owns capture and native input.
pub fn desktop_permissions() -> ComputerPermissions {
    let display_server = std::env::var("XDG_SESSION_TYPE").ok();
    let (screen_recording, accessibility) = platform_permissions(display_server.as_deref());
    ComputerPermissions {
        platform: std::env::consts::OS.into(),
        process_id: std::process::id(),
        executable: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        screen_recording,
        accessibility,
        display_server,
    }
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

#[cfg(target_os = "macos")]
fn request_accessibility() {
    use core_foundation::{
        base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString,
    };
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
    }
}

fn platform_permissions(_display_server: Option<&str>) -> (State, State) {
    #[cfg(target_os = "macos")]
    {
        let capture = core_graphics::access::ScreenCaptureAccess.preflight();
        // This check never prompts or modifies TCC permissions.
        let input = unsafe { AXIsProcessTrusted() };
        (permission_state(capture), permission_state(input))
    }
    #[cfg(target_os = "windows")]
    {
        (State::NotRequired, State::NotRequired)
    }
    #[cfg(target_os = "linux")]
    {
        if _display_server == Some("wayland") {
            (State::Unknown, State::Unsupported)
        } else if std::env::var_os("DISPLAY").is_some() {
            (State::NotRequired, State::NotRequired)
        } else {
            (State::Unsupported, State::Unsupported)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        (State::Unsupported, State::Unsupported)
    }
}

#[cfg(target_os = "macos")]
fn permission_state(granted: bool) -> State {
    if granted {
        State::Granted
    } else {
        State::Denied
    }
}

pub(super) fn require_permissions(
    permissions: &ComputerPermissions,
    input: bool,
) -> Result<(), String> {
    if matches!(
        permissions.screen_recording,
        State::Denied | State::Unsupported
    ) {
        return Err("computer_permission_required: Screen Recording is unavailable. In miniQ Settings > Computer Use, grant Screen Recording to the displayed execution app, then recheck. No screenshot or input was performed. Do not retry until the user grants access.".into());
    }
    if input
        && matches!(
            permissions.accessibility,
            State::Denied | State::Unsupported
        )
    {
        return Err(if permissions.accessibility == State::Unsupported {
            "computer_input_unsupported: desktop input requires a supported active desktop (X11 on Linux); browser_automation remains available. No input was performed."
        } else {
            "computer_permission_required: Accessibility is not granted. In miniQ Settings > Computer Use, grant Accessibility to the displayed execution app, then recheck and take a new screenshot. No input was performed. Do not retry until the user grants access."
        }.into());
    }
    Ok(())
}

/// Explicit local UI action only; this is not exposed as a model tool.
pub fn request_desktop_permission(
    permission: ComputerPermission,
) -> Result<ComputerPermissions, String> {
    #[cfg(target_os = "macos")]
    {
        let panel = match permission {
            ComputerPermission::ScreenRecording => {
                core_graphics::access::ScreenCaptureAccess.request();
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            ComputerPermission::Accessibility => {
                request_accessibility();
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
        };
        let result = std::process::Command::new("/usr/bin/open")
            .arg(panel)
            .status()
            .map_err(|error| format!("cannot open system privacy settings: {error}"))?;
        if !result.success() {
            return Err("system privacy settings did not open".into());
        }
        Ok(desktop_permissions())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err(
            "this platform has no macOS permission settings; check the active desktop session"
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_and_input_have_independent_permission_requirements() {
        let mut status = ComputerPermissions {
            platform: "test".into(),
            process_id: 1,
            executable: "test".into(),
            screen_recording: State::Granted,
            accessibility: State::Denied,
            display_server: None,
        };
        assert!(require_permissions(&status, false).is_ok());
        assert!(require_permissions(&status, true)
            .unwrap_err()
            .contains("Accessibility"));
        status.screen_recording = State::Denied;
        assert!(require_permissions(&status, false)
            .unwrap_err()
            .contains("Screen Recording"));
        status.screen_recording = State::NotRequired;
        status.accessibility = State::Unsupported;
        assert!(require_permissions(&status, true)
            .unwrap_err()
            .contains("unsupported"));
    }

    #[test]
    fn request_parameters_are_a_closed_enum() {
        for invalid in [
            serde_json::json!({"permission":"shell"}),
            serde_json::json!({"permission":"accessibility","command":"open anything"}),
        ] {
            assert!(
                serde_json::from_value::<miniq_protocol::ComputerPermissionRequest>(invalid)
                    .is_err()
            );
        }
    }
}
