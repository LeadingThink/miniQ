use std::collections::HashSet;
use std::time::Duration;

use base64::Engine;
use miniq_protocol::{ErrorCode, RpcError};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::params;
use crate::state::AppState;

const DEFAULT_TRANSCRIPTION_MODEL: &str = "grok-transcribe";
/// Audio transcription models listed in OneAPI 音频与语音文档.
const TRANSCRIBE_CANDIDATES: &[&str] = &["grok-transcribe", "sencevoice-small"];
/// Speech synthesis model listed in OneAPI 音频与语音文档.
const TTS_MODEL: &str = "grok-tts";
const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;
/// Keep synthesized responses small enough for the 2 MiB remote relay cap
/// once Base64-encoded (plus RPC framing).
const MAX_SPEAK_CHARS: usize = 1500;
const MAX_SPEAK_AUDIO_BYTES: usize = 5 * 1024 * 1024;
const MODEL_CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

/// All Grok TTS voices from OneAPI docs (multilingual).
const TTS_VOICES: &[&str] = &[
    "ara", "carina", "celeste", "eve", "iris", "luna", "ursa", "altair", "atlas", "castor",
    "cosmo", "helios", "helix", "kepler", "leo", "lumen", "lux", "naksh", "orion", "perseus",
    "rex", "rigel", "sal", "sirius", "zagan", "zenith",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeParams {
    audio_base64: String,
    #[serde(default = "default_filename")]
    filename: String,
    #[serde(default)]
    preview: bool,
    #[serde(default)]
    transcribe_model: Option<String>,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeakParams {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    response_format: Option<String>,
}

struct VoiceAttemptError {
    error: RpcError,
    retryable: bool,
}

impl VoiceAttemptError {
    fn retryable(error: impl std::fmt::Display) -> Self {
        Self {
            error: provider_error(error),
            retryable: true,
        }
    }

    fn final_error(error: impl std::fmt::Display) -> Self {
        Self {
            error: provider_error(error),
            retryable: false,
        }
    }
}

fn default_filename() -> String {
    "record.wav".to_string()
}

fn empty_capabilities() -> Value {
    json!({
      "transcribe": false,
      "speak": false,
      "transcribeModel": Value::Null,
      "ttsModel": Value::Null,
    })
}

/// Whether `grok-tts` / `grok-transcribe` appear in the provider model list.
/// Returns flags instead of errors so the UI can hide voice buttons gracefully.
pub(super) async fn capabilities(state: &AppState) -> Result<Value, RpcError> {
    let provider = state
        .settings
        .lock()
        .map_err(|_| RpcError::new(ErrorCode::InternalError, "settings lock poisoned"))?
        .provider
        .clone();
    let Some(provider) = provider else {
        return Ok(empty_capabilities());
    };
    if provider.api_key.trim().is_empty() {
        return Ok(empty_capabilities());
    }
    let ids = match fetch_model_ids(&provider.base_url, &provider.api_key).await {
        Ok(ids) => ids,
        Err(_) => return Ok(empty_capabilities()),
    };
    let transcribe_model = TRANSCRIBE_CANDIDATES
        .iter()
        .find(|candidate| ids.contains(**candidate))
        .map(|value| value.to_string());
    let tts_model = ids.contains(TTS_MODEL).then(|| TTS_MODEL.to_string());
    Ok(json!({
      "transcribe": transcribe_model.is_some(),
      "speak": tts_model.is_some(),
      "transcribeModel": transcribe_model.map(Value::String).unwrap_or(Value::Null),
      "ttsModel": tts_model.map(Value::String).unwrap_or(Value::Null),
    }))
}

async fn fetch_model_ids(base_url: &str, api_key: &str) -> Result<HashSet<String>, RpcError> {
    let client = reqwest::Client::builder()
        .timeout(MODEL_CATALOG_TIMEOUT)
        .build()
        .map_err(provider_error)?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut request = client.get(url);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(provider_error)?;
    if !response.status().is_success() {
        return Err(provider_error(format!(
            "model catalog returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let payload: Value = response.json().await.map_err(provider_error)?;
    let rows = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| provider_error("model catalog is missing its data array"))?;
    let mut ids = HashSet::new();
    for row in rows {
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            ids.insert(id.to_string());
        }
    }
    Ok(ids)
}

/// OpenAI-compatible speech synthesis (`POST /v1/audio/speech`, model `grok-tts`).
pub(super) async fn speak(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SpeakParams = params(raw)?;
    let text = input.text.trim().to_string();
    if text.is_empty() {
        return Err(RpcError::new(ErrorCode::InvalidParams, "text is empty"));
    }
    if text.chars().count() > MAX_SPEAK_CHARS {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("text exceeds the {MAX_SPEAK_CHARS} character limit"),
        ));
    }
    let voice = input.voice.unwrap_or_else(|| "eve".to_string());
    if !TTS_VOICES.contains(&voice.as_str()) {
        return Err(RpcError::new(ErrorCode::InvalidParams, "unsupported voice"));
    }
    let format = input.response_format.unwrap_or_else(|| "mp3".to_string());
    if format != "mp3" && format != "wav" {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "responseFormat must be mp3 or wav",
        ));
    }
    let provider = state
        .settings
        .lock()
        .map_err(|_| RpcError::new(ErrorCode::InternalError, "settings lock poisoned"))?
        .provider
        .clone()
        .ok_or_else(|| {
            RpcError::new(ErrorCode::ProviderError, "model provider is not configured")
        })?;
    if provider.api_key.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            "model provider API key is not configured",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(provider_error)?;
    let url = format!("{}/audio/speech", provider.base_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .bearer_auth(&provider.api_key)
        .json(&json!({
          "model": TTS_MODEL,
          "input": text,
          "voice": voice,
          "response_format": format,
          "speed": 1.0,
        }))
        .send()
        .await
        .map_err(provider_error)?;
    let status = response.status();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(provider_error)?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes);
        let detail = detail.chars().take(500).collect::<String>();
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            format!("voice provider returned {}: {}", status.as_u16(), detail),
        ));
    }
    if bytes.len() > MAX_SPEAK_AUDIO_BYTES {
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            "voice provider returned oversized audio",
        ));
    }
    let mime_type = if format == "wav" {
        "audio/wav"
    } else {
        "audio/mpeg"
    };
    let mime_type = if mime.starts_with("audio/") {
        mime
    } else {
        mime_type.to_string()
    };
    Ok(json!({
      "audioBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
      "mimeType": mime_type,
      "characters": text.chars().count(),
      "voice": voice,
      "responseFormat": format,
    }))
}

pub(super) async fn transcribe(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: TranscribeParams = params(raw)?;
    let audio = decode_audio(&input.audio_base64)?;
    let transcribe_model = input
        .transcribe_model
        .as_deref()
        .unwrap_or(DEFAULT_TRANSCRIPTION_MODEL);
    if !TRANSCRIBE_CANDIDATES.contains(&transcribe_model) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "unsupported transcription model",
        ));
    }
    let provider = state
        .settings
        .lock()
        .map_err(|_| RpcError::new(ErrorCode::InternalError, "settings lock poisoned"))?
        .provider
        .clone()
        .ok_or_else(|| {
            RpcError::new(ErrorCode::ProviderError, "model provider is not configured")
        })?;
    if provider.api_key.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            "model provider API key is not configured",
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(if input.preview { 15 } else { 120 }))
        .build()
        .map_err(provider_error)?;
    let url = format!(
        "{}/audio/transcriptions",
        provider.base_url.trim_end_matches('/')
    );
    let filename = safe_wav_filename(&input.filename);
    let mut last_error = None;

    let delays: &[u64] = if input.preview { &[0] } else { &[0, 1, 3] };
    for &delay in delays {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match send_transcription(
            &client,
            &url,
            &provider.api_key,
            &filename,
            &audio,
            input.preview,
            transcribe_model,
        )
        .await
        {
            Ok(text) => return Ok(json!({ "text": text })),
            Err(failure) if !failure.retryable => return Err(failure.error),
            Err(failure) => last_error = Some(failure.error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| RpcError::new(ErrorCode::ProviderError, "voice transcription failed")))
}

fn decode_audio(encoded: &str) -> Result<Vec<u8>, RpcError> {
    if encoded.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "recording exceeds the 12 MB limit",
        ));
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "audioBase64 is invalid"))?;
    if audio.len() <= 44 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "recording is empty",
        ));
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "recording exceeds the 12 MB limit",
        ));
    }
    Ok(audio)
}

fn safe_wav_filename(filename: &str) -> String {
    let stem = filename
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("record.wav");
    if stem.to_ascii_lowercase().ends_with(".wav") {
        stem.to_string()
    } else {
        format!("{stem}.wav")
    }
}

async fn send_transcription(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    filename: &str,
    audio: &[u8],
    preview: bool,
    transcribe_model: &str,
) -> Result<String, VoiceAttemptError> {
    let file = Part::bytes(audio.to_vec())
        .file_name(filename.to_string())
        .mime_str("audio/wav")
        .map_err(VoiceAttemptError::final_error)?;
    let form = Form::new()
        .text("model", transcribe_model.to_string())
        .text("response_format", "json")
        .part("file", file);
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(VoiceAttemptError::retryable)?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(VoiceAttemptError::retryable)?;
    if !status.is_success() {
        return Err(VoiceAttemptError {
            error: RpcError::new(
                ErrorCode::ProviderError,
                format!("voice provider returned {}: {}", status.as_u16(), body),
            ),
            retryable: status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error(),
        });
    }
    let result: TranscriptionResponse =
        serde_json::from_str(&body).map_err(|error| VoiceAttemptError {
            error: RpcError::new(
                ErrorCode::ProviderError,
                format!("invalid voice provider response: {error}"),
            ),
            retryable: false,
        })?;
    let text = result.text.trim();
    if text.is_empty() && !preview {
        return Err(VoiceAttemptError::final_error(
            "voice provider returned empty text",
        ));
    }
    Ok(text.to_string())
}

fn provider_error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::ProviderError, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_audio() {
        let tiny = base64::engine::general_purpose::STANDARD.encode([0_u8; 44]);
        assert!(decode_audio(&tiny).is_err());
        let huge =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; MAX_AUDIO_BYTES + 1]);
        assert!(decode_audio(&huge).is_err());
    }

    #[test]
    fn normalizes_untrusted_filenames() {
        assert_eq!(safe_wav_filename("../speech"), "speech.wav");
        assert_eq!(safe_wav_filename("voice.WAV"), "voice.WAV");
    }

    #[test]
    fn rejects_invalid_speak_voice_and_format() {
        assert!(!TTS_VOICES.is_empty());
        assert!(TTS_VOICES.contains(&"eve"));
        assert!(TRANSCRIBE_CANDIDATES.contains(&"grok-transcribe"));
        assert!(TRANSCRIBE_CANDIDATES.contains(&"sencevoice-small"));
        assert_eq!(TTS_MODEL, "grok-tts");
    }
}
