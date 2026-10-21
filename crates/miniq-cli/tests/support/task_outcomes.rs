use super::*;

pub(super) fn saved_failure_reason() -> String {
    format!(
        "{}\nrequest id: historical-request",
        "完整服务商错误详情 ".repeat(1000)
    )
}

#[tokio::test]
async fn reopened_acknowledged_failure_keeps_full_reason_in_every_json_format() {
    for format in ["json", "stream-json"] {
        let fixture = Fixture::new("reconnect-failure").await;
        let result = fixture
            .run(&["exec", "task", "--output-format", format], "")
            .await;
        assert_eq!(result.status.code(), Some(1));
        let text = String::from_utf8(result.stdout).unwrap();
        let value: Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(value["error"], saved_failure_reason());
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "session.sendMessage")
                .count(),
            1
        );
        assert!(requests
            .iter()
            .any(|request| request["method"] == "session.open"));
    }
    let fixture = Fixture::new("failure").await;
    let result = fixture
        .run(&["exec", "task", "--output-format", "json"], "")
        .await;
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["error"], "fixture provider failure");
}

#[tokio::test]
async fn paused_turn_exits_for_input_and_idle_does_not_hide_buffered_completion() {
    for (mode, expected) in [
        ("paused", 3),
        ("idle-completed", 0),
        ("idle-delayed-completed", 0),
    ] {
        let fixture = Fixture::new(mode).await;
        let result = fixture
            .run(&["exec", "task", "--output-format", "json"], "")
            .await;
        assert_eq!(
            result.status.code(),
            Some(expected),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let value: Value = serde_json::from_slice(&result.stdout).unwrap();
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "session.sendMessage")
                .count(),
            1
        );
        if mode == "paused" {
            assert!(String::from_utf8_lossy(&result.stderr).contains("Turn paused"));
            assert!(requests
                .iter()
                .any(|request| request["method"] == "session.open"));
        } else {
            assert_eq!(value["text"], "original completed answer");
            assert_eq!(
                requests
                    .iter()
                    .any(|request| request["method"] == "session.open"),
                mode == "idle-delayed-completed"
            );
        }
    }
}

#[tokio::test]
async fn queued_exec_returns_an_identity_without_waiting_or_writing_an_answer_file() {
    let fixture = Fixture::new("busy-queue").await;
    let output = fixture.dir.path().join("answer.txt");
    let result = fixture
        .run(
            &[
                "exec",
                "--session",
                "session-1",
                "follow up",
                "--on-busy",
                "queue",
                "--output-format",
                "json",
                "-o",
                output.to_str().unwrap(),
            ],
            "",
        )
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["type"], "cli_queued");
    assert_eq!(value["queuedMessageId"], "queued-1");
    assert_eq!(value["status"], "queued");
    assert!(!output.exists());
    assert!(!fixture
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| request["method"] == "session.cancel"));
}
