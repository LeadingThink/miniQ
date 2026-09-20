//! Local transport tests never read the user's SSH credentials or contact remote servers.

use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[cfg(unix)]
fn fake_bridge() -> tokio::process::Command {
    shell("printf '%s\\n' '{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":2,\"version\":\"test\"}'; while IFS= read -r line; do printf '%s\\n' \"$line\"; done")
}

#[cfg(unix)]
fn shell(script: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

fn url(info: &ConnectionInfo) -> String {
    format!("ws://127.0.0.1:{}/ws?token={}", info.port, info.token)
}

#[tokio::test]
#[cfg(unix)]
async fn proxy_authenticates_forwards_rpc_and_survives_ui_reconnect() {
    let manager = SshConnections::default();
    let info = manager.connect_with("test", fake_bridge()).await.unwrap();
    let wrong = format!("ws://127.0.0.1:{}/ws?token=wrong", info.port);
    assert!(tokio_tungstenite::connect_async(&wrong).await.is_err());
    let (mut socket, _) = tokio_tungstenite::connect_async(url(&info)).await.unwrap();
    let request = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"workspace.list"});
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
    assert_eq!(value["id"], 7);
    assert_eq!(value["method"], "workspace.list");
    let same = manager
        .connect_with("test", shell("exit 99"))
        .await
        .unwrap();
    assert_eq!(same.port, info.port);
    socket.close(None).await.unwrap();
    drop(socket);
    let mut reconnected = None;
    for _ in 0..50 {
        if let Ok(socket) = tokio_tungstenite::connect_async(url(&info)).await {
            reconnected = Some(socket);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(reconnected.is_some());
    manager.disconnect().await;
    assert!(tokio_tungstenite::connect_async(url(&info)).await.is_err());
}

#[tokio::test]
#[cfg(unix)]
async fn failed_replacement_preserves_current_host_and_reports_auth_reason() {
    let manager = SshConnections::default();
    let info = manager
        .connect_with("working", fake_bridge())
        .await
        .unwrap();
    let error = manager
        .connect_with(
            "other",
            shell("printf 'Permission denied (publickey).\\n' >&2; exit 255"),
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("身份验证"));
    let same = manager
        .connect_with("working", shell("exit 99"))
        .await
        .unwrap();
    assert_eq!(same.port, info.port);
    assert!(tokio_tungstenite::connect_async(url(&same)).await.is_ok());
    manager.disconnect().await;
}

#[tokio::test]
#[cfg(unix)]
async fn dead_bridge_reconnects_and_drop_removes_the_private_listener() {
    let manager = SshConnections::default();
    let info = manager.connect_with("test", shell("printf '%s\\n' '{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":2,\"version\":\"test\"}'")).await.unwrap();
    for _ in 0..50 {
        if !manager
            .active
            .lock()
            .await
            .as_ref()
            .unwrap()
            .proxy
            .alive
            .load(Ordering::SeqCst)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let next = manager.connect_with("test", fake_bridge()).await.unwrap();
    assert_ne!(next.token, info.token);
    drop(manager);
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", next.port))
            .await
            .is_err()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("SSH proxy listener survived its manager");
}

#[tokio::test]
#[cfg(unix)]
async fn newer_disconnect_prevents_inflight_connection_from_reactivating() {
    let manager = Arc::new(SshConnections::default());
    let connecting = manager.clone();
    let pending = tokio::spawn(async move {
        connecting.connect_with("old", shell("sleep 0.15; printf '%s\\n' '{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":2,\"version\":\"test\"}'; exec cat")).await
    });
    while manager.generation.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    manager.disconnect().await;
    assert!(pending.await.unwrap().err().unwrap().contains("替代"));
    assert!(manager.active.lock().await.is_none());
}

#[tokio::test]
#[cfg(unix)]
async fn app_exit_blocks_reconnect_without_touching_remote_daemon() {
    let manager = SshConnections::default();
    let info = manager.connect_with("test", fake_bridge()).await.unwrap();
    manager.begin_shutdown();
    manager.disconnect().await;
    assert!(manager
        .connect_with("test", shell("exit 99"))
        .await
        .err()
        .unwrap()
        .contains("退出"));
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", info.port))
        .await
        .is_err());
}

#[tokio::test]
#[cfg(unix)]
async fn newer_host_supersedes_old_startup_without_killing_the_new_host() {
    let manager = Arc::new(SshConnections::default());
    let connecting = manager.clone();
    let pending = tokio::spawn(async move {
        connecting.connect_with("old", shell("sleep 0.1; printf '%s\\n' '{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":2,\"version\":\"test\"}'; exec cat")).await
    });
    while manager.generation.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let newest = manager.connect_with("new", fake_bridge()).await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert_eq!(
        manager.active.lock().await.as_ref().unwrap().info.host,
        "new"
    );
    assert!(tokio_tungstenite::connect_async(url(&newest)).await.is_ok());
    manager.disconnect().await;
}

#[tokio::test]
async fn partial_frame_survives_select_cancellation() {
    use tokio::io::AsyncWriteExt;
    let (mut writer, reader) = tokio::io::duplex(64);
    let mut frames = process::FrameReader::new(tokio::io::BufReader::new(reader));
    writer.write_all(b"{\"id\":").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), frames.next())
            .await
            .is_err()
    );
    writer.write_all(b"1}\n").await.unwrap();
    assert_eq!(frames.next().await.unwrap().unwrap(), "{\"id\":1}");
}

#[tokio::test]
#[cfg(unix)]
async fn delayed_old_socket_response_cannot_resolve_reused_request_id() {
    let manager = SshConnections::default();
    let command = shell("printf '%s\\n' '{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":2,\"version\":\"test\"}'; IFS= read -r first; IFS= read -r second; printf '%s\\n' \"$first\" \"$second\"; exec cat");
    let info = manager.connect_with("test", command).await.unwrap();
    let (mut old, _) = tokio_tungstenite::connect_async(url(&info)).await.unwrap();
    old.send(Message::Text(
        r#"{"jsonrpc":"2.0","id":"req_1","method":"old.request"}"#.into(),
    ))
    .await
    .unwrap();
    old.close(None).await.unwrap();
    drop(old);
    let mut connected = None;
    for _ in 0..50 {
        if let Ok((socket, _)) = tokio_tungstenite::connect_async(url(&info)).await {
            connected = Some(socket);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut new = connected.unwrap();
    new.send(Message::Text(
        r#"{"jsonrpc":"2.0","id":"req_1","method":"new.request"}"#.into(),
    ))
    .await
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), new.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
    assert_eq!(response["id"], "req_1");
    assert_eq!(response["method"], "new.request");
    manager.disconnect().await;
}

#[tokio::test]
#[ignore = "requires scripts/test-ssh-smoke.mjs isolated loopback sshd fixture"]
async fn real_loopback_ssh_bridge() {
    let config = std::env::var("MINIQ_SSH_SMOKE_CONFIG").expect("isolated SSH config path");
    let base = process::ssh_command("miniq-smoke");
    let mut command = tokio::process::Command::new("ssh");
    command.arg("-F").arg(config).args(base.as_std().get_args());
    let manager = SshConnections::default();
    let info = manager.connect_with("miniq-smoke", command).await.unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(url(&info)).await.unwrap();
    for (id, method) in [(1, "daemon.health"), (2, "workspace.list")] {
        socket
            .send(Message::Text(
                serde_json::json!({"jsonrpc":"2.0","id":id,"method":method})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let value: serde_json::Value =
                serde_json::from_str(message.to_text().unwrap()).unwrap();
            if value["id"] != id {
                continue;
            }
            assert!(
                value.get("error").is_none(),
                "unexpected RPC error: {}",
                value["error"]
            );
            break;
        }
    }
    manager.disconnect().await;
}
