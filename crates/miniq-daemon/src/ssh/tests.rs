//! Isolated process fixtures never contact the user's SSH hosts or read keys.

use super::*;
use std::time::Duration;

fn manager() -> (tempfile::TempDir, Arc<SshHostManager>) {
    let directory = tempfile::tempdir().unwrap();
    let manager = Arc::new(SshHostManager::new(
        directory.path(),
        CancellationToken::new(),
    ));
    (directory, manager)
}

async fn save(manager: &Arc<SshHostManager>, host: &str) {
    manager
        .dispatch("host.save", Some(json!({"hostId": host})))
        .await
        .unwrap();
}

#[cfg(unix)]
fn shell(script: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

#[cfg(unix)]
fn ready(script: &str) -> tokio::process::Command {
    shell(&format!("printf '%s\\n' '{{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":{},\"version\":\"test\"}}'; {script}", miniq_protocol::PROTOCOL_VERSION))
}

#[cfg(unix)]
fn echo_bridge() -> tokio::process::Command {
    ready("while IFS= read -r line; do printf '%s\\n' \"$line\" | sed 's/\"method\":/\"result\":/'; done")
}

async fn wait_state(manager: &Arc<SshHostManager>, host: &str, expected: &str) {
    let mut events = manager.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if manager.hosts.get(host).unwrap().snapshot(host)["state"] == expected {
                return;
            }
            events.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn saves_only_targets_and_restart_does_not_connect() {
    let (directory, manager) = manager();
    save(&manager, "user@host").await;
    save(&manager, "alias").await;
    let disk = std::fs::read_to_string(directory.path().join("ssh-hosts.json")).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&disk).unwrap().len(), 2);
    assert!(!disk.contains("token"));
    drop(manager);
    let manager = Arc::new(SshHostManager::new(
        directory.path(),
        CancellationToken::new(),
    ));
    let list = manager.dispatch("host.list", None).await.unwrap();
    assert_eq!(list["hosts"].as_array().unwrap().len(), 2);
    assert!(list["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|host| host["state"] == "disconnected"));
    assert!(manager.call("alias", "session.list", None).await.is_err());
    manager
        .dispatch("host.remove", Some(json!({"hostId":"alias"})))
        .await
        .unwrap();
    assert_eq!(manager.hosts.list().unwrap().len(), 1);
}

#[tokio::test]
async fn invalid_or_corrupt_configuration_is_not_overwritten() {
    let (directory, manager) = manager();
    assert!(manager
        .dispatch("host.save", Some(json!({"hostId":"-oProxyCommand=bad"})))
        .await
        .is_err());
    assert!(!directory.path().join("ssh-hosts.json").exists());
    std::fs::write(directory.path().join("ssh-hosts.json"), "broken").unwrap();
    let manager = Arc::new(SshHostManager::new(
        directory.path(),
        CancellationToken::new(),
    ));
    assert!(manager
        .dispatch("host.save", Some(json!({"hostId":"valid"})))
        .await
        .is_err());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("ssh-hosts.json")).unwrap(),
        "broken"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn only_saved_hosts_connect_and_multiple_hosts_remain_independent() {
    let (_directory, manager) = manager();
    assert!(manager
        .connect_with("unsaved", shell("exit 99"))
        .await
        .unwrap_err()
        .message
        .contains("添加"));
    save(&manager, "one").await;
    save(&manager, "two").await;
    let (one, two) = tokio::join!(
        manager.connect_with("one", echo_bridge()),
        manager.connect_with("two", echo_bridge())
    );
    assert_eq!(one.unwrap()["state"], "connected");
    assert_eq!(two.unwrap()["state"], "connected");
    assert_eq!(
        manager.call("one", "one.request", None).await.unwrap(),
        "one.request"
    );
    assert_eq!(
        manager.call("two", "two.request", None).await.unwrap(),
        "two.request"
    );
    // Reusing a live connection never launches the supplied replacement process.
    assert!(manager.connect_with("one", shell("exit 99")).await.is_ok());
    manager
        .dispatch("host.disconnect", Some(json!({"hostId":"one"})))
        .await
        .unwrap();
    assert!(manager.call("one", "daemon.health", None).await.is_err());
    assert_eq!(
        manager.call("two", "daemon.health", None).await.unwrap(),
        "daemon.health"
    );
    for method in [
        "host.call",
        "host.connect",
        "daemon.shutdown",
        "daemon.shutdownIfIdle",
    ] {
        assert_eq!(
            manager.call("two", method, None).await.unwrap_err().code,
            ErrorCode::Unauthorized as i64
        );
    }
}

#[tokio::test]
#[cfg(unix)]
async fn out_of_order_responses_use_unique_ids_and_events_keep_host_scope() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    let mut events = manager.subscribe();
    manager.connect_with("one", ready("printf '%s\\n' '{\"type\":\"turn_completed\",\"sessionId\":\"same-id\"}'; IFS= read -r first; IFS= read -r second; printf '%s\\n' \"$second\" \"$first\" | sed 's/\"method\":/\"result\":/'; exec cat")).await.unwrap();
    let (a, b) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(
            manager.call("one", "first.request", None),
            manager.call("one", "second.request", None)
        )
    })
    .await
    .unwrap();
    assert_eq!(a.unwrap(), "first.request");
    assert_eq!(b.unwrap(), "second.request");
    let event = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "host_event" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event["hostId"], "one");
    assert_eq!(event["event"]["sessionId"], "same-id");
}

#[tokio::test]
#[cfg(unix)]
async fn cancelled_connect_cannot_reactivate_and_does_not_block_other_hosts() {
    let (_directory, manager) = manager();
    save(&manager, "slow").await;
    save(&manager, "fast").await;
    let start = manager.clone();
    let pending = tokio::spawn(async move { start.connect_with("slow", shell("exec cat")).await });
    wait_state(&manager, "slow", "connecting").await;
    tokio::time::timeout(
        Duration::from_secs(3),
        manager.connect_with("fast", echo_bridge()),
    )
    .await
    .unwrap()
    .unwrap();
    manager
        .dispatch("host.disconnect", Some(json!({"hostId":"slow"})))
        .await
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert_eq!(
        manager.hosts.get("slow").unwrap().snapshot("slow")["state"],
        "disconnected"
    );
    assert_eq!(
        manager.call("fast", "daemon.health", None).await.unwrap(),
        "daemon.health"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn queued_connect_cannot_override_newer_disconnect() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    let entry = manager.hosts.get("one").unwrap();
    let gate = entry.connect_gate.lock().await;
    let pending = manager.connect_with("one", echo_bridge());
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    manager
        .dispatch("host.disconnect", Some(json!({"hostId":"one"})))
        .await
        .unwrap();
    drop(gate);
    assert!(pending.await.unwrap_err().message.contains("替代"));
    assert_eq!(entry.snapshot("one")["state"], "disconnected");
}

#[tokio::test]
#[cfg(unix)]
async fn shutdown_during_startup_restores_disconnected_state() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    let pending = manager.connect_with("one", shell("exec cat"));
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    assert_eq!(
        manager.hosts.get("one").unwrap().snapshot("one")["state"],
        "connecting"
    );
    manager.shutdown.cancel();
    assert!(pending.await.is_err());
    assert_eq!(
        manager.hosts.get("one").unwrap().snapshot("one")["state"],
        "disconnected"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn removal_and_dropped_startup_do_not_leave_a_connecting_host() {
    let (_directory, manager) = manager();
    save(&manager, "slow").await;
    let start = manager.clone();
    let pending = tokio::spawn(async move { start.connect_with("slow", shell("exec cat")).await });
    wait_state(&manager, "slow", "connecting").await;
    pending.abort();
    let _ = pending.await;
    assert_eq!(
        manager.hosts.get("slow").unwrap().snapshot("slow")["state"],
        "disconnected"
    );
    let start = manager.clone();
    let pending = tokio::spawn(async move { start.connect_with("slow", shell("exec cat")).await });
    wait_state(&manager, "slow", "connecting").await;
    manager
        .dispatch("host.remove", Some(json!({"hostId":"slow"})))
        .await
        .unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(manager.hosts.get("slow").is_err());
}

#[tokio::test]
#[cfg(unix)]
async fn failed_host_preserves_other_hosts_and_auth_error_is_sanitized() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    save(&manager, "bad").await;
    manager.connect_with("one", echo_bridge()).await.unwrap();
    let error = manager
        .connect_with(
            "bad",
            shell("printf 'private secret\\nPermission denied (publickey).\\n' >&2; exit 255"),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("身份验证"));
    assert!(!error.message.contains("private secret"));
    assert_eq!(
        manager.hosts.get("bad").unwrap().snapshot("bad")["state"],
        "error"
    );
    assert_eq!(
        manager.call("one", "daemon.health", None).await.unwrap(),
        "daemon.health"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn dead_transport_fails_pending_without_replay_and_can_reconnect() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    manager
        .connect_with("one", ready("IFS= read -r line; exit 0"))
        .await
        .unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(3),
        manager.call("one", "session.sendMessage", None),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.message.contains("未自动重发"));
    wait_state(&manager, "one", "error").await;
    manager.connect_with("one", echo_bridge()).await.unwrap();
    assert_eq!(
        manager.call("one", "daemon.health", None).await.unwrap(),
        "daemon.health"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn daemon_shutdown_cancels_connections_and_prevents_new_startup() {
    let (_directory, manager) = manager();
    save(&manager, "one").await;
    manager.connect_with("one", echo_bridge()).await.unwrap();
    manager.shutdown.cancel();
    assert!(manager.call("one", "daemon.health", None).await.is_err());
    assert!(manager
        .connect_with("one", echo_bridge())
        .await
        .unwrap_err()
        .message
        .contains("退出"));
}

#[tokio::test]
async fn partial_frame_survives_cancelled_read() {
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
