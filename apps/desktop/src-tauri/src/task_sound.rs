//! Generated desktop reminder tones. macOS playback does not depend on WebKit autoplay.
#[cfg(target_os = "macos")]
use tauri::Manager;

fn notes(kind: &str) -> Result<&'static [(f64, f64)], String> {
    match kind {
        "completed" => Ok(&[(660.0, 0.09), (880.0, 0.13)]),
        "failed" => Ok(&[(440.0, 0.12), (220.0, 0.18)]),
        "attention" => Ok(&[(740.0, 0.08), (880.0, 0.08), (740.0, 0.1)]),
        _ => Err("Unknown reminder sound".into()),
    }
}

fn wave(kind: &str, volume: f64) -> Result<Vec<u8>, String> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        return Err("Sound volume must be between 0 and 1".into());
    }
    let rate = 24_000u32;
    let mut pcm = Vec::new();
    for &(frequency, duration) in notes(kind)? {
        let count = (duration * f64::from(rate)) as usize;
        for index in 0..count {
            let t = index as f64 / f64::from(rate);
            let envelope = (t / 0.012).min(1.0) * ((duration - t) / 0.025).min(1.0);
            let sample = ((t * frequency * std::f64::consts::TAU).sin()
                * envelope
                * volume
                * 0.35
                * f64::from(i16::MAX)) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        pcm.resize(pcm.len() + (0.035 * f64::from(rate)) as usize * 2, 0);
    }
    let size = pcm.len() as u32;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&pcm);
    Ok(bytes)
}

#[tauri::command]
pub async fn play_task_sound(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    kind: String,
    volume: f64,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the main view can play reminders".into());
    }
    let bytes = wave(&kind, volume)?;
    #[cfg(target_os = "macos")]
    {
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = dir.join(format!("reminder-{}-{stamp}.wav", std::process::id()));
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
            let result = std::process::Command::new("/usr/bin/afplay")
                .arg(&path)
                .status();
            let _ = std::fs::remove_file(&path);
            match result {
                Ok(status) if status.success() => Ok(()),
                Ok(_) => Err("System audio playback failed".into()),
                Err(error) => Err(error.to_string()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, bytes);
        Err("Native reminder playback is only available on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_wave_and_bounded_inputs() {
        for kind in ["completed", "failed", "attention"] {
            let bytes = wave(kind, 0.55).unwrap();
            assert_eq!(&bytes[..4], b"RIFF");
            assert!(bytes.len() > 44);
            assert_eq!(
                wave(kind, 0.0).unwrap()[44..]
                    .iter()
                    .filter(|v| **v != 0)
                    .count(),
                0
            );
        }
        assert!(wave("arbitrary", 0.55).is_err());
        assert!(wave("completed", f64::NAN).is_err());
        assert!(wave("completed", 2.0).is_err());
    }
}
