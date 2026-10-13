use super::*;

pub(super) fn schema_for_tool(document: &Value, tool: &str) -> Option<Value> {
    let suffix = match tool {
        "generate_music" => "/music/generations",
        "generate_video" => "/videos/generations",
        "generate_image" => "/images/generations",
        _ => return None,
    };
    let paths = document.get("paths")?.as_object()?;
    for (path, item) in paths {
        if !path.ends_with(suffix) {
            continue;
        }
        if let Some(schema) = item.pointer("/post/requestBody/content/application~1json/schema") {
            let mut nodes = 0;
            return resolve_local_refs(document, schema, 0, &mut nodes);
        }
    }
    None
}

fn resolve_local_refs(
    root: &Value,
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Option<Value> {
    if depth > MAX_SCHEMA_DEPTH || *nodes >= MAX_SCHEMA_NODES {
        return None;
    }
    *nodes += 1;
    if let Some(reference) = value.get("$ref").and_then(Value::as_str) {
        let pointer = reference.strip_prefix("#")?;
        return resolve_local_refs(root, root.pointer(pointer)?, depth + 1, nodes);
    }
    match value {
        Value::Object(object) => Some(Value::Object(
            object
                .iter()
                .filter_map(|(key, child)| {
                    resolve_local_refs(root, child, depth + 1, nodes)
                        .map(|child| (key.clone(), child))
                })
                .collect(),
        )),
        Value::Array(array) => Some(Value::Array(
            array
                .iter()
                .filter_map(|child| resolve_local_refs(root, child, depth + 1, nodes))
                .collect(),
        )),
        _ => Some(value.clone()),
    }
}

pub(super) fn baseline_schemas() -> BTreeMap<String, Value> {
    let schemas: BTreeMap<String, Value> = [
        (
            "generate_image".to_owned(),
            crate::Tool::parameters_schema(&crate::GenerateImageTool),
        ),
        (
            "generate_video".to_owned(),
            crate::media::grok_video_schema(),
        ),
        (
            "generate_music".to_owned(),
            crate::Tool::parameters_schema(&crate::GenerateMusicTool),
        ),
    ]
    .into_iter()
    .collect();
    schemas
}

const H3_MODELS: [&str; 2] = ["minimax-h3-768p", "minimax-h3-2k"];

pub(super) fn is_h3_model_id(model: &str) -> bool {
    H3_MODELS.contains(&model)
}

/// Keep protocol-specific constraints in conditional branches.
pub(super) fn video_catalog_schema(discovered: &Value) -> Value {
    let mut schema = crate::media::video_schema();
    schema.as_object_mut().unwrap().remove("allOf");
    // This union must not narrow any channel-advertised Grok ranges.
    if let Some(properties) = discovered.get("properties").and_then(Value::as_object) {
        for (field, source) in properties {
            let target = &mut schema["properties"][field];
            if target.is_null() {
                continue;
            }
            for key in ["minimum", "maximum", "maxItems"] {
                if let Some(value) = source.get(key).and_then(Value::as_f64) {
                    let previous = target.get(key).and_then(Value::as_f64).unwrap_or(value);
                    let bound = if key == "minimum" {
                        previous.min(value)
                    } else {
                        previous.max(value)
                    };
                    target[key] = json!(bound);
                }
            }
            if let Some(values) = source.get("enum").and_then(Value::as_array) {
                if let Some(choices) = target.get_mut("enum").and_then(Value::as_array_mut) {
                    for value in values {
                        if !choices.contains(value) {
                            choices.push(value.clone());
                        }
                    }
                }
            }
        }
    }
    schema
}

/// Map native H3 field names without inheriting the generic Grok contract.
pub(super) fn normalize_channel_request_schema(channel: &Value) -> Value {
    let mut normalized = h3_video_model_schema();
    if let Some(properties) = channel.get("properties").and_then(Value::as_object) {
        for (field, property) in properties {
            let public_field = match field.as_str() {
                "seconds" => "duration",
                "ratio" => "aspect_ratio",
                other => other,
            };
            if let (Some(target), Some(property)) = (
                normalized["properties"]
                    .get_mut(public_field)
                    .and_then(Value::as_object_mut),
                property.as_object(),
            ) {
                target.extend(property.clone());
                if let Some(choices) = target.get_mut("enum").and_then(Value::as_array_mut) {
                    if !choices.contains(&Value::Null) {
                        choices.push(Value::Null);
                    }
                }
            }
        }
    }
    for field in ["resolution"] {
        normalized["properties"][field] = json!({"type":"null"});
    }
    normalized
}

pub(super) fn h3_video_model_schema() -> Value {
    crate::media::h3_video_schema()
}

pub(super) fn video_model_schema(model: &MediaModel, generic: Option<&Value>) -> Value {
    let mut schema = if is_h3_model_id(&model.id) {
        model
            .schemas
            .get("channel_request")
            .map(normalize_channel_request_schema)
            .unwrap_or_else(h3_video_model_schema)
    } else {
        let baseline = crate::media::grok_video_schema();
        generic
            .map(|schema| merge_tool_schema("generate_video", schema))
            .unwrap_or(baseline)
    };
    if let Some(properties) = model
        .schemas
        .get("generate_video")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
    {
        for (field, source) in properties {
            if let (Some(target), Some(source)) = (
                schema["properties"]
                    .get_mut(field)
                    .and_then(Value::as_object_mut),
                source.as_object(),
            ) {
                target.extend(source.clone());
            }
        }
    }
    if let Some(maximum) = model.max_duration {
        let previous = schema["properties"]["duration"]["maximum"]
            .as_u64()
            .unwrap_or(maximum);
        schema["properties"]["duration"]["maximum"] = json!(previous.min(maximum));
    }
    if is_h3_model_id(&model.id) {
        // The public tool accepts local paths. The adapter uploads them before
        // sending URL-only references to the channel. Keep channel counts.
        schema["properties"]["image_path"] =
            crate::media::h3_video_schema()["properties"]["image_path"].clone();
        for field in ["reference_images", "reference_videos", "reference_audios"] {
            if let Some(items) = schema["properties"][field]["items"].as_object_mut() {
                items.remove("pattern");
                items.remove("format");
            }
        }
    } else {
        for field in ["reference_videos", "reference_audios"] {
            schema["properties"][field] = json!({"type":"null"});
        }
    }
    schema
}

pub(super) fn constraints_from_document(tool: &str, html: &str) -> Option<Value> {
    if tool != "generate_video" {
        return None;
    }
    let mut properties = Map::new();
    let row = regex::Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").ok()?;
    let cell = regex::Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").ok()?;
    let codes = regex::Regex::new(r"(?is)<code[^>]*>(.*?)</code>").ok()?;
    let duration_range = regex::Regex::new(r"(\d+)\s*(?:至|到|[-–])\s*(\d+)").ok()?;
    let default_number = regex::Regex::new(r"默认\s*(\d+)").ok()?;
    let count = regex::Regex::new(r"最多\s*(\d+)").ok()?;
    let mut resolutions = Vec::new();
    let mut ratios = Vec::new();
    for captures in row.captures_iter(html) {
        let cells = cell
            .captures_iter(&captures[1])
            .map(|capture| capture[1].to_owned())
            .collect::<Vec<_>>();
        let Some(first) = cells.first() else {
            continue;
        };
        let name = html2text::from_read(first.as_bytes(), 500)
            .replace('`', "")
            .trim()
            .to_owned();
        let description = html2text::from_read(cells.join(" ").as_bytes(), 2000).replace('`', "");
        if name == "duration" {
            if let Some(range) = duration_range.captures(&description) {
                let minimum = range[1].parse::<u64>().ok()?;
                let maximum = range[2].parse::<u64>().ok()?;
                let mut schema = json!({"minimum":minimum,"maximum":maximum});
                if let Some(value) = default_number.captures(&description) {
                    schema["default"] = json!(value[1].parse::<u64>().ok()?);
                }
                properties.insert("duration".into(), schema);
            }
        }
        if name == "reference_images" {
            if let Some(value) = count.captures(&description) {
                properties.insert(
                    name.clone(),
                    json!({"maxItems":value[1].parse::<u64>().ok()?}),
                );
            }
        }
        // Read enumerated values from their own table rows, not examples or navigation text.
        if name.ends_with('p') && name.trim_end_matches('p').parse::<u64>().is_ok() {
            resolutions.push(Value::String(name.clone()));
        }
        if name
            .split_once(':')
            .is_some_and(|(w, h)| w.parse::<u64>().is_ok() && h.parse::<u64>().is_ok())
        {
            ratios.push(Value::String(name.clone()));
        }
        if name == "resolution" || name == "aspect_ratio" {
            let allowed = codes
                .captures_iter(&cells.join(" "))
                .skip(1)
                .map(|capture| {
                    html2text::from_read(capture[1].as_bytes(), 500)
                        .trim()
                        .to_owned()
                })
                .collect::<Vec<_>>();
            let allowed = allowed
                .into_iter()
                .filter(|value| {
                    if name == "resolution" {
                        value.ends_with('p')
                    } else {
                        value.contains(':')
                    }
                })
                .map(Value::String)
                .collect::<Vec<_>>();
            if !allowed.is_empty() {
                properties.insert(name.clone(), json!({"enum":allowed}));
            }
        }
    }
    if !resolutions.is_empty() {
        properties.insert("resolution".into(), json!({"enum":resolutions}));
    }
    if !ratios.is_empty() {
        properties.insert("aspect_ratio".into(), json!({"enum":ratios}));
    }
    if properties.is_empty() {
        return None;
    }
    Some(json!({"type":"object","properties":properties}))
}

/// Scope tables to their POST route. A page can describe multiple protocols.
pub(super) fn generation_sections(html: &str) -> Vec<(String, String)> {
    let headings = regex::Regex::new(r"(?is)<h2\b[^>]*>").unwrap();
    let starts = headings
        .find_iter(html)
        .map(|item| item.start())
        .collect::<Vec<_>>();
    let endpoint =
        regex::Regex::new(r"POST\s+(?:https?://[^/\s`]+)?(/v1/[a-z0-9/_-]+/generations)").unwrap();
    let mut sections = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(html.len());
        let section = &html[*start..end];
        let text = html2text::from_read(section.as_bytes(), 2000).replace('`', "");
        if let Some(route) = endpoint.captures(&text) {
            sections.push((route[1].to_owned(), section.to_owned()));
        }
    }
    sections
}

pub(super) fn merge_tool_schema(tool: &str, discovered: &Value) -> Value {
    let mut merged = baseline_schemas()
        .remove(tool)
        .unwrap_or_else(|| json!({"type":"object", "properties":{}}));
    let Some(discovered_properties) = discovered.get("properties").and_then(Value::as_object)
    else {
        return normalize_tool_schema(tool, &merged);
    };
    for field in tool_fields(tool) {
        if let Some(discovered_property) = discovered_properties.get(field) {
            let local = merged
                .get_mut("properties")
                .and_then(Value::as_object_mut)
                .and_then(|properties| properties.get_mut(field));
            if let Some(local) = local {
                if let (Some(local), Some(discovered)) =
                    (local.as_object_mut(), discovered_property.as_object())
                {
                    local.extend(discovered.clone());
                }
            } else {
                merged["properties"][field] = discovered_property.clone();
            }
        }
    }
    normalize_tool_schema(tool, &merged)
}

pub(crate) fn normalize_tool_schema(tool: &str, schema: &Value) -> Value {
    let allowed = tool_fields(tool);
    let mut output = schema.as_object().cloned().unwrap_or_default();
    output.insert("type".into(), json!("object"));
    output.insert("additionalProperties".into(), json!(false));
    let properties = schema.get("properties").and_then(Value::as_object);
    let mut normalized = Map::new();
    for field in &allowed {
        if let Some(property) = properties.and_then(|properties| properties.get(*field)) {
            normalized.insert((*field).to_owned(), normalize_property(field, property));
        }
    }
    output.insert("properties".into(), Value::Object(normalized));
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        output.insert(
            "required".into(),
            Value::Array(
                required
                    .iter()
                    .filter(|field| field.as_str().is_some_and(|field| allowed.contains(&field)))
                    .cloned()
                    .collect(),
            ),
        );
    }
    Value::Object(output)
}

fn normalize_property(field: &str, property: &Value) -> Value {
    let mut property = property.as_object().cloned().unwrap_or_default();
    // Pydantic places nullable bounds inside anyOf. Lift the actual bounds so
    // they replace the previous snapshot's bounds instead of intersecting them.
    if let Some(branches) = property.get("anyOf").and_then(Value::as_array).cloned() {
        for branch in branches
            .iter()
            .filter(|branch| branch.get("type").and_then(Value::as_str) != Some("null"))
        {
            for key in [
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "minLength",
                "maxLength",
                "minItems",
                "maxItems",
                "enum",
            ] {
                if let Some(value) = branch.get(key) {
                    property.insert(key.into(), value.clone());
                }
            }
        }
    }
    if field != "prompt" && field != "instrumental" {
        if let Some(kind) = property
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            property.insert("type".into(), json!([kind, "null"]));
        }
        if let Some(values) = property.get_mut("enum").and_then(Value::as_array_mut) {
            if !values.contains(&Value::Null) {
                values.push(Value::Null);
            }
        }
    }
    if field == "reference_images" {
        property.insert("type".into(), json!(["array", "null"]));
        property.insert("items".into(), json!({"type":"string"}));
    }
    Value::Object(property)
}

fn tool_fields(tool: &str) -> Vec<&'static str> {
    match tool {
        "generate_image" => vec!["prompt", "model", "size", "quality"],
        "edit_image" => vec!["prompt", "model", "image_path"],
        "generate_video" => vec![
            "prompt",
            "model",
            "duration",
            "resolution",
            "aspect_ratio",
            "image_path",
            "reference_images",
            "reference_videos",
            "reference_audios",
        ],
        "generate_music" => vec![
            "prompt",
            "model",
            "mode",
            "instrumental",
            "style",
            "title",
            "negative_style",
            "vocal_gender",
            "style_weight",
            "weirdness",
        ],
        "synthesize_speech" => vec!["input", "model", "voice", "response_format"],
        "transcribe_audio" => vec!["path", "model", "language"],
        _ => Vec::new(),
    }
}

pub(super) fn tool_kind(tool: &str) -> Option<&'static str> {
    match tool {
        "generate_image" | "edit_image" => Some("image"),
        "generate_video" => Some("video"),
        "generate_music" => Some("music"),
        "synthesize_speech" => Some("tts"),
        "transcribe_audio" => Some("stt"),
        _ => None,
    }
}

pub(super) fn supports_tool(model: &MediaModel, tool: &str) -> bool {
    if is_dedicated_route(model) {
        return false;
    }
    model
        .metadata
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .any(|tool_name| tool_name.as_str() == Some(tool))
        })
        .unwrap_or(true)
}

pub(super) fn is_dedicated_route(model: &MediaModel) -> bool {
    if model.id.eq_ignore_ascii_case("midjourney") {
        return true;
    }
    // Only the two documented H3 IDs are executable. Their std route is
    // handled by the video adapter; an absent route means the channel did not
    // publish a conflicting dedicated endpoint.
    if is_h3_model_id(&model.id) {
        return model
            .route
            .as_deref()
            .is_some_and(|route| !route.ends_with("/videos/std/generations"));
    }
    let suffix = match model.kind.as_str() {
        "image" => "/images/generations",
        "video" => "/videos/generations",
        "music" => "/music/generations",
        _ => return false,
    };
    model
        .route
        .as_deref()
        .is_some_and(|route| !route.ends_with(suffix))
}
