use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

pub(super) struct DpiScope(DPI_AWARENESS_CONTEXT);

impl DpiScope {
    pub(super) fn enter() -> Result<Self, String> {
        // Only the blocking worker changes coordinate context, never the app UI.
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err("unable to enable physical-pixel desktop coordinates".into());
        }
        Ok(Self(previous))
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.0) };
    }
}

pub(super) fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    // Enigo normalizes absolute movement against the primary monitor only.
    // SetCursorPos supports physical coordinates across the virtual desktop.
    unsafe { windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y) }
        .map_err(|error| error.to_string())
}
