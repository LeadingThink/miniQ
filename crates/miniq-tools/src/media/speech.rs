//! Speech contracts, script validation and bounded response handling.
use super::*;

pub(super) const SPEECH_DESCRIPTION: &str = "Turn text into natural speech and return a playable audio file. Grok TTS supports documented [Tags] for pauses and vocal sounds, and <paired> delivery wrappers. Preserve the script and use matching wrappers; the input schema describes every supported Tag.";

const STANDALONE_TAGS: &[&str] = &[
    "pause",
    "long-pause",
    "hum-tune",
    "laugh",
    "chuckle",
    "giggle",
    "cry",
    "tsk",
    "tongue-click",
    "lip-smack",
    "breath",
    "inhale",
    "exhale",
    "sigh",
];
const WRAPPER_TAGS: &[&str] = &[
    "soft",
    "whisper",
    "loud",
    "build-intensity",
    "decrease-intensity",
    "higher-pitch",
    "lower-pitch",
    "slow",
    "fast",
    "sing-song",
    "singing",
    "laugh-speak",
    "emphasis",
];
const GROK_VOICES: &[&str] = &[
    "ara", "carina", "celeste", "eve", "iris", "luna", "ursa", "altair", "atlas", "castor",
    "cosmo", "helios", "helix", "kepler", "leo", "lumen", "lux", "naksh", "orion", "perseus",
    "rex", "rigel", "sal", "sirius", "zagan", "zenith",
];
const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;

/// Baseline `input.x-speech-tags`: bare instant and paired tag names.
pub(crate) fn speech_tags_schema() -> Value {
    json!({"instant":STANDALONE_TAGS,"paired":WRAPPER_TAGS})
}

pub(crate) fn generic_speech_schema() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(SpeechInput)).unwrap();
    schema["properties"]["input"]["minLength"] = json!(1);
    for (field, default) in [("voice", "eve"), ("response_format", "mp3")] {
        schema["properties"][field]["default"] = json!(default);
        schema["properties"][field]["minLength"] = json!(1);
    }
    schema
}

pub(crate) fn grok_speech_schema() -> Value {
    let mut schema = generic_speech_schema();
    schema["properties"]["input"]["x-speech-tags"] = speech_tags_schema();
    schema["properties"]["input"]["description"] = speech_tags_description(&speech_tags_schema());
    schema["properties"]["model"]["default"] = json!("grok-tts");
    let mut voices = GROK_VOICES
        .iter()
        .map(|voice| json!(voice))
        .collect::<Vec<_>>();
    voices.push(Value::Null);
    schema["properties"]["voice"]["enum"] = json!(voices);
    schema["properties"]["response_format"]["enum"] = json!(["mp3", "wav", null]);
    schema["properties"]["speed"]["minimum"] = json!(1);
    schema["properties"]["speed"]["maximum"] = json!(1);
    schema["properties"]["speed"]["default"] = json!(1.0);
    schema
}

/// Tool-visible contract uses Grok defaults, scoped to its model only.
pub(crate) fn speech_schema() -> Value {
    let mut schema = generic_speech_schema();
    schema["properties"]["input"]["description"] = speech_tags_description(&speech_tags_schema());
    schema["properties"]["model"]["default"] = json!("grok-tts");
    schema["allOf"] = json!([{
        "if":{"properties":{"model":{"enum":["grok-tts",null]}}},
        "then":{"properties":grok_speech_schema()["properties"]}
    }]);
    schema
}

fn speech_tags_description(tags: &Value) -> Value {
    let instant = tags["instant"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|tag| format!("[{tag}]"))
        .collect::<Vec<_>>();
    let paired = tags["paired"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|tag| format!("<{tag}>...</{tag}>"))
        .collect::<Vec<_>>();
    json!(format!(
        "Text to speak, sent unchanged. Instant speech Tags: {}. Paired delivery wrappers use angle brackets: {}. Square brackets are for instant Tags only. Wrappers must match and close in reverse nesting order. Unknown brackets remain literal text; no Tags are inserted automatically.",
        instant.join(", "),
        paired.join(", ")
    ))
}

/// Extract the bounded, normalized tag metadata produced by capability
/// discovery. Provider prose is deliberately ignored.
pub(crate) fn speech_tags_from_schema(schema: &Value) -> Option<Value> {
    let raw = schema.pointer("/properties/input/x-speech-tags")?;
    let read = |field: &str| {
        raw.get(field)
            .and_then(Value::as_array)
            .filter(|values| values.len() <= 64)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|tag| {
                        !tag.is_empty()
                            && tag.len() <= 40
                            && tag.as_bytes()[0].is_ascii_lowercase()
                            && tag.bytes().all(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                            })
                    })
                    .map(|tag| Value::String(tag.to_owned()))
                    .collect::<Vec<_>>()
            })
    };
    Some(json!({"instant":read("instant")?,"paired":read("paired")?}))
}

pub(crate) fn speech_schema_for(media: &MediaConfig, model: &str) -> Value {
    let mut schema = if model == "grok-tts" {
        grok_speech_schema()
    } else {
        generic_speech_schema()
    };
    if let Some(advertised) = media
        .capabilities
        .as_ref()
        .and_then(|r| r.snapshot(&media.base_url))
        .and_then(|s| {
            s.parameter_schema("synthesize_speech", model, "speed")
                .cloned()
        })
    {
        if [
            "enum",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "anyOf",
        ]
        .iter()
        .any(|key| advertised.get(key).is_some())
        {
            let speed = schema["properties"]["speed"].as_object_mut().unwrap();
            for key in ["minimum", "maximum"] {
                speed.remove(key);
            }
        }
    }
    if let Some(tags) = media
        .capabilities
        .as_ref()
        .and_then(|registry| registry.snapshot(&media.base_url))
        .and_then(|snapshot| {
            let input = snapshot.parameter_schema("synthesize_speech", model, "input")?;
            super::speech_tags_from_schema(&json!({"properties":{"input":input}}))
        })
    {
        schema["properties"]["input"]["x-speech-tags"] = tags.clone();
        schema["properties"]["input"]["description"] = speech_tags_description(&tags);
    }
    schema
}

pub(super) fn request_body(
    media: &MediaConfig,
    model: String,
    input: SpeechInput,
    baseline: &Value,
) -> Result<Value, ToolError> {
    let snapshot = media
        .capabilities
        .as_ref()
        .and_then(|r| r.snapshot(&media.base_url));
    let default = |field: &str| {
        snapshot
            .as_ref()
            .and_then(|s| s.parameter_schema("synthesize_speech", &model, field))
            .and_then(|s| s.get("default"))
            .filter(|v| !v.is_null())
            .or_else(|| baseline["properties"][field].get("default"))
            .cloned()
    };
    let default_text = |field: &str| default(field).and_then(|v| v.as_str().map(str::to_owned));
    let voice = nonempty_string(input.voice.or_else(|| default_text("voice")), "voice")?
        .unwrap_or_else(|| "eve".into());
    let format = nonempty_string(
        input
            .response_format
            .or_else(|| default_text("response_format")),
        "response_format",
    )?
    .unwrap_or_else(|| "mp3".into());
    let speed = input
        .speed
        .or_else(|| default("speed").and_then(|v| v.as_f64()));
    let mut body =
        json!({"model":model,"input":input.input,"voice":voice,"response_format":format});
    if let Some(speed) = speed {
        // JSON integer and floating representations denote the same speed.
        let advertised = snapshot
            .as_ref()
            .and_then(|s| {
                s.parameter_schema(
                    "synthesize_speech",
                    body["model"].as_str().unwrap(),
                    "speed",
                )
            })
            .and_then(|s| s.get("enum"))
            .and_then(Value::as_array)
            .and_then(|values| values.iter().find(|v| v.as_f64() == Some(speed)));
        body["speed"] = advertised.cloned().unwrap_or(json!(speed));
    }
    Ok(body)
}

pub(super) fn validate_tags(media: &MediaConfig, model: &str, text: &str) -> Result<(), ToolError> {
    let schema = speech_schema_for(media, model);
    let Some(rules) = schema.pointer("/properties/input/x-speech-tags") else {
        return Ok(());
    };
    validate_tag_pairs(text, rules)
}

fn validate_tag_pairs(text: &str, rules: &Value) -> Result<(), ToolError> {
    let known = |field: &str, tag: &str| {
        rules[field]
            .as_array()
            .is_some_and(|names| names.iter().any(|name| name.as_str() == Some(tag)))
    };
    let mut stack = Vec::new();
    let mut remaining = text;
    while let Some(open) = remaining.find(['[', '<']) {
        let opener = remaining.as_bytes()[open] as char;
        let closer = if opener == '[' { ']' } else { '>' };
        remaining = &remaining[open + 1..];
        let close = remaining.find(closer);
        // Unknown literal brackets can contain documented Tags of either kind.
        if let Some(inner) = remaining.find(['[', '<']) {
            if close.is_none_or(|close| inner < close) {
                remaining = &remaining[inner..];
                continue;
            }
        }
        let Some(close) = close else {
            break;
        };
        let token = &remaining[..close];
        let (closing, tag) = match token.strip_prefix('/') {
            Some(tag) => (true, tag),
            None => (false, token),
        };
        if known("paired", tag) {
            if opener != '<' {
                return Err(ToolError::InvalidInput(format!(
                    "speech wrapper {tag} requires <{tag}>...</{tag}>, not square brackets"
                )));
            }
            if closing {
                if stack.pop() != Some(tag) {
                    return Err(ToolError::InvalidInput(format!(
                        "unmatched or incorrectly nested speech Tag </{tag}>"
                    )));
                }
            } else {
                stack.push(tag);
            }
        } else if known("instant", tag) && (closing || opener != '[') {
            return Err(ToolError::InvalidInput(format!(
                "speech Tag [{tag}] uses square brackets and has no closing Tag"
            )));
        }
        remaining = &remaining[close + 1..];
    }
    if let Some(tag) = stack.last() {
        return Err(ToolError::InvalidInput(format!(
            "speech Tag <{tag}> requires </{tag}>"
        )));
    }
    Ok(())
}

pub(super) fn cancelled() -> ToolError {
    ToolError::ExecutionFailed("speech synthesis cancelled".into())
}

pub(super) fn response_mime(format: &str, response: &reqwest::Response) -> String {
    match format {
        "mp3" => "audio/mpeg".into(),
        "wav" => "audio/wav".into(),
        _ => response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .into(),
    }
}

pub(super) async fn read_response(
    ctx: &ToolContext,
    mut response: reqwest::Response,
) -> Result<Vec<u8>, ToolError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_AUDIO_BYTES as u64)
    {
        return Err(ToolError::ExecutionFailed(
            "speech provider returned audio larger than 64 MiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = ctx.cancellation.cancelled() => return Err(cancelled()),
            result = response.chunk() => result.map_err(|e| ToolError::ExecutionFailed(format!("read speech: {e}")))?,
        };
        let Some(chunk) = chunk else { break };
        if chunk.len() > MAX_AUDIO_BYTES - bytes.len() {
            return Err(ToolError::ExecutionFailed(
                "speech provider returned audio larger than 64 MiB".into(),
            ));
        }
        bytes
            .try_reserve_exact(chunk.len())
            .map_err(|e| ToolError::ExecutionFailed(format!("allocate speech audio: {e}")))?;
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(ToolError::ExecutionFailed(
            "speech provider returned empty audio".into(),
        ));
    }
    if ctx.cancellation.is_cancelled() {
        return Err(cancelled());
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "speech_tests.rs"]
mod tests;
