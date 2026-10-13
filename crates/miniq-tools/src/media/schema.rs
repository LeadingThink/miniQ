//! Local tool contracts and channel-specific parameter validation.
use super::*;
use miniq_models::ToolSpec;

pub(super) fn image_schema() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(ImageInput)).unwrap();
    schema["properties"]["prompt"]["minLength"] = json!(1);
    schema
}

pub(crate) fn grok_video_schema() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(VideoInput)).unwrap();
    schema["properties"]["prompt"]["minLength"] = json!(1);
    let properties = schema["properties"].as_object_mut().unwrap();
    properties.get_mut("duration").unwrap().as_object_mut().unwrap().extend([
        ("minimum".into(), json!(1)), ("maximum".into(), json!(15)),
        ("default".into(), json!(8)),
        ("description".into(), json!("Video duration in seconds. The documented channel range is 1 to 15. Omit to use the channel default.")),
    ]);
    properties.get_mut("resolution").unwrap()["enum"] = json!(["480p", "720p", null]);
    properties.get_mut("resolution").unwrap()["default"] = json!("480p");
    properties.get_mut("aspect_ratio").unwrap()["enum"] =
        json!(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", null]);
    properties.get_mut("aspect_ratio").unwrap()["default"] = json!("16:9");
    properties.get_mut("reference_images").unwrap()["minItems"] = json!(1);
    properties.get_mut("reference_images").unwrap()["description"] =
        json!("Local JPEG, PNG or WebP paths. Use either these references or image_path.");
    properties.insert(
        "reference_videos".into(),
        json!({
            "type":["array","null"], "items":{"type":"string"}, "maxItems":3,
            "description":"H3 only. Local video paths, up to 3 items."
        }),
    );
    properties.insert(
        "reference_audios".into(),
        json!({
            "type":["array","null"], "items":{"type":"string"}, "maxItems":3,
            "description":"H3 only. Local audio paths, up to 3 items."
        }),
    );
    schema["not"] = json!({"required":["image_path","reference_images"],"properties":{"image_path":{"type":"string"},"reference_images":{"type":"array"}}});
    schema
}

pub(crate) fn h3_video_schema() -> Value {
    let mut schema = grok_video_schema();
    let properties = schema["properties"].as_object_mut().unwrap();
    properties.get_mut("prompt").unwrap()["maxLength"] = json!(7000);
    properties.get_mut("duration").unwrap()["minimum"] = json!(4);
    properties.get_mut("duration").unwrap()["description"] =
        json!("H3 duration in seconds, from 4 to 15. Defaults to 8.");
    properties.get_mut("aspect_ratio").unwrap()["enum"] =
        json!(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", null]);
    properties
        .get_mut("aspect_ratio")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("default");
    for field in ["resolution"] {
        properties.insert(field.into(), json!({"type":"null"}));
    }
    for (field, max) in [
        ("reference_images", 5),
        ("reference_videos", 3),
        ("reference_audios", 3),
    ] {
        properties.insert(field.into(), json!({
            "type":["array","null"], "minItems":1,"maxItems":max,
            "items":{"type":"string"},
            "description":"H3 only. HTTP(S) URLs or authorized local media paths. Local files use temporary private storage; data URLs are not supported."
        }));
    }
    schema
}

pub(crate) fn video_schema() -> Value {
    let grok = grok_video_schema();
    let h3 = h3_video_schema();
    let mut schema = grok.clone();
    schema["properties"]["aspect_ratio"]["enum"] =
        json!(["21:9", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", null]);
    schema["properties"]["resolution"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    schema["properties"]["reference_images"]["description"] =
        json!("Grok: 1 to 7 local JPEG, PNG or WebP paths. H3: 1 to 5 HTTP(S) URLs or authorized local image paths.");
    for field in ["reference_videos", "reference_audios"] {
        schema["properties"][field] = h3["properties"][field].clone();
    }
    let mut grok_properties = grok["properties"].clone();
    for field in ["reference_videos", "reference_audios"] {
        grok_properties[field] = json!({"type":"null"});
    }
    schema["allOf"] = json!([{
        "if":{"required":["model"],"properties":{"model":{"enum":["minimax-h3-768p","minimax-h3-2k"]}}},
        "then":{"properties":h3["properties"]},
        "else":{"properties":grok_properties}
    }]);
    schema
}

pub(super) fn music_schema() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(MusicInput)).unwrap();
    schema["properties"]["mode"]["enum"] = json!(["simple", "custom", null]);
    schema["properties"]["mode"]["default"] = json!("simple");
    schema["properties"]["mode"]["description"] = json!("Omit for simple mode. Custom mode requires style and title. Vocal custom mode uses prompt as lyrics.");
    schema["properties"]["vocal_gender"]["enum"] = json!(["male", "female", null]);
    for field in ["style_weight", "weirdness"] {
        schema["properties"][field]["minimum"] = json!(0);
        schema["properties"][field]["maximum"] = json!(1);
    }
    schema["allOf"] = json!([
        {
            "if":{"properties":{"mode":{"const":"custom"}},"required":["mode"]},
            "then":{
                "required":["style","title"],
                "properties":{"style":{"type":"string","minLength":1},"title":{"type":"string","minLength":1}},
                "if":{"properties":{"instrumental":{"const":true}},"required":["instrumental"]},
                "else":{"required":["prompt"],"properties":{"prompt":{"type":"string","minLength":1}}}
            },
            "else":{"required":["prompt"],"properties":{"prompt":{"type":"string","minLength":1}}}
        }
    ]);
    schema
}

pub(super) fn codex_image_route(media: &MediaConfig, model: &str) -> bool {
    url::Url::parse(&media.base_url).ok().is_some_and(|url| {
        url.host_str() == Some("oneapi.zaiwenai.com") && model.starts_with("gpt-image-")
    })
}

/// Decorate one session's schemas. Do not change the shared router: another
/// session can use a different channel and different parameter ranges.
pub fn decorate_media_specs(media: &MediaConfig, specs: &mut [ToolSpec]) {
    let snapshot = media
        .capabilities
        .as_ref()
        .and_then(|registry| registry.snapshot(&media.base_url));
    if let Some(snapshot) = &snapshot {
        snapshot.decorate_specs(specs);
    }
    for spec in specs.iter_mut() {
        let (kind, preferred) = match spec.name.as_str() {
            "generate_image" | "edit_image" => ("image", &media.image_model),
            "generate_video" => ("video", &media.video_model),
            "generate_music" => ("music", &media.music_model),
            "synthesize_speech" => ("tts", &media.tts_model),
            _ => continue,
        };
        let default = snapshot
            .as_ref()
            .and_then(|s| s.select_model(kind, preferred, None).ok())
            .unwrap_or_else(|| preferred.clone());
        spec.parameters["properties"]["model"]["default"] = json!(default);
        spec.description.push_str(&format!(
            " Default model: {default}. Omit or null model to use this default."
        ));
        if snapshot.is_none() {
            if spec.name == "generate_video" && super::video::is_h3_model(&default) {
                let condition = &mut spec.parameters["allOf"][0]["if"];
                condition.as_object_mut().unwrap().remove("required");
                condition["properties"]["model"]["enum"] =
                    json!(["minimax-h3-768p", "minimax-h3-2k", null]);
            }
            if spec.name == "synthesize_speech" && default != "grok-tts" {
                spec.parameters["allOf"][0]["if"] =
                    json!({"required":["model"],"properties":{"model":{"const":"grok-tts"}}});
            }
            continue;
        }
        let selected = spec.parameters["allOf"].as_array().and_then(|cases| {
            cases
                .iter()
                .find(|case| case["if"]["properties"]["model"]["const"] == default)
                .map(|case| case["then"].clone())
        });
        if let Some(selected) = selected {
            spec.parameters["allOf"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "if":{"properties":{"model":{"type":"null"}}},"then":selected
                }));
        }
    }
    if url::Url::parse(&media.base_url)
        .ok()
        .is_some_and(|url| url.host_str() == Some("oneapi.zaiwenai.com"))
    {
        for spec in specs
            .iter_mut()
            .filter(|spec| spec.name == "generate_image")
        {
            spec.description.push_str(" For gpt-image-* models, this channel uses Codex. Put aspect ratio and size in prompt. size and quality become prompt hints, not exact output controls. Other image models use their advertised native parameters.");
        }
    }
}

pub(super) fn validate_parameters(
    media: &MediaConfig,
    tool: &str,
    model: &str,
    values: &Value,
    baseline: &Value,
) -> Result<(), ToolError> {
    let snapshot = media
        .capabilities
        .as_ref()
        .and_then(|registry| registry.snapshot(&media.base_url));
    let Some(properties) = baseline.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };
    if tool == "generate_video" {
        let maximum = snapshot.as_ref().and_then(|snapshot| {
            snapshot
                .models
                .iter()
                .find(|candidate| candidate.id == model)
                .and_then(|candidate| candidate.max_duration)
        });
        if let (Some(maximum), Some(duration)) =
            (maximum, values.get("duration").and_then(Value::as_u64))
        {
            if duration > maximum {
                return Err(ToolError::InvalidInput(format!(
                    "duration exceeds the selected model maximum of {maximum} seconds"
                )));
            }
        }
    }
    for (field, local) in properties {
        let Some(value) = values.get(field).filter(|value| !value.is_null()) else {
            continue;
        };
        let advertised = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.parameter_schema(tool, model, field));
        let mut effective = local.clone();
        if let Some(advertised) = advertised.and_then(Value::as_object) {
            if let Some(properties) = effective.as_object_mut() {
                properties.extend(advertised.clone());
            }
        }
        validate_value(value, &effective, field)?;
    }
    Ok(())
}

fn validate_value(value: &Value, schema: &Value, field: &str) -> Result<(), ToolError> {
    let invalid = |constraint: &str| {
        ToolError::InvalidInput(format!(
            "{field} does not satisfy the channel constraint: {constraint}"
        ))
    };
    if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
        if !choices.iter().any(|choice| {
            choice == value
                || choice
                    .as_f64()
                    .zip(value.as_f64())
                    .is_some_and(|(a, b)| a == b)
        }) {
            return Err(invalid(&format!("allowed values {choices:?}")));
        }
    }
    if let Some(number) = value.as_f64() {
        if !number.is_finite() {
            return Err(invalid("finite number required"));
        }
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|min| number < min)
        {
            return Err(invalid("minimum"));
        }
        if schema
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|max| number > max)
        {
            return Err(invalid("maximum"));
        }
        if schema
            .get("exclusiveMinimum")
            .and_then(Value::as_f64)
            .is_some_and(|min| number <= min)
        {
            return Err(invalid("exclusiveMinimum"));
        }
        if schema
            .get("exclusiveMaximum")
            .and_then(Value::as_f64)
            .is_some_and(|max| number >= max)
        {
            return Err(invalid("exclusiveMaximum"));
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|min| length < min)
        {
            return Err(invalid("minLength"));
        }
        if schema
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|max| length > max)
        {
            return Err(invalid("maxLength"));
        }
    }
    if let Some(items) = value.as_array() {
        let length = items.len() as u64;
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|min| length < min)
        {
            return Err(invalid("minItems"));
        }
        if schema
            .get("maxItems")
            .and_then(Value::as_u64)
            .is_some_and(|max| length > max)
        {
            return Err(invalid("maxItems"));
        }
    }
    // anyOf is an alternative, not an intersection of all non-null branches.
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        let type_matches = |kind: &str| match kind {
            "null" => value.is_null(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            _ => true,
        };
        if !branches.iter().any(|branch| {
            let compatible = match branch.get("type") {
                Some(Value::String(kind)) => type_matches(kind),
                Some(Value::Array(kinds)) => {
                    kinds.iter().filter_map(Value::as_str).any(&type_matches)
                }
                _ => true,
            };
            compatible && validate_value(value, branch, field).is_ok()
        }) {
            return Err(invalid("anyOf"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertised_anyof_bounds_are_alternatives_and_numeric_enums_use_numeric_equality() {
        let schema = json!({"anyOf":[{"type":"number","maximum":1},{"type":"number","minimum":2},{"type":"null"}]});
        assert!(validate_value(&json!(0.5), &schema, "speed").is_ok());
        assert!(validate_value(&json!(2.5), &schema, "speed").is_ok());
        assert!(validate_value(&json!(1.5), &schema, "speed").is_err());
        assert!(validate_value(&json!("string"), &schema, "speed").is_err());
        assert!(validate_value(&json!(1.0), &json!({"enum":[1]}), "speed").is_ok());
    }
    #[test]
    fn prompt_guidance_is_scoped_to_the_confirmed_codex_channel() {
        let known = MediaConfig {
            base_url: "https://oneapi.zaiwenai.com/v1".into(),
            ..Default::default()
        };
        assert!(codex_image_route(&known, "gpt-image-2.5-flare"));
        assert!(!codex_image_route(&known, "grok-imagine-image"));
        let direct = MediaConfig {
            base_url: "https://api.openai.com/v1".into(),
            ..Default::default()
        };
        assert!(!codex_image_route(&direct, "gpt-image-2.5-flare"));
        let hinted = prompt_with_image_options(
            "Draw a cat".into(),
            Some("16:9".into()),
            Some("high".into()),
        );
        assert!(hinted.contains("16:9"));
        assert!(hinted.starts_with("Draw a cat"));
    }
    #[test]
    fn nullable_live_constraints_are_validated() {
        assert!(validate_value(
            &json!(1.2),
            &json!({"anyOf":[{"type":"number","maximum":1},{"type":"null"}]}),
            "weirdness"
        )
        .is_err());
    }
}
