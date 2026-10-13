use super::*;
use axum::{extract::State, routing::post, Json, Router};
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

async fn generation(State(calls): State<Calls>, Json(body): Json<Value>) -> Json<Value> {
    calls.lock().unwrap().push(body);
    Json(json!({"task_id":"fixture_task","request_id":"fixture_task","clips":[]}))
}

async fn fixture(model: &str, kind: &str, tool: &str, properties: Value) -> Fixture {
    let calls = Calls::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/v1/videos/generations", post(generation))
        .route("/v1/videos/std/generations", post(generation))
        .route("/v1/music/generations", post(generation))
        .with_state(calls.clone());
    let handle = tokio::spawn(axum::serve(listener, router).into_future());
    let directory = tempfile::tempdir().unwrap();
    let base_url = format!("http://{address}/v1");
    // A fresh cached snapshot keeps selection entirely local: no discovery HTTP.
    let snapshot = json!({
        "baseUrl":base_url,"fetchedAt":chrono_like_timestamp(),
        "models":[{"id":model,"kind":kind,"maxDuration":null,
            "schemas":{tool:{"properties":properties}}}],
        "schemas":{tool:{"properties":{}}},"sources":[],"partial":false
    });
    std::fs::write(
        directory.path().join("snapshot.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    let registry = Arc::new(crate::MediaCapabilityRegistry::new(Some(
        directory.path().into(),
    )));
    let ctx = ToolContext::new(directory.path().into()).with_media(Some(MediaConfig {
        base_url,
        api_key: "fixture-key".into(),
        // Deliberately unavailable: omitted/null model must use registry selection.
        video_model: "retired-video".into(),
        music_model: "retired-music".into(),
        capabilities: Some(registry),
        ..Default::default()
    }));
    Fixture {
        directory,
        ctx,
        calls,
        handle,
    }
}

fn replace_schema(f: &mut Fixture, model: &str, tool: &str, properties: Value) {
    let path = f.directory.path().join("snapshot.json");
    let mut snapshot: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    snapshot["models"][0]["schemas"][tool] = json!({"properties":properties});
    assert_eq!(snapshot["models"][0]["id"], model);
    std::fs::write(path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    f.ctx.media.as_mut().unwrap().capabilities = Some(Arc::new(
        crate::MediaCapabilityRegistry::new(Some(f.directory.path().into())),
    ));
}

#[tokio::test]
async fn selected_video_defaults_match_for_omitted_null_and_explicit_models() {
    for model in ["grok-imagine-video-1.5", "minimax-h3-768p"] {
        let f = fixture(
            model,
            "video",
            "generate_video",
            json!({"duration":{"default":6,"minimum":5,"maximum":7}}),
        )
        .await;
        for input in [
            json!({"prompt":"animate"}),
            json!({"prompt":"animate","model":null,"duration":null}),
            json!({"prompt":"animate","model":model}),
            json!({"prompt":"animate","model":model,"duration":6}),
        ] {
            GenerateVideoTool.execute(&f.ctx, input).await.unwrap();
        }
        let expected = if model.starts_with("minimax") {
            json!({"model":model,"prompt":"animate","seconds":6})
        } else {
            json!({"model":model,"prompt":"animate","duration":6})
        };
        assert_eq!(*f.calls.lock().unwrap(), vec![expected; 4]);
        for duration in [4, 8] {
            assert!(matches!(
                GenerateVideoTool
                    .execute(&f.ctx, json!({"prompt":"animate","duration":duration}))
                    .await,
                Err(ToolError::InvalidInput(_))
            ));
        }
        assert_eq!(f.calls.lock().unwrap().len(), 4);
    }
}

#[tokio::test]
async fn h3_native_duration_default_is_used() {
    let mut f = fixture("minimax-h3-2k", "video", "generate_video", json!({})).await;
    let path = f.directory.path().join("snapshot.json");
    let mut snapshot: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    snapshot["models"][0]["schemas"] = json!({"channel_request":{"properties":{
        "seconds":{"default":6,"minimum":5,"maximum":7}
    }}});
    std::fs::write(path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    f.ctx.media.as_mut().unwrap().capabilities = Some(Arc::new(
        crate::MediaCapabilityRegistry::new(Some(f.directory.path().into())),
    ));
    GenerateVideoTool
        .execute(&f.ctx, json!({"prompt":"animate"}))
        .await
        .unwrap();
    assert_eq!(
        f.calls.lock().unwrap()[0],
        json!({"model":"minimax-h3-2k","prompt":"animate","seconds":6})
    );
}

#[tokio::test]
async fn invalid_video_defaults_are_rejected_before_http() {
    for model in ["grok-imagine-video-1.5", "minimax-h3-768p"] {
        let mut f = fixture(model, "video", "generate_video", json!({})).await;
        for default in [json!(4), json!(8), json!("6"), json!(6.5), json!(null)] {
            replace_schema(
                &mut f,
                model,
                "generate_video",
                json!({
                    "duration":{"default":default,"minimum":5,"maximum":7}
                }),
            );
            for input in [
                json!({"prompt":"animate"}),
                json!({"prompt":"animate","duration":null}),
            ] {
                assert!(matches!(
                    GenerateVideoTool.execute(&f.ctx, input).await,
                    Err(ToolError::InvalidInput(_))
                ));
            }
        }
        assert!(f.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn video_fallback_is_eight_and_grok_keeps_optional_wire_fields_omitted() {
    for model in ["grok-imagine-video-1.5", "minimax-h3-768p"] {
        let f = fixture(
            model,
            "video",
            "generate_video",
            json!({
                "duration":{"minimum":4,"maximum":15},
                "aspect_ratio":{"default":"16:9"},"resolution":{"default":"480p"}
            }),
        )
        .await;
        GenerateVideoTool
            .execute(&f.ctx, json!({"prompt":"animate"}))
            .await
            .unwrap();
        let expected = if model.starts_with("minimax") {
            json!({"model":model,"prompt":"animate","seconds":8})
        } else {
            json!({"model":model,"prompt":"animate","duration":8})
        };
        assert_eq!(f.calls.lock().unwrap()[0], expected);
    }
}

#[tokio::test]
async fn unknown_video_models_keep_duration_omitted_without_an_advertised_default() {
    let model = "configured-video";
    let f = fixture(
        model,
        "video",
        "generate_video",
        json!({
            "duration":{"minimum":5,"maximum":7}
        }),
    )
    .await;
    for input in [
        json!({"prompt":"animate"}),
        json!({"prompt":"animate","model":null,"duration":null}),
    ] {
        GenerateVideoTool.execute(&f.ctx, input).await.unwrap();
    }
    assert_eq!(
        *f.calls.lock().unwrap(),
        vec![json!({"model":model,"prompt":"animate"}); 2]
    );
}

#[tokio::test]
async fn music_defaults_match_for_null_omitted_and_explicit_values() {
    let model = "suno-v6";
    let f = fixture(
        model,
        "music",
        "generate_music",
        json!({
            "mode":{"default":"custom"},"instrumental":{"default":true}
        }),
    )
    .await;
    for input in [
        json!({"style":"piano","title":"Fixture"}),
        json!({"model":null,"mode":null,"instrumental":null,"style":"piano","title":"Fixture"}),
        json!({"model":model,"style":"piano","title":"Fixture"}),
        json!({"model":model,"mode":"custom","instrumental":true,"style":"piano","title":"Fixture"}),
    ] {
        GenerateMusicTool.execute(&f.ctx, input).await.unwrap();
    }
    let expected = json!({"model":model,"mode":"custom","instrumental":true,"prompt":"","style":"piano","title":"Fixture"});
    assert_eq!(*f.calls.lock().unwrap(), vec![expected; 4]);
    for input in [
        json!({"prompt":"lyrics"}),
        json!({"style":"piano"}),
        json!({"style":"piano","title":"Fixture","instrumental":false}),
    ] {
        assert!(matches!(
            GenerateMusicTool.execute(&f.ctx, input).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    assert_eq!(f.calls.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn music_validates_final_model_and_synthesized_prompt_before_http() {
    let model = "suno-v6";
    let mut f = fixture(model, "music", "generate_music", json!({})).await;
    for properties in [
        json!({"model":{"enum":["another-model"]}}),
        json!({"mode":{"default":"custom"},"instrumental":{"default":true},"prompt":{"minLength":1}}),
        json!({"mode":{"default":"simple","enum":["custom"]}}),
        json!({"instrumental":{"default":false,"enum":[true]}}),
    ] {
        replace_schema(&mut f, model, "generate_music", properties.clone());
        let input = if properties.get("prompt").is_some() {
            json!({"style":"piano","title":"Fixture"})
        } else {
            json!({"prompt":"piano"})
        };
        assert!(matches!(
            GenerateMusicTool.execute(&f.ctx, input).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    assert!(f.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn music_rejects_unsupported_and_wrong_type_defaults_before_http() {
    let model = "suno-v6";
    let mut f = fixture(model, "music", "generate_music", json!({})).await;
    for (field, default) in [
        ("mode", json!("other")),
        ("mode", json!(true)),
        ("mode", json!(null)),
        ("instrumental", json!("true")),
        ("instrumental", json!(1)),
        ("instrumental", json!(null)),
    ] {
        replace_schema(
            &mut f,
            model,
            "generate_music",
            json!({field:{"default":default}}),
        );
        for input in [
            json!({"prompt":"piano"}),
            json!({"prompt":"piano","mode":null,"instrumental":null}),
        ] {
            assert!(matches!(
                GenerateMusicTool.execute(&f.ctx, input).await,
                Err(ToolError::InvalidInput(_))
            ));
        }
    }
    assert!(f.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn music_fallbacks_and_explicit_values_override_advertised_defaults() {
    let model = "suno-v6";
    let mut f = fixture(
        model,
        "music",
        "generate_music",
        json!({
            "mode":{},"instrumental":{}
        }),
    )
    .await;
    GenerateMusicTool
        .execute(
            &f.ctx,
            json!({"prompt":"piano","mode":null,"instrumental":null}),
        )
        .await
        .unwrap();
    let expected = json!({"model":model,"mode":"simple","prompt":"piano","instrumental":false});
    assert_eq!(f.calls.lock().unwrap()[0], expected);
    replace_schema(
        &mut f,
        model,
        "generate_music",
        json!({
            "mode":{"default":"custom"},"instrumental":{"default":true}
        }),
    );
    GenerateMusicTool
        .execute(
            &f.ctx,
            json!({"prompt":"piano","mode":"simple","instrumental":false}),
        )
        .await
        .unwrap();
    assert_eq!(f.calls.lock().unwrap()[1], expected);
}
