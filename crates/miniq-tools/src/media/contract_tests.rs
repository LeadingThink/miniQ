use super::*;
use axum::{http::Uri, routing::any, Json, Router};
use tokio::sync::mpsc;

struct Fixture {
    directory: tempfile::TempDir,
    ctx: ToolContext,
    requests: mpsc::UnboundedReceiver<String>,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let (sender, requests) = mpsc::unbounded_channel();
        let app = Router::new().fallback(any(move |uri: Uri| {
            let sender = sender.clone();
            async move {
                sender.send(uri.to_string()).unwrap();
                Json(json!({"id":"fixture-task", "data":[{"url":"https://media.test/image.png"}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let mut ctx = ToolContext::new(directory.path().to_path_buf());
        ctx.media = Some(MediaConfig {
            base_url: format!("http://{address}/v1"),
            api_key: "test-key".into(),
            image_model: "configured-image".into(),
            video_model: "configured-video".into(),
            music_model: "configured-music".into(),
            capabilities: None,
            ..Default::default()
        });
        std::fs::write(directory.path().join("frame.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(directory.path().join("notes.txt"), b"not an image").unwrap();
        std::fs::write(directory.path().join("animation.gif"), b"GIF89a").unwrap();
        Self {
            directory,
            ctx,
            requests,
            server,
        }
    }

    async fn rejects_before_http(&mut self, tool: &dyn Tool, input: Value) {
        let result = tool.execute(&self.ctx, input.clone()).await;
        assert!(
            matches!(result, Err(ToolError::InvalidInput(_))),
            "{} must reject {input} as invalid input, got {result:?}",
            tool.name()
        );
        assert!(
            self.requests.try_recv().is_err(),
            "{} made an HTTP request for invalid input {input}",
            tool.name()
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[test]
fn confirmed_zaiwen_gpt_image_options_become_prompt_guidance_without_wire_fields() {
    let media = MediaConfig {
        base_url: "https://oneapi.zaiwenai.com/v1".into(),
        capabilities: None,
        ..Default::default()
    };
    let prompt = "海报：中文，保留完整内容。";
    let input = parse_input(json!({"prompt":prompt, "size":"16:9", "quality":"high"})).unwrap();
    let body = super::image_request_body(&media, "gpt-image-2.5-flare".into(), input);
    assert_eq!(
        body,
        json!({"model":"gpt-image-2.5-flare",
            "prompt":format!("{prompt}\n构图和画幅要求：16:9。 视觉质量要求：high细节。")})
    );
    let input = parse_input(json!({"prompt":prompt})).unwrap();
    assert_eq!(
        super::image_request_body(&media, "gpt-image-2.5-flare".into(), input),
        json!({"model":"gpt-image-2.5-flare", "prompt":prompt})
    );
}

#[tokio::test]
async fn video_invalid_scalar_options_are_rejected_before_http() {
    let mut fixture = Fixture::new().await;
    let cases = [
        json!({"duration":0}),
        json!({"duration":16}),
        json!({"duration":-1}),
        json!({"duration":1.5}),
        json!({"duration":"8"}),
        json!({"resolution":"1080p"}),
        json!({"resolution":"720"}),
        json!({"resolution":720}),
        json!({"aspect_ratio":"21:9"}),
        json!({"aspect_ratio":""}),
        json!({"aspect_ratio":1}),
    ];
    for options in cases {
        let mut input = json!({"prompt":"fixture"});
        input
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        fixture.rejects_before_http(&GenerateVideoTool, input).await;
    }
}

#[tokio::test]
async fn video_reference_count_exclusivity_and_mime_are_validated_before_http() {
    let mut fixture = Fixture::new().await;
    let cases = [
        json!({"reference_images":[]}),
        json!({"reference_images":vec!["frame.png"; 8]}),
        json!({"reference_images":"frame.png"}),
        json!({"reference_images":["frame.png", 7]}),
        json!({"image_path":"frame.png", "reference_images":["frame.png"]}),
        json!({"image_path":"frame.png", "reference_images":[]}),
        json!({"reference_images":["notes.txt"]}),
        json!({"reference_images":["frame.png", "notes.txt"]}),
        json!({"reference_images":["animation.gif"]}),
        json!({"image_path":"animation.gif"}),
    ];
    for options in cases {
        let mut input = json!({"prompt":"fixture"});
        input
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        fixture.rejects_before_http(&GenerateVideoTool, input).await;
    }
}

#[tokio::test]
async fn h3_submission_uses_the_std_endpoint_and_h3_parameter_rules() {
    let mut fixture = Fixture::new().await;
    let result = GenerateVideoTool
        .execute(
            &fixture.ctx,
            json!({
                "model":"minimax-h3-768p",
                "prompt":"fixture",
                "duration":4,
                "aspect_ratio":"21:9",
                "reference_images":["https://media.test/frame.png"],
                "reference_videos":["https://media.test/reference.mp4"],
                "reference_audios":["https://media.test/reference.mp3"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["protocol"], "minimax-h3");
    assert_eq!(
        fixture.requests.recv().await.unwrap(),
        "/v1/videos/std/generations"
    );
    fixture
        .rejects_before_http(
            &GenerateVideoTool,
            json!({"model":"minimax-h3-768p", "prompt":"fixture", "duration":3}),
        )
        .await;
    fixture.rejects_before_http(
        &GenerateVideoTool,
        json!({"model":"minimax-h3-768p", "prompt":"fixture", "reference_images":vec!["frame.png"; 6]}),
    ).await;
}

#[tokio::test]
async fn h3_invalid_options_and_unsupported_local_references_fail_before_http() {
    let mut fixture = Fixture::new().await;
    for options in [
        json!({"model":"minimax-h3-unsupported"}),
        json!({"duration":3}),
        json!({"duration":16}),
        json!({"duration":4.5}),
        json!({"aspect_ratio":"3:2"}),
        json!({"aspect_ratio":"2:3"}),
        json!({"resolution":"720p"}),
        json!({"prompt":"x".repeat(7001)}),
        json!({"reference_images":[]}),
        json!({"reference_images":vec!["https://media.test/frame.png";6]}),
        json!({"reference_videos":vec!["https://media.test/clip.mp4";4]}),
        json!({"reference_audios":vec!["https://media.test/audio.mp3";4]}),
        json!({"reference_images":["data:image/png;base64,aaaa"]}),
        json!({"reference_videos":["ftp://media.test/clip.mp4"]}),
        json!({"reference_audios":["https://user:secret@media.test/audio.mp3"]}),
        json!({"reference_images":["https://"]}),
        json!({"reference_images":[1]}),
    ] {
        let mut input = json!({"prompt":"fixture", "model":"minimax-h3-768p"});
        input
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        fixture.rejects_before_http(&GenerateVideoTool, input).await;
    }
    for field in ["reference_images", "reference_videos", "reference_audios"] {
        let input =
            json!({"prompt":"fixture", "model":"minimax-h3-768p", (field):["../private.png"]});
        assert_eq!(
            GenerateVideoTool.evaluate_risk(&fixture.ctx, &input).level,
            RiskLevel::Blocked
        );
        assert!(matches!(
            GenerateVideoTool.execute(&fixture.ctx, input).await,
            Err(ToolError::SandboxDenied(_))
        ));
        assert!(fixture.requests.try_recv().is_err());
    }
    for field in ["reference_videos", "reference_audios"] {
        fixture
            .rejects_before_http(
                &GenerateVideoTool,
                json!({"prompt":"fixture", (field):["https://media.test/ref"]}),
            )
            .await;
    }
}

#[test]
fn video_union_schema_keeps_h3_limits_in_the_model_condition() {
    let schema = video_schema();
    assert!(schema["properties"]["aspect_ratio"]["enum"]
        .as_array()
        .unwrap()
        .contains(&json!("21:9")));
    let h3 = &schema["allOf"][0]["then"]["properties"];
    assert_eq!(h3["duration"]["minimum"], 4);
    assert_eq!(h3["reference_images"]["maxItems"], 5);
    assert_eq!(h3["resolution"]["type"], "null");
    let grok = &schema["allOf"][0]["else"]["properties"];
    assert_eq!(grok["duration"]["minimum"], 1);
    assert_eq!(grok["reference_images"]["maxItems"], 7);
    assert_eq!(grok["reference_videos"]["type"], "null");
}

#[tokio::test]
async fn music_modes_require_their_prompt_style_and_title_before_http() {
    let mut fixture = Fixture::new().await;
    let cases = [
        json!({}),
        json!({"prompt":""}),
        json!({"prompt":" \n\t"}),
        json!({"prompt":"fixture", "mode":"advanced"}),
        json!({"prompt":"fixture", "mode":1}),
        json!({"mode":"custom", "instrumental":true}),
        json!({"mode":"custom", "instrumental":true, "style":"piano"}),
        json!({"mode":"custom", "instrumental":true, "title":"fixture"}),
        json!({"mode":"custom", "instrumental":true, "style":"", "title":"fixture"}),
        json!({"mode":"custom", "instrumental":true, "style":"piano", "title":"  "}),
        json!({"mode":"custom", "style":"piano", "title":"fixture"}),
        json!({"mode":"custom", "prompt":"", "style":"piano", "title":"fixture"}),
        json!({"mode":"custom", "prompt":"  ", "style":"piano", "title":"fixture"}),
    ];
    for input in cases {
        fixture.rejects_before_http(&GenerateMusicTool, input).await;
    }
}

#[tokio::test]
async fn music_optional_controls_reject_invalid_values_before_http() {
    let mut fixture = Fixture::new().await;
    let cases = [
        json!({"vocal_gender":"other"}),
        json!({"vocal_gender":""}),
        json!({"vocal_gender":true}),
        json!({"style_weight":-0.01}),
        json!({"style_weight":1.01}),
        json!({"style_weight":"0.5"}),
        json!({"weirdness":-0.01}),
        json!({"weirdness":1.01}),
        json!({"weirdness":false}),
        json!({"negative_style":7}),
    ];
    for options in cases {
        let mut input = json!({"prompt":"fixture"});
        input
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        fixture.rejects_before_http(&GenerateMusicTool, input).await;
    }
}

#[tokio::test]
async fn generation_tools_reject_unknown_fields_and_non_string_models_before_http() {
    let mut fixture = Fixture::new().await;
    for tool in [
        &GenerateImageTool as &dyn Tool,
        &GenerateVideoTool,
        &GenerateMusicTool,
    ] {
        for input in [
            json!({"prompt":"fixture", "unknown_option":true}),
            json!({"prompt":"fixture", "model":123}),
        ] {
            fixture.rejects_before_http(tool, input).await;
        }
    }
}

#[tokio::test]
async fn video_checks_every_reference_path_in_risk_and_execution() {
    let mut fixture = Fixture::new().await;
    for input in [
        json!({"prompt":"fixture", "reference_images":["../outside.png", "frame.png"]}),
        json!({"prompt":"fixture", "reference_images":["frame.png", "../outside.png"]}),
        json!({"prompt":"fixture", "image_path":"frame.png", "reference_images":["../outside.png"]}),
    ] {
        assert_eq!(
            GenerateVideoTool.evaluate_risk(&fixture.ctx, &input).level,
            RiskLevel::Blocked,
            "risk evaluation skipped an unsafe reference: {input}"
        );
        let result = GenerateVideoTool.execute(&fixture.ctx, input).await;
        assert!(matches!(
            result,
            Err(ToolError::SandboxDenied(_) | ToolError::InvalidInput(_))
        ));
        assert!(fixture.requests.try_recv().is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn video_references_cannot_escape_the_workspace_through_symlinks() {
    let mut fixture = Fixture::new().await;
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("private.png");
    std::fs::write(&target, b"\x89PNG\r\n\x1a\n").unwrap();
    std::os::unix::fs::symlink(&target, fixture.directory.path().join("linked.png")).unwrap();
    let input = json!({"prompt":"fixture", "reference_images":["frame.png", "linked.png"]});
    assert_eq!(
        GenerateVideoTool.evaluate_risk(&fixture.ctx, &input).level,
        RiskLevel::Blocked
    );
    assert!(matches!(
        GenerateVideoTool.execute(&fixture.ctx, input).await,
        Err(ToolError::SandboxDenied(_))
    ));
    assert!(fixture.requests.try_recv().is_err());
}

// Optional fields can express constraints directly or inside a nullable anyOf.
fn constraint<'a>(schema: &'a Value, key: &str) -> Option<&'a Value> {
    schema.get(key).or_else(|| {
        schema
            .get("anyOf")
            .and_then(Value::as_array)?
            .iter()
            .find_map(|branch| constraint(branch, key))
    })
}

fn admits_type(schema: &Value, expected: &str) -> bool {
    schema.get("type").is_some_and(|kind| {
        kind.as_str() == Some(expected)
            || kind
                .as_array()
                .is_some_and(|kinds| kinds.contains(&json!(expected)))
    }) || schema
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|branches| branches.iter().any(|branch| admits_type(branch, expected)))
}

fn field<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema
        .get("properties")
        .and_then(|properties| properties.get(name))
        .unwrap_or_else(|| panic!("schema is missing field {name}: {schema}"))
}

fn assert_enum(schema: &Value, name: &str, expected: &[&str]) {
    let values = constraint(field(schema, name), "enum")
        .unwrap()
        .as_array()
        .unwrap();
    let actual: std::collections::BTreeSet<_> = values.iter().filter_map(Value::as_str).collect();
    assert_eq!(
        actual,
        expected.iter().copied().collect(),
        "enum for {name}"
    );
}

fn assert_default(schema: &Value, name: &str, expected: Value) {
    assert_eq!(
        constraint(field(schema, name), "default"),
        Some(&expected),
        "default for {name}"
    );
}

fn assert_bounds(schema: &Value, name: &str, min: f64, max: f64) {
    assert_eq!(
        constraint(field(schema, name), "minimum").and_then(Value::as_f64),
        Some(min),
        "minimum for {name}"
    );
    assert_eq!(
        constraint(field(schema, name), "maximum").and_then(Value::as_f64),
        Some(max),
        "maximum for {name}"
    );
}

#[test]
fn video_schema_advertises_the_same_baseline_limits_as_runtime() {
    let schema = grok_video_schema();
    assert_bounds(&schema, "duration", 1.0, 15.0);
    assert_default(&schema, "duration", json!(8));
    assert_enum(&schema, "resolution", &["480p", "720p"]);
    assert_enum(
        &schema,
        "aspect_ratio",
        &["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    );
    let references = field(&schema, "reference_images");
    assert_eq!(constraint(references, "minItems"), Some(&json!(1)));
    assert_eq!(constraint(references, "maxItems"), Some(&json!(7)));
    assert_eq!(constraint(references, "items").unwrap()["type"], "string");
}

#[test]
fn music_schema_exposes_modes_optional_prompt_and_unit_controls() {
    let schema = GenerateMusicTool.spec().parameters;
    assert_enum(&schema, "mode", &["simple", "custom"]);
    assert_default(&schema, "mode", json!("simple"));
    assert_default(&schema, "prompt", json!(""));
    assert_default(&schema, "instrumental", json!(false));
    assert_enum(&schema, "vocal_gender", &["male", "female"]);
    assert_bounds(&schema, "style_weight", 0.0, 1.0);
    assert_bounds(&schema, "weirdness", 0.0, 1.0);
    assert!(!schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|required| required.contains(&json!("prompt"))));
    assert!(field(&schema, "negative_style").is_object());
}

#[test]
fn schemas_express_reference_exclusivity_and_music_mode_requirements() {
    let video = GenerateVideoTool.spec().parameters;
    assert_eq!(
        video["not"],
        json!({"required":["image_path", "reference_images"],
            "properties":{"image_path":{"type":"string"},
                "reference_images":{"type":"array"}}})
    );
    let music = GenerateMusicTool.spec().parameters;
    let mode = &music["allOf"][0];
    assert_eq!(mode["if"]["properties"]["mode"]["const"], "custom");
    assert_eq!(mode["then"]["required"], json!(["style", "title"]));
    for name in ["style", "title"] {
        assert_eq!(mode["then"]["properties"][name]["type"], "string");
        assert_eq!(mode["then"]["properties"][name]["minLength"], 1);
    }
    assert_eq!(
        mode["then"]["if"]["properties"]["instrumental"]["const"],
        true
    );
    assert_eq!(mode["then"]["if"]["required"], json!(["instrumental"]));
    for vocal_or_simple in [&mode["then"]["else"], &mode["else"]] {
        assert_eq!(vocal_or_simple["required"], json!(["prompt"]));
        assert_eq!(vocal_or_simple["properties"]["prompt"]["type"], "string");
        assert_eq!(vocal_or_simple["properties"]["prompt"]["minLength"], 1);
    }
}

#[test]
fn schemas_allow_unknown_model_strings_without_metadata_and_keep_optionals_nullable() {
    for tool in [
        &GenerateImageTool as &dyn Tool,
        &GenerateVideoTool,
        &GenerateMusicTool,
    ] {
        let schema = tool.spec().parameters;
        assert_eq!(schema["additionalProperties"], false);
        let model = field(&schema, "model");
        assert!(
            constraint(model, "enum").is_none(),
            "{} hardcodes model IDs",
            tool.name()
        );
        assert!(
            admits_type(model, "string"),
            "model must accept strings: {model}"
        );
        assert!(
            admits_type(model, "null"),
            "optional model must accept null: {model}"
        );
    }
    for (tool, fields) in [
        (
            &GenerateVideoTool as &dyn Tool,
            &[
                "resolution",
                "aspect_ratio",
                "image_path",
                "reference_images",
            ][..],
        ),
        (
            &GenerateMusicTool as &dyn Tool,
            &[
                "style",
                "title",
                "negative_style",
                "vocal_gender",
                "style_weight",
                "weirdness",
            ][..],
        ),
    ] {
        let schema = tool.spec().parameters;
        for name in fields {
            assert!(
                admits_type(field(&schema, name), "null"),
                "{name} must allow null"
            );
        }
    }
}
