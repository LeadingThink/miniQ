use super::*;

pub(super) async fn fetch_snapshot(
    media: &crate::MediaConfig,
    base_url: &str,
) -> Result<MediaCapabilitySnapshot, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("http client error: {error}"))?;
    let fetched_at = now_secs();
    let mut sources = Vec::new();
    let mut partial = false;
    let mut models = Vec::new();
    let mut details_unsupported = true;
    let mut details_errors = Vec::new();
    for kind in ["image", "video", "audio_gen"] {
        match fetch_details(&client, media, base_url, kind).await {
            Ok((rows, source_partial)) => {
                details_unsupported = false;
                partial |= source_partial;
                models.extend(rows);
                sources.push(MediaCapabilitySource {
                    url: endpoint_url(base_url, "models/details"),
                    fetched_at,
                    partial: source_partial,
                });
            }
            Err(error) if error.unsupported => {
                partial = true;
                details_errors.push(error.message);
            }
            Err(error) => return Err(error.message),
        }
    }
    if details_unsupported || !details_errors.is_empty() {
        match fetch_generic_models(&client, media, base_url).await {
            Ok(rows) => {
                models.extend(rows);
                partial = true;
                sources.push(MediaCapabilitySource {
                    url: endpoint_url(base_url, "models"),
                    fetched_at,
                    partial: true,
                });
            }
            Err(error) => {
                return Err(format!(
                    "{}; details fallback: {}",
                    error.message,
                    details_errors.join("; ")
                ))
            }
        }
    }
    dedup_models(&mut models);

    let mut schemas = baseline_schemas();
    let mut openapi_fields: HashMap<String, HashSet<String>> = HashMap::new();
    match fetch_openapi(&client, media, base_url).await {
        Ok((openapi_url, document)) => {
            sources.push(MediaCapabilitySource {
                url: openapi_url,
                fetched_at,
                partial: false,
            });
            for tool in ["generate_image", "generate_video", "generate_music"] {
                if let Some(schema) = schema_for_tool(&document, tool) {
                    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                        openapi_fields
                            .insert(tool.to_owned(), properties.keys().cloned().collect());
                    }
                    schemas.insert(tool.to_owned(), merge_tool_schema(tool, &schema));
                }
            }
        }
        Err(error) if error.unsupported => partial = true,
        Err(error) => return Err(error.message),
    }
    if is_known_zaiwen_host(base_url)? {
        for (tool, path) in [
            ("generate_image", "docs/guide/api-images"),
            ("generate_video", "docs/guide/api-videos"),
            ("generate_music", "docs/guide/api-music"),
        ] {
            match fetch_documentation(&client, media, base_url, path).await {
                Ok((url, html)) => {
                    sources.push(MediaCapabilitySource {
                        url,
                        fetched_at,
                        partial: true,
                    });
                    let scoped = if tool == "generate_video" {
                        let sections = generation_sections(&html);
                        for (route, section) in &sections {
                            for model in models.iter_mut().filter(|model| model.kind == "video") {
                                if section.contains(&model.id) {
                                    model.route = Some(route.clone());
                                    if let Some(schema) =
                                        provider_document::parameter_table(section)
                                    {
                                        let schema = if is_h3_model_id(&model.id) {
                                            normalize_channel_request_schema(&schema)
                                        } else {
                                            normalize_tool_schema("generate_video", &schema)
                                        };
                                        model.schemas.insert("generate_video".into(), schema);
                                    }
                                }
                            }
                        }
                        sections
                            .into_iter()
                            .find(|(route, _)| route.ends_with("/videos/generations"))
                            .map(|(_, section)| section)
                            .unwrap_or_default()
                    } else {
                        html
                    };
                    if let Some(schema) = constraints_from_document(tool, &scoped) {
                        let mut constraints = schema;
                        if let Some(properties) = constraints
                            .get_mut("properties")
                            .and_then(Value::as_object_mut)
                        {
                            if let Some(fields) = openapi_fields.get(tool) {
                                properties.retain(|field, _| !fields.contains(field));
                            }
                        }
                        let mut existing = schemas
                            .remove(tool)
                            .unwrap_or_else(|| json!({"type":"object", "properties":{}}));
                        if let Some(properties) =
                            constraints.get("properties").and_then(Value::as_object)
                        {
                            for (field, discovered) in properties {
                                if let Some(property) =
                                    existing["properties"][field].as_object_mut()
                                {
                                    if let Some(discovered) = discovered.as_object() {
                                        property.extend(discovered.clone());
                                    }
                                }
                            }
                        }
                        schemas.insert(tool.to_owned(), normalize_tool_schema(tool, &existing));
                    }
                }
                Err(error) if error.unsupported => partial = true,
                Err(error) => return Err(error.message),
            }
        }
    }
    // H3 may be listed by the model directory without a documentation route.
    // Its public contract is still known, while a non-standard explicit route
    // remains blocked by is_dedicated_route.
    for model in models
        .iter_mut()
        .filter(|model| model.kind == "video" && is_h3_model_id(&model.id))
    {
        let mut schema = model
            .schemas
            .remove("generate_video")
            .map(|schema| normalize_channel_request_schema(&schema))
            .unwrap_or_else(h3_video_model_schema);
        if let Some(maximum) = model.max_duration {
            let documented = schema["properties"]["duration"]["maximum"]
                .as_u64()
                .unwrap_or(maximum);
            schema["properties"]["duration"]["maximum"] = json!(documented.min(maximum));
        }
        model.schemas.insert("generate_video".into(), schema);
    }
    // Complete sparse per-model overrides using the same channel fields.
    // A model's maximum must not discard a newly advertised minimum.
    for model in &mut models {
        for (tool, overrides) in &mut model.schemas {
            if is_h3_model_id(&model.id) && tool == "generate_video" {
                continue;
            }
            if let Some(base) = schemas.get(tool) {
                let mut effective = base.clone();
                if let Some(properties) = overrides.get("properties").and_then(Value::as_object) {
                    for (field, constraints) in properties {
                        if let (Some(target), Some(constraints)) = (
                            effective["properties"][field].as_object_mut(),
                            constraints.as_object(),
                        ) {
                            target.extend(constraints.clone());
                        }
                    }
                }
                *overrides = normalize_tool_schema(tool, &effective);
            }
        }
    }
    Ok(MediaCapabilitySnapshot {
        base_url: base_url.to_owned(),
        fetched_at,
        models,
        schemas,
        sources,
        partial,
    })
}

#[derive(Debug)]
pub(super) struct FetchError {
    pub(super) message: String,
    pub(super) unsupported: bool,
}

async fn fetch_details(
    client: &Client,
    media: &crate::MediaConfig,
    base_url: &str,
    kind: &str,
) -> Result<(Vec<MediaModel>, bool), FetchError> {
    let mut output = Vec::new();
    let mut page = 1usize;
    let mut total = None;
    loop {
        let mut url =
            Url::parse(&endpoint_url(base_url, "models/details")).map_err(|error| FetchError {
                message: error.to_string(),
                unsupported: false,
            })?;
        url.query_pairs_mut()
            .append_pair("model_type", kind)
            .append_pair("page_size", &PAGE_SIZE.to_string())
            .append_pair("page", &page.to_string());
        let response = send_json(client, media, url.as_str()).await?;
        if response.status == StatusCode::NOT_FOUND
            || response.status == StatusCode::METHOD_NOT_ALLOWED
        {
            return Err(FetchError {
                message: format!(
                    "status={} code=-1 endpoint=/models/details",
                    response.status.as_u16()
                ),
                unsupported: true,
            });
        }
        if !response.status.is_success() {
            return Err(FetchError {
                message: format!(
                    "status={} code=-1 endpoint=/models/details",
                    response.status.as_u16()
                ),
                unsupported: false,
            });
        }
        if response.body.get("error").is_some() || !has_model_container(&response.body) {
            return Err(FetchError {
                message: format!(
                    "status={} code=-1 malformed model response",
                    response.status.as_u16()
                ),
                unsupported: false,
            });
        }
        let rows = model_rows(&response.body);
        total = total.or_else(|| {
            response
                .body
                .pointer("/data/total")
                .and_then(Value::as_u64)
                .or_else(|| response.body.get("total").and_then(Value::as_u64))
                .map(|value| value as usize)
        });
        output.extend(rows.into_iter().filter_map(|row| model_from_row(row, kind)));
        let received = model_rows(&response.body).len();
        if received == 0 && total.is_some_and(|total| output.len() < total) {
            return Err(FetchError {
                message: "status=200 code=-1 partial model pagination".into(),
                unsupported: false,
            });
        }
        let complete = total
            .map(|total| output.len() >= total)
            .unwrap_or(received < PAGE_SIZE || received == 0);
        if complete {
            break;
        }
        page = page.saturating_add(1);
        if page > 10_000 {
            return Err(FetchError {
                message: "status=200 code=-1 pagination limit exceeded".into(),
                unsupported: false,
            });
        }
    }
    Ok((output, false))
}

async fn fetch_generic_models(
    client: &Client,
    media: &crate::MediaConfig,
    base_url: &str,
) -> Result<Vec<MediaModel>, FetchError> {
    let url = endpoint_url(base_url, "models");
    let response = send_json(client, media, &url).await?;
    if !response.status.is_success() {
        return Err(FetchError {
            message: format!(
                "status={} code=-1 endpoint=/models",
                response.status.as_u16()
            ),
            unsupported: false,
        });
    }
    if response.body.get("error").is_some() || !has_model_container(&response.body) {
        return Err(FetchError {
            message: format!(
                "status={} code=-1 malformed model response",
                response.status.as_u16()
            ),
            unsupported: false,
        });
    }
    Ok(model_rows(&response.body)
        .into_iter()
        .filter_map(|row| {
            let kind = row
                .get("model_type")
                .and_then(Value::as_str)
                .or_else(|| row.get("kind").and_then(Value::as_str))
                .unwrap_or("unknown");
            model_from_row(row, kind)
        })
        .collect())
}

fn has_model_container(value: &Value) -> bool {
    value.pointer("/data/models").is_some_and(Value::is_array)
        || value.get("models").is_some_and(Value::is_array)
        || value.get("data").is_some_and(Value::is_array)
}

fn model_rows(value: &Value) -> Vec<&Map<String, Value>> {
    value
        .pointer("/data/models")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.get("data").and_then(Value::as_array))
        .map(|rows| rows.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn model_from_row(row: &Map<String, Value>, expected_kind: &str) -> Option<MediaModel> {
    let id = row
        .get("model_id")
        .and_then(Value::as_str)
        .or_else(|| row.get("id").and_then(Value::as_str))
        .or_else(|| row.get("name").and_then(Value::as_str))?
        .trim();
    if id.is_empty() {
        return None;
    }
    let kind = row
        .get("model_type")
        .and_then(Value::as_str)
        .or_else(|| row.get("kind").and_then(Value::as_str))
        .unwrap_or(expected_kind);
    let kind = canonical_kind(kind).to_owned();
    let max_duration = row
        .get("max_duration")
        .and_then(Value::as_u64)
        .or_else(|| {
            row.get("metadata")
                .and_then(|metadata| metadata.get("max_duration"))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            row.get("limits")
                .and_then(|limits| limits.get("max_duration"))
                .and_then(Value::as_u64)
        });
    let route = row
        .get("route")
        .and_then(Value::as_str)
        .or_else(|| row.get("endpoint").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    let metadata: BTreeMap<String, Value> = row
        .get("metadata")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| matches!(key.as_str(), "tools" | "max_duration"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut schemas: BTreeMap<String, Value> = row
        .get("schemas")
        .or_else(|| row.get("parameter_schemas"))
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(tool, schema)| {
                    tool_kind(tool).map(|_| (tool.clone(), normalize_tool_schema(tool, schema)))
                })
                .collect()
        })
        .unwrap_or_default();
    if kind == "video" {
        if let Some(max_duration) = max_duration {
            let schema = schemas
                .entry("generate_video".into())
                .or_insert_with(|| json!({"type":"object", "properties":{"duration":{}}}));
            schema["properties"]["duration"]["maximum"] = json!(max_duration);
        }
    }
    Some(MediaModel {
        id: id.to_owned(),
        kind,
        max_duration,
        route,
        metadata,
        schemas,
    })
}

fn dedup_models(models: &mut Vec<MediaModel>) {
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert((model.id.clone(), model.kind.clone())));
    models.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.id.cmp(&right.id)));
}

pub(super) fn canonical_kind(kind: &str) -> &str {
    match kind {
        "audio_gen" | "music" => "music",
        "text_to_speech" | "tts" => "tts",
        "speech_to_text" | "stt" | "transcription" => "stt",
        other => other,
    }
}

async fn fetch_openapi(
    client: &Client,
    media: &crate::MediaConfig,
    base_url: &str,
) -> Result<(String, Value), FetchError> {
    let url = root_endpoint_url(base_url, "openapi.json");
    let response = send_json(client, media, &url).await?;
    if response.status == StatusCode::NOT_FOUND || response.status == StatusCode::METHOD_NOT_ALLOWED
    {
        return Err(FetchError {
            message: format!(
                "status={} code=-1 endpoint=/openapi.json",
                response.status.as_u16()
            ),
            unsupported: true,
        });
    }
    if !response.status.is_success() {
        return Err(FetchError {
            message: format!(
                "status={} code=-1 endpoint=/openapi.json",
                response.status.as_u16()
            ),
            unsupported: false,
        });
    }
    Ok((url, response.body))
}

async fn fetch_documentation(
    client: &Client,
    media: &crate::MediaConfig,
    base_url: &str,
    path: &str,
) -> Result<(String, String), FetchError> {
    let url = root_endpoint_url(base_url, path);
    let response = send_text(client, media, &url).await?;
    if response.0 == StatusCode::NOT_FOUND || response.0 == StatusCode::METHOD_NOT_ALLOWED {
        return Err(FetchError {
            message: format!("status={} code=-1 endpoint=/{path}", response.0.as_u16()),
            unsupported: true,
        });
    }
    if !response.0.is_success() {
        return Err(FetchError {
            message: format!("status={} code=-1 endpoint=/{path}", response.0.as_u16()),
            unsupported: false,
        });
    }
    Ok((url, response.1))
}
