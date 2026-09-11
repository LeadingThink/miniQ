use super::*;
use serde_json::json;

fn chunk(id: &str, index: usize, total: usize, bytes: &[u8]) -> Value {
    json!({"type":"remote_chunk", "transferId":"transfer", "requestId":id, "index":index, "totalBytes":total, "data":URL_SAFE_NO_PAD.encode(bytes)})
}

#[test]
fn assembles_complete_unicode_requests_without_dispatching_partial_audio() {
    let request = json!({"id":"speech", "method":"voice.transcribe", "params":{"audioBase64":"audio".repeat(400_000), "filename":"中文.wav"}});
    let bytes = serde_json::to_vec(&request).unwrap();
    let mut uploads = Uploads::default();
    let mut result = None;
    for (index, piece) in bytes.chunks(CHUNK_BYTES).enumerate() {
        assert!(result.is_none());
        result = uploads
            .read("mobile", chunk("speech", index, bytes.len(), piece))
            .unwrap();
    }
    assert_eq!(result.unwrap(), request);
    assert!(uploads.transfers.is_empty());
}

#[test]
fn cancellation_and_presence_are_scoped_to_the_owning_phone() {
    let mut uploads = Uploads::default();
    for source in ["phone-a", "phone-b"] {
        assert!(uploads
            .read(source, chunk("same", 0, 100, b"partial"))
            .unwrap()
            .is_none());
    }
    uploads.cancel("phone-a", "same");
    assert_eq!(uploads.transfers.len(), 1);
    assert!(uploads
        .transfers
        .keys()
        .all(|(source, _)| source == "phone-b"));
    uploads.retain_sources(&["phone-a".into()]);
    assert!(uploads.transfers.is_empty());
}

#[test]
fn rejects_inconsistent_or_oversized_transfers_and_releases_their_buffers() {
    let mut uploads = Uploads::default();
    uploads
        .read("phone", chunk("speech", 0, 100, b"first"))
        .unwrap();
    assert!(uploads
        .read("phone", chunk("speech", 2, 100, b"out of order"))
        .is_err());
    assert!(uploads.transfers.is_empty());
    assert!(uploads
        .read(
            "phone",
            chunk("speech", 0, MAX_REQUEST_BYTES + 1, b"too large")
        )
        .is_err());
    let request = br#"{"id":"another-request"}"#;
    assert!(uploads
        .read("phone", chunk("speech", 0, request.len(), request))
        .is_err());
    assert!(uploads.transfers.is_empty());
}

#[test]
fn abandoned_uploads_expire_without_waiting_for_a_disconnect() {
    let mut uploads = Uploads::default();
    uploads
        .read("phone", chunk("speech", 0, 100, b"first"))
        .unwrap();
    for transfer in uploads.transfers.values_mut() {
        transfer.updated = Instant::now() - TRANSFER_TIMEOUT;
    }
    uploads.expire();
    assert!(uploads.transfers.is_empty());
}
