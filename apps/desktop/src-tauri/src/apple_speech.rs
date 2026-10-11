//! Local-only speech recognition. Audio arrives from the existing web recorder.
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Clone, Deserialize, Serialize)]
pub struct SpeechEvent {
    id: String,
    kind: String,
    text: String,
}

fn authorize(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("speech requires the main webview".into())
    }
}

#[tauri::command]
pub fn apple_speech_available(webview: tauri::Webview, language: String) -> Result<bool, String> {
    authorize(&webview)?;
    platform::available(&language)
}

#[tauri::command]
pub fn apple_speech_start(
    webview: tauri::Webview,
    id: String,
    language: String,
    sample_rate: f64,
    on_event: Channel<SpeechEvent>,
) -> Result<(), String> {
    authorize(&webview)?;
    if !sample_rate.is_finite() || !(8000.0..=192000.0).contains(&sample_rate) {
        return Err("invalid speech sample rate".into());
    }
    platform::start(&id, &language, sample_rate, on_event)
}

#[tauri::command]
pub fn apple_speech_append(
    webview: tauri::Webview,
    id: String,
    samples: Vec<f32>,
) -> Result<(), String> {
    authorize(&webview)?;
    if samples.is_empty() || samples.len() > 32768 || samples.iter().any(|s| !s.is_finite()) {
        return Err("invalid speech audio chunk".into());
    }
    platform::append(&id, &samples)
}

#[tauri::command]
pub fn apple_speech_finish(webview: tauri::Webview, id: String) -> Result<(), String> {
    authorize(&webview)?;
    platform::finish(&id)
}

#[tauri::command]
pub fn apple_speech_cancel(webview: tauri::Webview, id: String) -> Result<(), String> {
    authorize(&webview)?;
    platform::cancel(&id)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, CStr, CString};
    use std::sync::Mutex;
    static SESSION: Mutex<Option<(String, Channel<SpeechEvent>)>> = Mutex::new(None);
    extern "C" {
        fn miniq_apple_speech_available(language: *const c_char) -> i32;
        fn miniq_apple_speech_start(
            id: *const c_char,
            language: *const c_char,
            rate: f64,
            callback: extern "C" fn(*const c_char),
        );
        fn miniq_apple_speech_append(id: *const c_char, samples: *const f32, count: i32);
        fn miniq_apple_speech_finish(id: *const c_char);
        fn miniq_apple_speech_cancel(id: *const c_char);
    }
    fn cstring(value: &str) -> Result<CString, String> {
        if value.is_empty() || value.len() > 128 {
            return Err("invalid speech identifier".into());
        }
        CString::new(value).map_err(|_| "invalid speech identifier".into())
    }
    extern "C" fn event(raw: *const c_char) {
        if raw.is_null() {
            return;
        }
        // Swift supplies a NUL-terminated string valid for the duration of this callback.
        let Ok(value) =
            serde_json::from_slice::<SpeechEvent>(unsafe { CStr::from_ptr(raw) }.to_bytes())
        else {
            return;
        };
        let Ok(mut session) = SESSION.lock() else {
            return;
        };
        if let Some((id, channel)) = session.as_ref() {
            if *id == value.id {
                let terminal = value.kind == "error" || value.kind == "final";
                let failed = channel.send(value).is_err();
                if failed {
                    if let Ok(id) = cstring(id) {
                        unsafe { miniq_apple_speech_cancel(id.as_ptr()) };
                    }
                }
                if terminal || failed {
                    *session = None;
                }
            }
        }
    }
    pub fn available(language: &str) -> Result<bool, String> {
        let language = cstring(language)?;
        Ok(unsafe { miniq_apple_speech_available(language.as_ptr()) } == 1)
    }
    pub fn start(
        id: &str,
        language: &str,
        rate: f64,
        channel: Channel<SpeechEvent>,
    ) -> Result<(), String> {
        let identity = cstring(id)?;
        let language = cstring(language)?;
        let mut session = SESSION.lock().map_err(|_| "speech lock poisoned")?;
        if let Some((previous, events)) = session.take() {
            let _ = events.send(SpeechEvent {
                id: previous,
                kind: "error".into(),
                text: "local-session-replaced".into(),
            });
        }
        *session = Some((id.to_owned(), channel));
        unsafe { miniq_apple_speech_start(identity.as_ptr(), language.as_ptr(), rate, event) };
        Ok(())
    }
    fn active(id: &str) -> Result<CString, String> {
        let session = SESSION.lock().map_err(|_| "speech lock poisoned")?;
        if session.as_ref().is_none_or(|(current, _)| current != id) {
            return Err("speech session ended".into());
        }
        cstring(id)
    }
    pub fn append(id: &str, samples: &[f32]) -> Result<(), String> {
        let id = active(id)?;
        unsafe { miniq_apple_speech_append(id.as_ptr(), samples.as_ptr(), samples.len() as i32) };
        Ok(())
    }
    pub fn finish(id: &str) -> Result<(), String> {
        let id = active(id)?;
        unsafe { miniq_apple_speech_finish(id.as_ptr()) };
        Ok(())
    }
    pub fn cancel(id: &str) -> Result<(), String> {
        let identity = cstring(id)?;
        let mut session = SESSION.lock().map_err(|_| "speech lock poisoned")?;
        if session.as_ref().is_some_and(|(current, _)| current == id) {
            *session = None;
            unsafe { miniq_apple_speech_cancel(identity.as_ptr()) };
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub fn available(_: &str) -> Result<bool, String> {
        Ok(false)
    }
    pub fn start(_: &str, _: &str, _: f64, _: Channel<SpeechEvent>) -> Result<(), String> {
        Err("local speech unavailable".into())
    }
    pub fn append(_: &str, _: &[f32]) -> Result<(), String> {
        Err("local speech unavailable".into())
    }
    pub fn finish(_: &str) -> Result<(), String> {
        Err("local speech unavailable".into())
    }
    pub fn cancel(_: &str) -> Result<(), String> {
        Ok(())
    }
}
