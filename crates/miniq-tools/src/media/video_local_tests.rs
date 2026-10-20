use super::*;
use crate::{ProviderMediaReference, ProviderMediaUploader};
use std::future::IntoFuture;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
struct Uploader(AtomicUsize);
#[async_trait]
impl ProviderMediaUploader for Uploader {
    async fn upload(&self, bytes: Vec<u8>, mime: &str) -> Result<ProviderMediaReference, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderMediaReference {
            url: "https://storage.test/reference?signature=fixture".into(),
            bytes: bytes.len(),
            content_type: mime.into(),
            expires_at: u64::MAX,
        })
    }
}
#[tokio::test]
async fn prepares_authorized_local_media_and_preserves_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let uploader = Arc::new(Uploader(AtomicUsize::new(0)));
    let ctx =
        ToolContext::new(dir.path().into()).with_provider_media_uploader(Some(uploader.clone()));
    for (name, bytes, kind) in [
        (
            "frame.png",
            b"\x89PNG\r\n\x1a\nfixture".to_vec(),
            ReferenceKind::Image,
        ),
        (
            "clip.mp4",
            b"\0\0\0\x18ftypisomfixture".to_vec(),
            ReferenceKind::Video,
        ),
        (
            "voice.wav",
            b"RIFF\0\0\0\0WAVEfixture".to_vec(),
            ReferenceKind::Audio,
        ),
    ] {
        std::fs::write(dir.path().join(name), &bytes).unwrap();
        let reference = prepare_h3_reference(&ctx, name, kind, &mut 0)
            .await
            .unwrap();
        assert!(upload_h3_reference(&ctx, reference)
            .await
            .unwrap()
            .starts_with("https://"));
        assert_eq!(std::fs::read(dir.path().join(name)).unwrap(), bytes);
    }
    assert_eq!(uploader.0.load(Ordering::SeqCst), 3);
}
#[tokio::test]
async fn url_passthrough_never_uploads_and_preflight_has_no_upload_side_effect() {
    let dir = tempfile::tempdir().unwrap();
    let uploader = Arc::new(Uploader(AtomicUsize::new(0)));
    let ctx =
        ToolContext::new(dir.path().into()).with_provider_media_uploader(Some(uploader.clone()));
    let url = "https://media.test/reference.png";
    let ref_url = prepare_h3_reference(&ctx, url, ReferenceKind::Image, &mut 0)
        .await
        .unwrap();
    assert_eq!(upload_h3_reference(&ctx, ref_url).await.unwrap(), url);
    std::fs::write(dir.path().join("first.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
    std::fs::write(dir.path().join("bad.png"), b"<html>not media</html>").unwrap();
    assert!(
        prepare_h3_reference(&ctx, "first.png", ReferenceKind::Image, &mut 0)
            .await
            .is_ok()
    );
    assert!(
        prepare_h3_reference(&ctx, "bad.png", ReferenceKind::Image, &mut 0)
            .await
            .is_err()
    );
    assert!(
        prepare_h3_reference(&ctx, "../outside.png", ReferenceKind::Image, &mut 0)
            .await
            .is_err()
    );
    assert_eq!(uploader.0.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn rejects_sizes_before_reading_or_uploading_and_honors_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    std::fs::File::create(dir.path().join("large.png"))
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    assert!(
        prepare_h3_reference(&ctx, "large.png", ReferenceKind::Image, &mut 0)
            .await
            .is_err()
    );
    ctx.cancellation.cancel();
    assert!(upload_h3_reference(
        &ctx,
        PreparedReference::Local {
            bytes: vec![1],
            content_type: "image/png"
        }
    )
    .await
    .is_err());
}

#[tokio::test]
async fn h3_request_receives_uploaded_urls_and_image_path_alias() {
    use axum::{extract::State, routing::post, Json, Router};
    let calls = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = server.local_addr().unwrap();
    let handle = tokio::spawn(
        axum::serve(
            server,
            Router::new()
                .route(
                    "/v1/videos/std/generations",
                    post(
                        |State(calls): State<Arc<std::sync::Mutex<Vec<Value>>>>,
                         Json(body): Json<Value>| async move {
                            calls.lock().unwrap().push(body);
                            Json(json!({"task_id":"fixture_h3","status":"queued"}))
                        },
                    ),
                )
                .with_state(calls.clone()),
        )
        .into_future(),
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("frame.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
    let uploader = Arc::new(Uploader(AtomicUsize::new(0)));
    let mut ctx =
        ToolContext::new(dir.path().into()).with_provider_media_uploader(Some(uploader.clone()));
    ctx.media = Some(MediaConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "test-key".into(),
        video_model: "minimax-h3-768p".into(),
        ..Default::default()
    });
    let result = GenerateVideoTool
        .execute(
            &ctx,
            json!({"model":"minimax-h3-768p","prompt":"fixture","image_path":"frame.png"}),
        )
        .await
        .unwrap();
    assert_eq!(result["request_id"], "fixture_h3");
    assert_eq!(uploader.0.load(Ordering::SeqCst), 1);
    assert!(calls.lock().unwrap()[0]["reference_images"][0]
        .as_str()
        .unwrap()
        .starts_with("https://"));
    assert!(calls.lock().unwrap()[0].get("image_path").is_none());
    // A later invalid reference aborts before any upload or generation.
    assert!(GenerateVideoTool.execute(&ctx, json!({"model":"minimax-h3-768p","prompt":"fixture","reference_images":["frame.png","missing.png"]})).await.is_err());
    assert_eq!(uploader.0.load(Ordering::SeqCst), 1);
    assert_eq!(calls.lock().unwrap().len(), 1);
    handle.abort();
}
