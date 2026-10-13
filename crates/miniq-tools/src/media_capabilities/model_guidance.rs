//! Preserve model constraints in descriptions when a provider drops conditionals.
use super::*;

impl MediaCapabilitySnapshot {
    pub(super) fn model_guidance(&self, tool: &str, default: &str) -> String {
        let Some(kind) = tool_kind(tool) else {
            return String::new();
        };
        let mut lines = vec![format!(
            "Media capability snapshot: fetchedAt={} (Unix seconds), {}. Refresh interval: 24 hours. Unknown ranges remain channel-validated. {}",
            self.fetched_at,
            if now_secs().saturating_sub(self.fetched_at) >= MEDIA_REFRESH_INTERVAL_SECS { "stale cached data" }
            else if self.partial { "partial channel data" } else { "current channel data" }, if default.is_empty() {String::new()} else {format!("Default model: {default}.")}
        )];
        for model in self
            .models
            .iter()
            .filter(|m| m.kind == kind && supports_tool(m, tool))
        {
            let schema = if tool == "generate_video" {
                video_model_schema(model, self.schemas.get(tool))
            } else if tool == "synthesize_speech" {
                schema::speech_model_schema(model, self.schemas.get(tool).unwrap_or(&json!({})))
            } else {
                let mut schema = self
                    .schemas
                    .get(tool)
                    .map(|s| merge_tool_schema(tool, s))
                    .unwrap_or_else(|| json!({}));
                if let Some(overrides) = model
                    .schemas
                    .get(tool)
                    .and_then(|s| s.get("properties"))
                    .and_then(Value::as_object)
                {
                    for (key, value) in overrides {
                        schema["properties"][key] = value.clone();
                    }
                }
                schema
            };
            let mut fields = Vec::new();
            for field in tool_fields(tool).into_iter().filter(|f| *f != "model") {
                let Some(property) = schema.get("properties").and_then(|p| p.get(field)) else {
                    continue;
                };
                let mut constraints = Vec::new();
                for key in [
                    "enum",
                    "minimum",
                    "maximum",
                    "minLength",
                    "maxLength",
                    "minItems",
                    "maxItems",
                    "default",
                ] {
                    if let Some(value) = property.get(key) {
                        let text = serde_json::to_string(value).unwrap_or_default();
                        if text.len() <= 2048 {
                            constraints.push(format!("{key}={text}"));
                        }
                    }
                }
                if property.get("type") == Some(&json!("null")) {
                    constraints.push("unsupported".into());
                }
                if let Some(tags) = property.get("x-speech-tags") {
                    let instant = tags["instant"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|t| format!("[{t}]"))
                        .collect::<Vec<_>>();
                    let paired = tags["paired"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|t| format!("<{t}>...</{t}>"))
                        .collect::<Vec<_>>();
                    constraints.push(format!("Speech Tags in input: {}. Paired wrappers: {}. Close matching wrappers in nesting order. Use tags sparingly", instant.join(", "), paired.join(", ")));
                }
                if !constraints.is_empty() {
                    fields.push(format!("{field}: {}", constraints.join(" ")));
                }
            }
            if let Some(duration) = model.max_duration {
                fields.push(format!("channel maximum output duration: {duration} seconds; not an input character limit"));
            }
            if tool == "generate_image"
                && model.id.starts_with("gpt-image-")
                && Url::parse(&self.base_url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .as_deref()
                    == Some("oneapi.zaiwenai.com")
            {
                fields.push("Codex route: size/quality are prompt hints, not exact output controls. Put layout and aspect ratio in prompt".into());
            }
            if tool == "generate_video" {
                fields.push(if is_h3_model_id(&model.id) { "H3: local or HTTP(S) image/video/audio references; use model ID for 768P/2K; image_path and reference_images are mutually exclusive" }
                    else { "Grok: use either local image_path or local reference_images; no reference video/audio" }.into());
            }
            if fields.is_empty() {
                fields.push("additional ranges are unknown".into());
            }
            lines.push(format!("{} — {}.", model.id, fields.join("; ")));
        }
        if tool == "generate_music" {
            lines.push("Simple mode requires prompt. Custom mode requires style and title. In custom vocal mode, prompt is lyrics and must be nonempty. Custom instrumental mode may omit prompt.".into());
        }
        lines.join("\n")
    }
}

pub(super) fn widen_envelope(schema: &mut Value, models: &[(&str, Value)]) {
    if models.is_empty() {
        return;
    }
    let Some(properties) = schema["properties"].as_object_mut() else {
        return;
    };
    for (field, target) in properties
        .iter_mut()
        .filter(|(field, _)| field.as_str() != "model")
    {
        let constraints = models
            .iter()
            .map(|(_, s)| &s["properties"][field])
            .collect::<Vec<_>>();
        for key in [
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
        ] {
            if constraints.iter().any(|s| s.get(key).is_none()) {
                if let Some(target) = target.as_object_mut() {
                    target.remove(key);
                }
            } else {
                let values = constraints
                    .iter()
                    .filter_map(|s| s[key].as_f64())
                    .collect::<Vec<_>>();
                if values.len() == constraints.len() {
                    let min = matches!(key, "minimum" | "minLength" | "minItems");
                    let value = values
                        .into_iter()
                        .reduce(|a, b| if min { a.min(b) } else { a.max(b) })
                        .unwrap();
                    if matches!(key, "minLength" | "maxLength" | "minItems" | "maxItems") {
                        target[key] = json!(value as u64);
                    } else {
                        target[key] = json!(value);
                    }
                }
            }
        }
        if constraints.iter().all(|s| s["enum"].is_array()) {
            let mut choices = Vec::new();
            for choice in constraints
                .iter()
                .flat_map(|s| s["enum"].as_array().unwrap())
            {
                if !choices.contains(choice) {
                    choices.push(choice.clone());
                }
            }
            target["enum"] = json!(choices);
        } else if let Some(target) = target.as_object_mut() {
            target.remove("enum");
        }
        if let Some(target) = target.as_object_mut() {
            target.remove("anyOf");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guidance_carries_model_ranges_and_music_conditions_without_allof() {
        let _clock = test_guard();
        set_test_now(MEDIA_REFRESH_INTERVAL_SECS + 10);
        let snapshot: MediaCapabilitySnapshot = serde_json::from_value(json!({
            "baseUrl":"https://example.test/v1","fetchedAt":1,"schemas":baseline_schemas(),
            "models":[{"id":"music-a","kind":"music","maxDuration":null,"schemas":{"generate_music":{"properties":{"style_weight":{"maximum":0.3}}}}}],"partial":false
        })).unwrap();
        let guide = snapshot.model_guidance("generate_music", "music-a");
        assert!(guide.contains("music-a") && guide.contains("maximum=0.3"));
        assert!(
            guide.contains("Custom mode requires style and title")
                && guide.contains("prompt is lyrics")
        );
        assert!(guide.contains("stale cached data"));
        set_test_now(0);
    }
}
