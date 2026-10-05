use super::*;
use crate::remote::{decrypt_payload, derive_identity};
use std::sync::{Arc, Mutex};

#[test]
fn gzip_is_negotiated_lossless_and_skipped_for_small_responses() {
    use std::io::Read;
    let payload = json!({"id":"compressed", "result":"完整数据".repeat(100_000)});
    let encoded = encode(&payload, true).unwrap();
    assert!(encoded.len() < serde_json::to_vec(&payload).unwrap().len() / 10);
    let wrapper: Value = serde_json::from_slice(&encoded).unwrap();
    let compressed = URL_SAFE_NO_PAD
        .decode(wrapper["data"].as_str().unwrap())
        .unwrap();
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(&compressed[..])
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(
        decoded.len(),
        wrapper["uncompressedBytes"].as_u64().unwrap() as usize
    );
    assert_eq!(serde_json::from_slice::<Value>(&decoded).unwrap(), payload);
    assert_eq!(
        encode(&payload, false).unwrap(),
        serde_json::to_vec(&payload).unwrap()
    );
    assert_eq!(
        encode(&json!({"id":"small"}), true).unwrap(),
        br#"{"id":"small"}"#
    );
}

#[tokio::test]
async fn navigation_reply_overtakes_bulk_and_cancellation_stops_remaining_chunks() {
    let identity = derive_identity("transport-priority");
    let (sent, mut received) = mpsc::unbounded_channel();
    let sink = Box::pin(futures_util::sink::unfold(
        sent,
        |sent, message| async move {
            sent.send(message).map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(sent)
        },
    ));
    let (outbound, messages) = mpsc::channel(8);
    let (controls, control_messages) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write(
        sink,
        identity.cipher.clone(),
        messages,
        control_messages,
    ));
    let large = Outbound::new(
        "mobile".into(),
        json!({"id":"large", "result":"x".repeat(CHUNK_BYTES * 8)}),
    );
    let cancel = large.cancel.clone();
    outbound.send(large).await.unwrap();
    assert!(matches!(received.recv().await, Some(Message::Text(_))));
    outbound
        .send(Outbound::new(
            "mobile".into(),
            json!({"id":"small", "result":true}),
        ))
        .await
        .unwrap();
    let Message::Text(raw) = tokio::time::timeout(Duration::from_secs(1), received.recv())
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("data frame");
    };
    let frame: Value = serde_json::from_str(&raw).unwrap();
    let payload = decrypt_payload(
        &identity.cipher,
        frame["nonce"].as_str().unwrap(),
        frame["ciphertext"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&payload).unwrap()["id"],
        "small"
    );
    cancel.cancel();
    drop(outbound);
    writer.await.unwrap().unwrap();
    assert!(received.try_recv().is_err());
    drop(controls);
}

#[tokio::test]
async fn large_payload_is_losslessly_chunked_paced_and_keeps_pongs_flowing() {
    let identity = derive_identity("transport-test-key");
    let payload = json!({"id": "req-large", "result": "任务结果".repeat(300_000)});
    let expected = serde_json::to_vec(&payload).unwrap();
    let (sent, mut received) = mpsc::unbounded_channel::<Message>();
    let sink = Box::pin(futures_util::sink::unfold(
        sent,
        |sent, message| async move {
            sent.send(message).map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(sent)
        },
    ));
    let (outbound, messages) = mpsc::channel(4);
    let (controls, control_messages) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write(
        sink,
        identity.cipher.clone(),
        messages,
        control_messages,
    ));
    outbound
        .send(Outbound::new("mobile-test".into(), payload))
        .await
        .unwrap();
    let mut assembled = Vec::new();
    let mut frames = 0;
    while assembled.len() < expected.len() {
        let message = tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .unwrap()
            .unwrap();
        let Message::Text(raw) = message else {
            panic!("expected encrypted data")
        };
        assert!(raw.len() < 2 * 1024 * 1024);
        let frame: Value = serde_json::from_str(&raw).unwrap();
        let plain = decrypt_payload(
            &identity.cipher,
            frame["nonce"].as_str().unwrap(),
            frame["ciphertext"].as_str().unwrap(),
        )
        .unwrap();
        let chunk: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(chunk["index"], frames);
        assert_eq!(chunk["requestId"], "req-large");
        assembled.extend(
            URL_SAFE_NO_PAD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap(),
        );
        frames += 1;
        controls
            .send(Message::Pong(vec![frames as u8].into()))
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_millis(250), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(pong, Message::Pong(_)));
    }
    assert_eq!(assembled, expected);
    assert!(frames > 4);
    drop(controls);
    writer.await.unwrap().unwrap();
}

async fn frame_times(targets: Vec<&'static str>) -> Vec<tokio::time::Instant> {
    let identity = derive_identity("transport-test-key");
    let times = Arc::new(Mutex::new(Vec::new()));
    let recorded = times.clone();
    let sink = futures_util::sink::unfold((), move |(), _message: Message| {
        recorded.lock().unwrap().push(tokio::time::Instant::now());
        async { Ok::<_, std::io::Error>(()) }
    });
    let (outbound, messages) = mpsc::channel(4);
    let (_controls, control_messages) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write(
        Box::pin(sink),
        identity.cipher,
        messages,
        control_messages,
    ));
    for target in targets {
        outbound
            .send(Outbound::new(target.into(), json!({"ok": true})))
            .await
            .unwrap();
    }
    drop(outbound);
    writer.await.unwrap().unwrap();
    let times = times.lock().unwrap().clone();
    times
}

#[tokio::test(start_paused = true)]
async fn normal_rpc_responses_and_event_batches_share_the_same_rate_budget() {
    let start = tokio::time::Instant::now();
    let targets = (0..30)
        .map(|index| {
            if index % 2 == 0 {
                "mobiles"
            } else {
                "mobile-1"
            }
        })
        .collect();
    let times = frame_times(targets).await;
    assert_eq!(times.len(), 30);
    // The burst goes out immediately, then frames follow the refill rate.
    assert!(times[..20].iter().all(|time| *time == start));
    let refill = Duration::from_secs_f64(1.0 / FRAME_REFILL_PER_SECOND);
    let slack = Duration::from_millis(5);
    for pair in times[20..].windows(2) {
        assert!(pair[1].duration_since(pair[0]) + slack >= refill);
    }
    assert!(times[29].duration_since(times[19]) + slack >= refill * 10);
}

#[tokio::test(start_paused = true)]
async fn sustained_frame_rate_stays_within_the_relay_minute_budget() {
    let start = tokio::time::Instant::now();
    let times = frame_times(vec!["mobiles"; 300]).await;
    assert_eq!(times.len(), 300);
    for (index, first) in times.iter().enumerate() {
        let window = times[index..]
            .iter()
            .take_while(|time| time.duration_since(*first) < Duration::from_secs(60))
            .count();
        assert!(window <= 240, "{window} frames inside one relay window");
    }
    let sustained = times[299].duration_since(times[20]).as_secs_f64();
    assert!(279.0 / sustained <= 4.0);
    assert!(times[299].duration_since(start) < Duration::from_secs(90));
}

#[test]
fn socket_write_timeout_scales_with_frame_size_and_is_capped() {
    assert_eq!(send_timeout(0), Duration::from_secs(15));
    assert_eq!(send_timeout(128 * 1024 - 1), Duration::from_secs(15));
    assert_eq!(send_timeout(128 * 1024), Duration::from_secs(20));
    assert_eq!(send_timeout(2 * 1024 * 1024), Duration::from_secs(95));
    assert_eq!(send_timeout(64 * 1024 * 1024), Duration::from_secs(120));
}
