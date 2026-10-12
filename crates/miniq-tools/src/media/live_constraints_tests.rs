use super::*;
use std::sync::Arc;

fn context(snapshot: Value, directory: &tempfile::TempDir) -> ToolContext {
    std::fs::write(
        directory.path().join("snapshot.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    let registry = Arc::new(crate::MediaCapabilityRegistry::new(Some(
        directory.path().to_path_buf(),
    )));
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url: "http://127.0.0.1:9/v1".into(),
        api_key: "fixture-key".into(),
        video_model: "video-short".into(),
        music_model: "music-current".into(),
        capabilities: Some(registry),
        ..Default::default()
    });
    ctx
}

fn snapshot() -> Value {
    json!({
        "baseUrl":"http://127.0.0.1:9/v1", "fetchedAt":chrono_like_timestamp(),
        "models":[
            {"id":"video-short","kind":"video","maxDuration":3,
             "schemas":{"generate_video":{"properties":{"duration":{"maximum":3}}}}},
            {"id":"video-long","kind":"video","maxDuration":15,
             "schemas":{"generate_video":{"properties":{"duration":{"maximum":15}}}}},
            {"id":"music-current","kind":"music","maxDuration":null}
        ],
        "schemas":{"generate_music":{"properties":{"style_weight":{"anyOf":[{"type":"number","minimum":0,"maximum":0.5},{"type":"null"}]}}}},
        "sources":[],"partial":false
    })
}

fn h3_snapshot() -> Value {
    json!({
        "baseUrl":"http://127.0.0.1:9/v1", "fetchedAt":chrono_like_timestamp(),
        "models":[
            {"id":"grok-imagine-video-1.5","kind":"video","maxDuration":15,"route":"/v1/videos/generations"},
            {"id":"minimax-h3-768p","kind":"video","maxDuration":10,"route":"/v1/videos/std/generations",
             "schemas":{"channel_request":{"properties":{
                 "seconds":{"minimum":5,"maximum":10},
                 "ratio":{"enum":["21:9","16:9"]},
                 "reference_images":{"maxItems":2}
             }}}}
        ],
        "schemas":{"generate_video":{"properties":{
            "duration":{"minimum":1,"maximum":15},
            "aspect_ratio":{"enum":["16:9","9:16"]},
            "reference_images":{"maxItems":7}
        }}}, "sources":[],"partial":false
    })
}

#[tokio::test]
async fn h3_uses_refreshed_native_limits_without_inheriting_grok_constraints() {
    let directory = tempfile::tempdir().unwrap();
    let ctx = context(h3_snapshot(), &directory);
    let media = ctx.media.as_ref().unwrap();
    assert!(validate_parameters(
        media,
        "generate_video",
        "minimax-h3-768p",
        &json!({"duration":5,"aspect_ratio":"21:9"}),
        &h3_video_schema()
    )
    .is_ok());
    for input in [
        json!({"duration":4}),
        json!({"duration":11}),
        json!({"aspect_ratio":"9:16"}),
        json!({"reference_images":vec!["https://media.test/frame.png";3]}),
    ] {
        let mut raw = json!({"prompt":"fixture","model":"minimax-h3-768p"});
        raw.as_object_mut()
            .unwrap()
            .extend(input.as_object().unwrap().clone());
        assert!(matches!(
            GenerateVideoTool.execute(&ctx, raw).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    assert!(validate_parameters(
        media,
        "generate_video",
        "grok-imagine-video-1.5",
        &json!({"duration":1,"aspect_ratio":"9:16","reference_images":vec!["frame.png";7]}),
        &grok_video_schema()
    )
    .is_ok());
}

#[test]
fn h3_catalog_maps_refreshed_native_limits_to_public_fields() {
    let directory = tempfile::tempdir().unwrap();
    let ctx = context(h3_snapshot(), &directory);
    let mut specs = vec![GenerateVideoTool.spec()];
    decorate_media_specs(ctx.media.as_ref().unwrap(), &mut specs);
    let schema = &specs[0].parameters;
    let condition = schema["allOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["if"]["properties"]["model"]["const"] == "minimax-h3-768p")
        .unwrap();
    let properties = &condition["then"]["properties"];
    assert_eq!(properties["duration"]["minimum"], 5);
    assert_eq!(properties["duration"]["maximum"], 10);
    assert_eq!(
        properties["aspect_ratio"]["enum"],
        json!(["21:9", "16:9", null])
    );
    assert_eq!(properties["reference_images"]["maxItems"], 2);
    assert!(properties.get("seconds").is_none());
    assert!(schema["properties"]["aspect_ratio"]["enum"]
        .as_array()
        .unwrap()
        .contains(&json!("21:9")));
}

#[tokio::test]
async fn refreshed_ranges_are_checked_for_the_selected_model_before_generation() {
    let directory = tempfile::tempdir().unwrap();
    let ctx = context(snapshot(), &directory);
    let error = GenerateVideoTool
        .execute(
            &ctx,
            json!({"prompt":"animate", "model":"video-short","duration":4}),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::InvalidInput(_)));
    let error = GenerateMusicTool
        .execute(&ctx, json!({"prompt":"piano", "style_weight":0.6}))
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::InvalidInput(_)));
    let media = ctx.media.as_ref().unwrap();
    assert!(validate_parameters(
        media,
        "generate_video",
        "video-long",
        &json!({"duration":4}),
        &video_schema()
    )
    .is_ok());
    assert!(validate_parameters(
        media,
        "generate_video",
        "video-short",
        &json!({"duration":0}),
        &video_schema()
    )
    .is_err());
}

#[tokio::test]
async fn an_explicit_retired_model_is_not_replaced_by_a_paid_generation() {
    let directory = tempfile::tempdir().unwrap();
    let ctx = context(snapshot(), &directory);
    let error = GenerateMusicTool
        .execute(&ctx, json!({"prompt":"piano", "model":"suno-v5"}))
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::InvalidInput(_)));
    assert!(error.to_string().contains("unavailable"));
}

#[test]
fn tool_catalog_keeps_conditions_and_refreshed_enums_together() {
    let directory = tempfile::tempdir().unwrap();
    let ctx = context(snapshot(), &directory);
    let mut specs = vec![GenerateMusicTool.spec(), GenerateVideoTool.spec()];
    decorate_media_specs(ctx.media.as_ref().unwrap(), &mut specs);
    let music = &specs[0].parameters;
    assert!(music.get("allOf").is_some());
    assert!(music["properties"]["model"]["enum"]
        .as_array()
        .unwrap()
        .contains(&Value::Null));
    assert!(music["properties"]["style_weight"]
        .to_string()
        .contains("0.5"));
}

#[test]
fn image_validation_checks_the_final_prompt_after_compatibility_hints() {
    let directory = tempfile::tempdir().unwrap();
    let data = json!({
        "baseUrl":"https://oneapi.zaiwenai.com/v1", "fetchedAt":chrono_like_timestamp(),
        "models":[{"id":"gpt-image-2.5-flare","kind":"image","maxDuration":null}],
        "schemas":{"generate_image":{"properties":{"prompt":{"maxLength":12}}}},
        "partial":false
    });
    std::fs::write(
        directory.path().join("snapshot.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
    let registry = Arc::new(crate::MediaCapabilityRegistry::new(Some(
        directory.path().to_path_buf(),
    )));
    let media = MediaConfig {
        base_url: "https://oneapi.zaiwenai.com/v1".into(),
        api_key: "fixture-key".into(),
        image_model: "gpt-image-2.5-flare".into(),
        capabilities: Some(registry),
        ..Default::default()
    };
    let input: ImageInput = parse_input(json!({"prompt":"cat","size":"16:9"})).unwrap();
    let body = image_request_body(&media, media.image_model.clone(), input);
    assert!(validate_parameters(
        &media,
        "generate_image",
        &media.image_model,
        &body,
        &image_schema()
    )
    .is_err());
}

#[tokio::test]
async fn image_execution_rejects_a_live_prompt_limit_before_http() {
    let directory = tempfile::tempdir().unwrap();
    let mut data = snapshot();
    data["models"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"image-current","kind":"image","maxDuration":null}));
    data["schemas"]["generate_image"] = json!({"properties":{"prompt":{"maxLength":3}}});
    let ctx = context(data, &directory);
    let error = GenerateImageTool
        .execute(&ctx, json!({"model":"image-current","prompt":"long"}))
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::InvalidInput(_)));
    assert!(error.to_string().contains("maxLength"));
}
