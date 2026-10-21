use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

use async_trait::async_trait;

use super::*;
use crate::{ChatImage, ChatMessage, CompletionRequest, ImageDetail, ProviderMediaReference};

const URL: &str =
    "https://s3-cn-south-1.qiniucs.com/private/provider-media/image?signature=fixture";

#[derive(Default)]
struct Uploader {
    uploaded: Mutex<Vec<(Vec<u8>, String)>>,
    fail: bool,
}

#[async_trait]
impl ProviderMediaUploader for Uploader {
    fn cache_namespace(&self) -> Option<String> {
        Some("image-upload-tests".into())
    }

    async fn upload(&self, bytes: Vec<u8>, mime: &str) -> Result<ProviderMediaReference, String> {
        if self.fail {
            return Err("ticket unavailable (HTTP 503)".into());
        }
        let size = bytes.len();
        self.uploaded.lock().unwrap().push((bytes, mime.into()));
        Ok(ProviderMediaReference {
            url: URL.into(),
            bytes: size,
            content_type: mime.into(),
            expires_at: u64::MAX,
        })
    }
}

fn data(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[tokio::test]
async fn uploads_image_bytes_once_and_encodes_all_protocols_without_touching_text_or_schemas() {
    let raw = b"original clipboard image";
    let inline = data(raw);
    let block = json!({"type":"image_url", "image_url":{"url":inline,"detail":"high"}});
    let mut body = json!({
        "messages":[
            {"role":"user","content":[{"type":"text","text":inline}, block.clone(),
                {"type":"tool_result", "content":[{"type":"image", "source":{
                    "type":"base64", "media_type":"image/png", "data":base64::engine::general_purpose::STANDARD.encode(raw)
                }}]}]},
            {"role":"assistant","content":[block.clone()]}
        ],
        "input":[
            {"role":"user","content":[{"type":"input_image","image_url":inline,"detail":"auto"}]},
            {"type":"computer_call_output","output":{"type":"computer_screenshot","image_url":inline}},
            {"type":"function_call_output","output":[{"type":"input_image","image_url":inline}]}
        ],
        "tools":[{"parameters":{"example":block}}]
    });
    let uploader = Uploader::default();
    let mut uploads = ImageUploads::default();
    uploads.replace(&mut body, &uploader).await.unwrap();
    assert_eq!(
        *uploader.uploaded.lock().unwrap(),
        vec![(raw.to_vec(), "image/png".into())]
    );
    assert_eq!(body["messages"][0]["content"][0]["text"], inline);
    assert_eq!(
        body["messages"][0]["content"][1]["image_url"],
        json!({"url":URL,"detail":"high"})
    );
    assert_eq!(
        body["messages"][0]["content"][2]["content"][0]["source"],
        json!({"type":"url","url":URL})
    );
    assert_eq!(body["input"][0]["content"][0]["image_url"], URL);
    assert_eq!(body["input"][0]["content"][0]["detail"], "auto");
    assert_eq!(body["input"][1]["output"]["image_url"], URL);
    assert_eq!(body["input"][2]["output"][0]["image_url"], URL);
    assert_eq!(body["messages"][1]["content"][0], block);
    assert_eq!(body["tools"][0]["parameters"]["example"], block);
    uploads.replace(&mut body, &uploader).await.unwrap();
    let mut rebuilt = json!({"input":[{"content":[{"type":"input_image","image_url":inline}]}]});
    uploads.replace(&mut rebuilt, &uploader).await.unwrap();
    assert_eq!(uploader.uploaded.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn shared_cache_reuses_a_successful_upload_across_request_steps() {
    let uploader = Uploader::default();
    let body =
        json!({"input":[{"content":[{"type":"input_image","image_url":data(b"shared pixels")}]}]});
    let mut first = ImageUploads::default();
    first.replace(&mut body.clone(), &uploader).await.unwrap();
    let mut second = ImageUploads::default();
    second.replace(&mut body.clone(), &uploader).await.unwrap();
    assert_eq!(uploader.uploaded.lock().unwrap().len(), 1);
}

struct ExpiringUploader(AtomicUsize);

#[async_trait]
impl ProviderMediaUploader for ExpiringUploader {
    fn cache_namespace(&self) -> Option<String> {
        Some("expiring-image-upload-test".into())
    }

    async fn upload(&self, bytes: Vec<u8>, mime: &str) -> Result<ProviderMediaReference, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderMediaReference {
            url: URL.into(),
            content_type: mime.into(),
            bytes: bytes.len(),
            expires_at: super::now_millis().saturating_add(1),
        })
    }
}

#[tokio::test]
async fn expired_shared_links_are_uploaded_again() {
    let uploader = ExpiringUploader(AtomicUsize::new(0));
    let body =
        json!({"input":[{"content":[{"type":"input_image","image_url":data(b"expired pixels")}]}]});
    let mut first = ImageUploads::default();
    first.replace(&mut body.clone(), &uploader).await.unwrap();
    let mut second = ImageUploads::default();
    second.replace(&mut body.clone(), &uploader).await.unwrap();
    assert_eq!(uploader.0.load(Ordering::SeqCst), 2);
}

fn request(messages: Vec<ChatMessage>) -> CompletionRequest {
    CompletionRequest {
        context_compact_threshold: None,
        trace: Default::default(),
        messages,
        tools: vec![],
        temperature: None,
        max_output_tokens: None,
    }
}

#[tokio::test]
async fn uploads_before_enforcing_wire_budget_and_keeps_every_distinct_image() {
    let dir = tempfile::tempdir().unwrap();
    let mut messages = vec![];
    for i in 0..4 {
        let path = dir.path().join(format!("{i}.png"));
        std::fs::write(&path, vec![i; 4 * 1024 * 1024]).unwrap();
        let mut message = ChatMessage::user(format!("image {i}"));
        message.images.push(ChatImage {
            path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".into(),
            detail: ImageDetail::Auto,
        });
        messages.push(message);
    }
    let original = request(messages);
    let snapshot = serde_json::to_value(&original.messages).unwrap();
    let uploader = Uploader::default();
    let body = crate::request_attachments::build_with_attachment_recovery(
        &original,
        Some(&uploader),
        |r| Ok(json!({"input":crate::responses_request::build_input(&r.messages)?})),
    )
    .await
    .unwrap();
    assert_eq!(body["input"].as_array().unwrap().len(), 4);
    assert_eq!(uploader.uploaded.lock().unwrap().len(), 4);
    assert!(crate::request_budget::wire_size(&body).unwrap() < 4096);
    assert_eq!(crate::request_budget::image_wire_size(&body), 0);
    assert_eq!(serde_json::to_value(&original.messages).unwrap(), snapshot);
}

#[tokio::test]
async fn upload_failure_aborts_request_without_inline_fallback_or_secret_leak() {
    let uploader = Uploader {
        fail: true,
        ..Default::default()
    };
    let error = crate::request_attachments::build_with_attachment_recovery(
        &request(vec![ChatMessage::user("inspect")]),
        Some(&uploader),
        |_| Ok(json!({"input":[{"content":[{"type":"input_image","image_url":data(b"pixels")}]}]})),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("图片上传七牛云失败"));
    assert!(error.to_string().contains("HTTP 503"));
}

#[test]
fn static_gif_upload_preserves_pixels_in_supported_png_format() {
    let pixels = image::DynamicImage::new_rgb8(2, 3);
    let mut gif = std::io::Cursor::new(Vec::new());
    pixels.write_to(&mut gif, image::ImageFormat::Gif).unwrap();
    let (mime, bytes) = upload_payload(
        "image/gif",
        &base64::engine::general_purpose::STANDARD.encode(gif.into_inner()),
    )
    .unwrap();
    assert_eq!(mime, "image/png");
    assert_eq!(
        image::load_from_memory(&bytes).unwrap().to_rgb8(),
        pixels.to_rgb8()
    );
}
