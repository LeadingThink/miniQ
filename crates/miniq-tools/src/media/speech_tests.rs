use super::*;
use axum::{body::Body, extract::State, http::Response, routing::post, Json, Router};
use std::{
    future::IntoFuture,
    sync::{Arc, Mutex},
};

type Calls = Arc<Mutex<Vec<Value>>>;

struct Fixture {
    directory: tempfile::TempDir,
    ctx: ToolContext,
    calls: Calls,
    handle: tokio::task::JoinHandle<Result<(), std::io::Error>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn fixture(content_type: &'static str) -> Fixture {
    let calls = Calls::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/v1/audio/speech",
            post(
                move |State(calls): State<Calls>, Json(body): Json<Value>| async move {
                    calls.lock().unwrap().push(body);
                    Response::builder()
                        .header("content-type", content_type)
                        .body(Body::from(b"audio-fixture".to_vec()))
                        .unwrap()
                },
            ),
        )
        .with_state(calls.clone());
    let handle = tokio::spawn(axum::serve(listener, router).into_future());
    let directory = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(directory.path().to_path_buf()).with_media(Some(MediaConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "fixture-key".into(),
        tts_model: "grok-tts".into(),
        ..Default::default()
    }));
    Fixture {
        directory,
        ctx,
        calls,
        handle,
    }
}

fn add_registry(f: &mut Fixture, models: Value, schemas: Value) {
    let snapshot = json!({
        "baseUrl":f.ctx.media.as_ref().unwrap().base_url,
        "fetchedAt":chrono_like_timestamp(), "models":models, "schemas":schemas,
        "sources":[], "partial":false,
    });
    std::fs::write(
        f.directory.path().join("snapshot.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    f.ctx.media.as_mut().unwrap().capabilities = Some(Arc::new(
        crate::MediaCapabilityRegistry::new(Some(f.directory.path().into())),
    ));
}

#[tokio::test]
async fn rejects_invalid_speech_before_any_generation_request() {
    let f = fixture("audio/mpeg").await;
    for input in [
        json!({"input":" \n\t"}),
        json!({"input":"hello","model":" "}),
        json!({"input":"hello","voice":"unknown"}),
        json!({"input":"hello","voice":""}),
        json!({"input":"hello","response_format":"ogg"}),
        json!({"input":"hello","response_format":""}),
        json!({"input":"hello","speed":0.99}),
        json!({"input":"hello","speed":1.01}),
        json!({"input":"<soft>unclosed"}),
        json!({"input":"</soft>orphan"}),
        json!({"input":"<soft><slow>crossed</soft></slow>"}),
        json!({"input":"[whisper]wrong[/whisper]"}),
        json!({"input":"<pause>"}),
        json!({"input":"hello[/pause]"}),
    ] {
        let error = SynthesizeSpeechTool
            .execute(&f.ctx, input)
            .await
            .unwrap_err();
        assert!(matches!(error, ToolError::InvalidInput(_)), "{error}");
    }
    assert!(f.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn valid_tag_script_is_sent_verbatim_and_defaults_use_canonical_mp3_mime() {
    let f = fixture("application/octet-stream").await;
    let script = format!(
        "  <soft><slow>你好 [pause]世界</slow></soft> [unknown]literal[/unknown] {}\n",
        STANDALONE_TAGS
            .iter()
            .map(|tag| format!("[{tag}]"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = SynthesizeSpeechTool
        .execute(&f.ctx, json!({"input":script}))
        .await
        .unwrap();
    let calls = f.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["input"], script);
    assert_eq!(calls[0]["model"], "grok-tts");
    assert_eq!(calls[0]["voice"], "eve");
    assert_eq!(calls[0]["response_format"], "mp3");
    assert_eq!(calls[0]["speed"].as_f64(), Some(1.0));
    assert_eq!(output["mimeType"], "audio/mpeg");
    assert_eq!(
        std::fs::read(output["path"].as_str().unwrap()).unwrap(),
        b"audio-fixture"
    );
}

#[tokio::test]
async fn wav_mime_is_canonical_and_long_text_has_no_ui_limit() {
    let f = fixture("application/octet-stream").await;
    let script = "speech ".repeat(300);
    let output = SynthesizeSpeechTool
        .execute(
            &f.ctx,
            json!({"input":script,"voice":"zenith","response_format":"wav","speed":1}),
        )
        .await
        .unwrap();
    assert_eq!(output["mimeType"], "audio/wav");
    assert_eq!(f.calls.lock().unwrap()[0]["input"], script);
}

#[tokio::test]
async fn custom_models_keep_unknown_ranges_and_use_real_channel_content_type() {
    let f = fixture("audio/ogg; codecs=opus").await;
    let output = SynthesizeSpeechTool
        .execute(
            &f.ctx,
            json!({
                "input":"[soft]literal for custom model", "model":"custom-tts",
                "voice":"custom-voice", "response_format":"ogg", "speed":2.75,
            }),
        )
        .await
        .unwrap();
    assert_eq!(output["mimeType"], "audio/ogg; codecs=opus");
    assert_eq!(f.calls.lock().unwrap()[0]["speed"], 2.75);
}

#[tokio::test]
async fn refreshed_model_defaults_and_constraints_are_applied_before_submission() {
    let mut f = fixture("audio/ogg").await;
    add_registry(
        &mut f,
        json!([{
            "id":"custom-tts","kind":"tts","maxDuration":null,"schemas":{
                "synthesize_speech":{"properties":{
                    "voice":{"enum":["speaker-a"],"default":"speaker-a"},
                    "response_format":{"enum":["ogg"],"default":"ogg"},
                    "speed":{"minimum":0.5,"maximum":3,"default":2.5},
                    "input":{"maxLength":20,"description":"Channel text"}
                }}
            }
        }]),
        json!({}),
    );
    // Preferred Grok is unavailable; the registry selects this channel model.
    let output = SynthesizeSpeechTool
        .execute(&f.ctx, json!({"input":"hello"}))
        .await
        .unwrap();
    assert_eq!(output["mimeType"], "audio/ogg");
    assert_eq!(
        f.calls.lock().unwrap()[0],
        json!({"model":"custom-tts","input":"hello","voice":"speaker-a","response_format":"ogg","speed":2.5})
    );
    for input in [
        json!({"input":"hello","model":"retired"}),
        json!({"input":"hello","voice":"eve"}),
        json!({"input":"hello","response_format":"mp3"}),
        json!({"input":"hello","speed":4}),
        json!({"input":"x".repeat(21)}),
    ] {
        assert!(matches!(
            SynthesizeSpeechTool.execute(&f.ctx, input).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    assert_eq!(f.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn refreshed_tag_rules_are_model_specific() {
    let mut f = fixture("audio/mpeg").await;
    add_registry(
        &mut f,
        json!([{
            "id":"custom-tts","kind":"tts","maxDuration":null,
            "schemas":{"synthesize_speech":{"properties":{"input":{
                "x-speech-tags":{"instant":["ding"],"paired":["calm"]}
            }}}}
        }]),
        json!({}),
    );
    assert!(matches!(
        SynthesizeSpeechTool
            .execute(&f.ctx, json!({"input":"<calm>unclosed"}))
            .await,
        Err(ToolError::InvalidInput(_))
    ));
    let script = "<calm>hello[ding]</calm> [soft]custom literal";
    SynthesizeSpeechTool
        .execute(&f.ctx, json!({"input":script}))
        .await
        .unwrap();
    assert_eq!(f.calls.lock().unwrap()[0]["input"], script);
}

#[test]
fn dynamic_tag_metadata_is_bounded_and_normalized_without_document_prose() {
    let schema = json!({"properties":{"input":{"x-speech-tags":{
        "instant":["ding", "UPPER", "bad space", "a".repeat(41)],
        "paired":["calm", "new-wrap"]
    }, "description":"provider prose must not be parsed"}}});
    assert_eq!(
        speech_tags_from_schema(&schema).unwrap(),
        json!({
            "instant":["ding"], "paired":["calm", "new-wrap"]
        })
    );
    assert!(speech_tags_from_schema(&json!({"properties":{"input":{}}})).is_none());
}

#[test]
fn tags_cover_all_documented_wrappers_and_keep_unknown_brackets_literal() {
    let rules = speech_tags_schema();
    for wrapper in WRAPPER_TAGS {
        assert!(validate_tag_pairs(&format!("<{wrapper}>text</{wrapper}>"), &rules).is_ok());
        assert!(validate_tag_pairs(&format!("<{wrapper}>text"), &rules).is_err());
        assert!(validate_tag_pairs(&format!("</{wrapper}>text"), &rules).is_err());
        let schema = speech_schema();
        let description = schema["properties"]["input"]["description"]
            .as_str()
            .unwrap();
        assert!(description.contains(&format!("<{wrapper}>")));
        assert!(!description.contains(&format!("[/{wrapper}]")));
    }
    assert!(validate_tag_pairs("[literal <soft>text</soft> end] [a] [not a tag]", &rules).is_ok());
    assert!(validate_tag_pairs("[literal <soft>text end]", &rules).is_err());
    assert_eq!(GROK_VOICES.len(), 26);
    let generic = speech_schema_for(&MediaConfig::default(), "custom-tts");
    assert!(generic["properties"]["voice"].get("enum").is_none());
    assert!(generic["properties"]["speed"].get("maximum").is_none());
    assert!(speech_schema()["properties"]["input"]
        .get("maxLength")
        .is_none());
}

#[tokio::test]
async fn cancellation_before_submission_makes_no_request() {
    let f = fixture("audio/mpeg").await;
    f.ctx.cancellation.cancel();
    let error = SynthesizeSpeechTool
        .execute(&f.ctx, json!({"input":"hello"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(f.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn chunked_response_limit_and_cancellation_are_enforced() {
    use futures_util::stream;
    use std::{convert::Infallible, time::Duration};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/large",
            axum::routing::get(|| async {
                Body::from_stream(stream::iter(
                    (0..65).map(|_| Ok::<_, Infallible>(vec![0_u8; 1024 * 1024])),
                ))
            }),
        )
        .route(
            "/pending",
            axum::routing::get(|| async {
                Body::from_stream(stream::pending::<Result<Vec<u8>, Infallible>>())
            }),
        )
        .route(
            "/declared-large",
            axum::routing::get(|| async {
                Response::builder()
                    .header("content-length", MAX_AUDIO_BYTES + 1)
                    .body(Body::from_stream(stream::pending::<
                        Result<Vec<u8>, Infallible>,
                    >()))
                    .unwrap()
            }),
        );
    let handle = tokio::spawn(axum::serve(listener, router).into_future());
    let directory = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(directory.path().into());
    let client = reqwest::Client::new();
    for route in ["large", "declared-large"] {
        let response = client
            .get(format!("http://{address}/{route}"))
            .send()
            .await
            .unwrap();
        let error = read_response(&ctx, response).await.unwrap_err();
        assert!(error.to_string().contains("64 MiB"));
    }
    let response = client
        .get(format!("http://{address}/pending"))
        .send()
        .await
        .unwrap();
    let token = ctx.cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        token.cancel();
    });
    let error = tokio::time::timeout(Duration::from_secs(2), read_response(&ctx, response))
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    handle.abort();
}
