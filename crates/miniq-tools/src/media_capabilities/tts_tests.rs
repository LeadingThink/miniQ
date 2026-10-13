use super::*;
use axum::{extract::State, routing::get, Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn tts_discovery_refreshes_models_fields_and_old_cache_without_secrets() {
    let _clock = test_guard();
    set_test_now(100_000);
    let phase = Arc::new(AtomicUsize::new(0));
    let service = Router::new().fallback(get(|State(phase): State<Arc<AtomicUsize>>, request: axum::extract::Request| async move {
        let current = phase.load(Ordering::SeqCst);
        if request.uri().path().ends_with("models/details") {
            let is_tts = request.uri().query().unwrap_or_default().contains("model_type=audio_tts");
            return Json(json!({"data":{"total":if is_tts {1} else {0},"models":if is_tts {
                vec![json!({"model_id":"grok-tts","model_type":"audio_tts","max_duration":300,
                    "parameter_schemas":{"synthesize_speech":{"properties":{
                        "voice":{"enum":[if current==0 {"eve"} else {"iris"}],"default":if current==0 {"eve"} else {"iris"}},
                        "input":{"maxLength":if current==0 {100} else {200},"x-speech-tags":{"instant":["pause"],"paired":[if current==0 {"whisper"} else {"soft"}]}}
                    }}}})]
            } else {vec![]}}}));
        }
        Json(json!({"paths":{"/v1/audio/speech":{"post":{"requestBody":{"content":{"application/json":{"schema":{
            "properties":{"input":{"type":"string"},"voice":{"type":"string"},"speed":{"type":"number","default":1.0},"response_format":{"enum":["mp3","wav"]}}
        }}}}}}}}))
    })).with_state(phase.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    // An old version's still-fresh cache lacks TTS and must be upgraded now.
    let mut previous = baseline_schemas();
    previous.remove("synthesize_speech");
    std::fs::write(directory.path().join("old.json"),serde_json::to_vec(&json!({"baseUrl":base,"fetchedAt":100_000,"models":[],"schemas":previous,"partial":false})).unwrap()).unwrap();
    let registry = MediaCapabilityRegistry::new(Some(directory.path().into()));
    let media = crate::MediaConfig {
        base_url: base,
        api_key: "fixture-secret-never-persist".into(),
        tts_model: "grok-tts".into(),
        ..Default::default()
    };
    let first = registry.refresh_due(&media).await.unwrap();
    assert_eq!(
        first.select_model("tts", "grok-tts", None).unwrap(),
        "grok-tts"
    );
    assert_eq!(
        first
            .parameter_schema("synthesize_speech", "grok-tts", "input")
            .unwrap()["maxLength"],
        100
    );
    phase.store(1, Ordering::SeqCst);
    set_test_now(100_000 + MEDIA_REFRESH_INTERVAL_SECS);
    let second = registry.refresh_due(&media).await.unwrap();
    assert_eq!(
        second
            .parameter_schema("synthesize_speech", "grok-tts", "voice")
            .unwrap()["default"],
        "iris"
    );
    assert_eq!(
        second
            .parameter_schema("synthesize_speech", "grok-tts", "input")
            .unwrap()["maxLength"],
        200
    );
    assert_eq!(
        second
            .parameter_schema("synthesize_speech", "grok-tts", "input")
            .unwrap()["x-speech-tags"]["paired"],
        json!(["soft"])
    );
    let mut specs = vec![ToolSpec {
        name: "synthesize_speech".into(),
        description: "speech".into(),
        parameters: crate::Tool::parameters_schema(&crate::SynthesizeSpeechTool),
    }];
    second.decorate_specs(&mut specs);
    assert!(
        specs[0].description.contains("<soft>...</soft>")
            && specs[0].description.contains("maxLength=200")
    );
    assert!(!serde_json::to_string(second.as_ref())
        .unwrap()
        .contains(&media.api_key));
    handle.abort();
    set_test_now(0);
}

#[tokio::test]
#[ignore = "read-only live OneAPI capability discovery; never generates audio"]
async fn live_channel_tts_document_and_openapi_agree() {
    let media = crate::MediaConfig {
        base_url: "https://oneapi.zaiwenai.com/v1".into(),
        tts_model: "grok-tts".into(),
        ..Default::default()
    };
    let snapshot = MediaCapabilityRegistry::new(None)
        .refresh_due(&media)
        .await
        .unwrap();
    assert_eq!(
        snapshot.select_model("tts", "grok-tts", None).unwrap(),
        "grok-tts"
    );
    let fields = &snapshot
        .models
        .iter()
        .find(|m| m.id == "grok-tts")
        .unwrap()
        .schemas["synthesize_speech"]["properties"];
    assert!(fields["voice"]["enum"]
        .as_array()
        .unwrap()
        .contains(&json!("eve")));
    assert!(fields["input"]["x-speech-tags"]["paired"]
        .as_array()
        .unwrap()
        .contains(&json!("whisper")));
    println!(
        "read_only_tts voices={} paired_tags={} snapshot_fetched_at={}",
        fields["voice"]["enum"].as_array().unwrap().len(),
        fields["input"]["x-speech-tags"]["paired"]
            .as_array()
            .unwrap()
            .len(),
        snapshot.fetched_at
    );
}
