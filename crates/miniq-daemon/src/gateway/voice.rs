use std::time::Duration;

use base64::Engine;
use miniq_protocol::{ErrorCode, RpcError};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::params;
use crate::state::AppState;

const TRANSCRIPTION_MODEL: &str = "grok-transcribe";
const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeParams {
    audio_base64: String,
    #[serde(default = "default_filename")]
    filename: String,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
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

pub(super) async fn transcribe(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: TranscribeParams = params(raw)?;
    let audio = decode_audio(&input.audio_base64)?;
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
    let url = format!(
        "{}/audio/transcriptions",
        provider.base_url.trim_end_matches('/')
    );
    let filename = safe_wav_filename(&input.filename);
    let mut last_error = None;

    for delay in [0, 1, 3] {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match send_transcription(&client, &url, &provider.api_key, &filename, &audio).await {
            Ok(text) => return Ok(json!({ "text": text })),
            Err(failure) if !failure.retryable => return Err(failure.error),
            Err(failure) => last_error = Some(failure.error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| RpcError::new(ErrorCode::ProviderError, "voice transcription failed")))
}

fn decode_audio(encoded: &str) -> Result<Vec<u8>, RpcError> {
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
) -> Result<String, VoiceAttemptError> {
    let file = Part::bytes(audio.to_vec())
        .file_name(filename.to_string())
        .mime_str("audio/wav")
        .map_err(VoiceAttemptError::final_error)?;
    let form = Form::new()
        .text("model", TRANSCRIPTION_MODEL)
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
                format!(
                    "voice provider returned {}: {}",
                    status.as_u16(),
                    body.chars().take(300).collect::<String>()
                ),
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
    if text.is_empty() {
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
}
