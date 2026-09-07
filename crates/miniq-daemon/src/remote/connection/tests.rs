use super::*;
use miniq_memory::Store;
use miniq_models::{mock::MockProvider, ProviderConfig};
use miniq_protocol::{Event, Role};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    accept_async_with_config, tungstenite::protocol::WebSocketConfig, WebSocketStream,
};

type Socket = WebSocketStream<TcpStream>;

async fn start() -> (AppState, Socket, JoinHandle<anyhow::Result<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote = RemoteAccessSettings {
        enabled: true,
        relay_url: format!("ws://{}/ws", listener.local_addr().unwrap()),
        ..RemoteAccessSettings::default()
    };
    let state = AppState::new(
        Store::open_in_memory().unwrap(),
        "test".into(),
        Arc::new(MockProvider::text("unused")),
    );
    let config = ActiveConfig::new(remote.clone(), "test-key".into());
    {
        let mut settings = state.settings.lock().unwrap();
        settings.remote_access = remote;
        settings.provider = Some(ProviderConfig {
            base_url: "http://unused.invalid".into(),
            api_key: "test-key".into(),
            model: "test".into(),
            api_protocol: Default::default(),
            reasoning_effort: None,
        });
    }
    let connected = state.clone();
    let task = tokio::spawn(async move { run(&connected, &config).await });
    let (stream, _) = listener.accept().await.unwrap();
    // Mirror the production relay's hard message limit.
    let mut socket = accept_async_with_config(
        stream,
        Some(WebSocketConfig::default().max_message_size(Some(2 * 1024 * 1024))),
    )
    .await
    .unwrap();
    next(&mut socket).await;
    socket
        .send(Message::Text(
            json!({"type":"ready","desktopOnline":true,"mobileClients":1})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    (state, socket, task)
}

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn request(socket: &mut Socket, id: &str, method: &str, params: Value) {
    let identity = derive_identity("test-key");
    let raw = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .unwrap();
    let (nonce, ciphertext) = encrypt_payload(&identity.cipher, &raw).unwrap();
    socket
        .send(Message::Text(
            json!({"type":"frame","source":"mobile-test","nonce":nonce,"ciphertext":ciphertext})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

fn decrypted(message: Message) -> Value {
    let Message::Text(raw) = message else {
        panic!("expected encrypted frame")
    };
    assert!(raw.len() < 2 * 1024 * 1024);
    let frame: Value = serde_json::from_str(&raw).unwrap();
    let identity = derive_identity("test-key");
    serde_json::from_slice(
        &decrypt_payload(
            &identity.cipher,
            frame["nonce"].as_str().unwrap(),
            frame["ciphertext"].as_str().unwrap(),
        )
        .unwrap(),
    )
    .unwrap()
}

async fn next_payload(socket: &mut Socket) -> Value {
    loop {
        let message = next(socket).await;
        if matches!(message, Message::Pong(_)) {
            continue;
        }
        return decrypted(message);
    }
}

#[tokio::test]
async fn opening_a_large_failed_session_keeps_the_socket_and_heartbeat_alive() {
    let (state, mut socket, task) = start().await;
    let workspace = state.store.create_workspace("/tmp", "test").unwrap();
    let session = state
        .store
        .create_session(&workspace.id, "large failed task")
        .unwrap();
    let content = "长任务结果".repeat(250_000);
    state
        .store
        .append_message(&session.id, Role::Assistant, &content)
        .unwrap();
    state
        .store
        .update_session_status(&session.id, miniq_protocol::SessionStatus::Failed)
        .unwrap();
    request(
        &mut socket,
        "large",
        "session.open",
        json!({"sessionId": session.id}),
    )
    .await;
    let mut bytes = Vec::new();
    let mut index = 0;
    loop {
        let chunk = next_payload(&mut socket).await;
        assert_eq!(chunk["type"], "remote_chunk");
        assert_eq!(chunk["index"], index);
        assert_eq!(chunk["requestId"], "large");
        bytes.extend(
            URL_SAFE_NO_PAD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap(),
        );
        if bytes.len() == chunk["totalBytes"].as_u64().unwrap() as usize {
            break;
        }
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        assert!(matches!(next(&mut socket).await, Message::Pong(_)));
        index += 1;
    }
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["result"]["session"]["status"], "failed");
    assert_eq!(response["result"]["messages"][0]["content"], content);
    request(&mut socket, "health", "daemon.health", Value::Null).await;
    assert_eq!(next_payload(&mut socket).await["id"], "health");
    state.shutdown.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn rapid_task_events_are_batched_instead_of_consuming_the_relay_frame_budget() {
    let (state, mut socket, task) = start().await;
    request(&mut socket, "ready", "daemon.health", Value::Null).await;
    assert_eq!(decrypted(next(&mut socket).await)["id"], "ready");
    for i in 0..300 {
        state.emit(Event::AssistantDelta {
            session_id: "running".into(),
            message_id: "stream".into(),
            delta: format!("{i},"),
        });
        tokio::task::yield_now().await;
    }
    let mut events = Vec::new();
    let mut frames = 0;
    while events.len() < 300 {
        let batch = decrypted(next(&mut socket).await);
        events.extend(batch["items"].as_array().unwrap().clone());
        frames += 1;
    }
    assert!(frames < 10);
    assert_eq!(events.len(), 300);
    assert_eq!(events[299]["delta"], "299,");
    state.shutdown.cancel();
    task.await.unwrap().unwrap();
}
