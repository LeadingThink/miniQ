use super::*;
use crate::remote::{decrypt_payload, derive_identity};
use std::sync::{Arc, Mutex};

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
        .send(Outbound {
            target: "mobile-test".into(),
            payload,
        })
        .await
        .unwrap();
    let mut assembled = Vec::new();
    let mut last_frame = None;
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
        if let Some(last) = last_frame {
            assert!(tokio::time::Instant::now().duration_since(last) >= FRAME_INTERVAL);
        }
        last_frame = Some(tokio::time::Instant::now());
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

#[tokio::test]
async fn normal_rpc_responses_and_event_batches_share_the_same_rate_budget() {
    let identity = derive_identity("transport-test-key");
    let times = Arc::new(Mutex::new(Vec::new()));
    let recorded = times.clone();
    let sink = futures_util::sink::unfold((), move |(), _message: Message| {
        recorded.lock().unwrap().push(tokio::time::Instant::now());
        async { Ok::<_, std::io::Error>(()) }
    });
    let (outbound, messages) = mpsc::channel(4);
    let (controls, control_messages) = mpsc::unbounded_channel();
    for target in ["mobiles", "mobile-1", "mobiles"] {
        outbound
            .send(Outbound {
                target: target.into(),
                payload: json!({"ok": true}),
            })
            .await
            .unwrap();
    }
    drop(outbound);
    write(Box::pin(sink), identity.cipher, messages, control_messages)
        .await
        .unwrap();
    drop(controls);
    let times = times.lock().unwrap();
    assert_eq!(times.len(), 3);
    assert!(times
        .windows(2)
        .all(|pair| pair[1].duration_since(pair[0]) >= FRAME_INTERVAL));
}
