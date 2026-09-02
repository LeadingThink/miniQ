use miniq_models::mock::MockProvider;
use miniq_models::ChatDelta;
use serde_json::{json, Value};

use crate::support::{call, connect, next_event_of, setup_session, start, tool_call};

#[tokio::test]
async fn readonly_tool_runs_without_approval() {
    let provider = MockProvider::new(vec![
        vec![
            ChatDelta::Text("I'll read it first.".into()),
            tool_call("c1", "file_read", json!({"path": "hello.txt"})),
        ],
        vec![ChatDelta::Text("the file says hi".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hi from disk").unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "read hello.txt"}}),
    )
    .await;

    let user_created = next_event_of(&mut ws, "message_created").await;
    assert_eq!(user_created["message"]["role"], "user");

    let intermediate = next_event_of(&mut ws, "message_created").await;
    assert_eq!(intermediate["message"]["role"], "assistant");
    assert_eq!(intermediate["message"]["content"], "I'll read it first.");

    let started = next_event_of(&mut ws, "tool_call_started").await;
    assert_eq!(started["toolName"], "file_read");

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    assert_eq!(finished["output"]["content"], "hi from disk");

    let created = next_event_of(&mut ws, "message_created").await;
    assert_eq!(created["message"]["content"], "the file says hi");
    next_event_of(&mut ws, "turn_completed").await;

    // Tool call persisted.
    let response = call(
        &mut ws,
        "r2",
        "session.open",
        json!({"sessionId": session_id}),
    )
    .await;
    let calls = response["result"]["toolCalls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["toolName"], "file_read");
    assert_eq!(calls[0]["status"], "succeeded");
    let messages = response["result"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["content"], "I'll read it first.");
    assert_eq!(messages[2]["content"], "the file says hi");
}

/// M1 acceptance: locate a file in an unknown directory (glob), find the
/// broken content (grep), fix it with a unique-match edit (approved), and
/// report back — the full "find and fix" loop.
#[tokio::test]
async fn locate_and_edit_in_unknown_directory() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "file_glob", json!({"pattern": "**/*.md"}))],
        vec![tool_call("c2", "file_grep", json!({"pattern": "TODO"}))],
        vec![tool_call(
            "c3",
            "file_edit",
            json!({"path": "notes/plan.md", "oldString": "TODO: fill in", "newString": "Done."}),
        )],
        vec![ChatDelta::Text("fixed the TODO".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("notes")).unwrap();
    std::fs::write(dir.path().join("notes/plan.md"), "# Plan\nTODO: fill in\n").unwrap();
    std::fs::write(dir.path().join("readme.txt"), "not markdown").unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "finish the plan"}}),
    )
    .await;

    // glob + grep run without approval (low risk).
    let first = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(first["status"], "succeeded");
    assert_eq!(first["output"]["files"][0], "notes/plan.md");
    let second = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(second["status"], "succeeded");
    assert_eq!(second["output"]["matches"][0]["line"], 2);

    // edit is medium risk -> auto-approved in the default mode.
    let third = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(third["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(),
        "# Plan\nDone.\n"
    );
}

#[tokio::test]
async fn tool_list_reports_toolset() {
    let (port, token) = start(MockProvider::text("x")).await;
    let mut ws = connect(port, &token).await;
    let response = call(&mut ws, "r1", "tool.list", Value::Null).await;
    let names: Vec<&str> = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "ask_user",
            "doc_read",
            "doc_write",
            "file_edit",
            "file_glob",
            "file_grep",
            "file_list",
            "file_patch",
            "file_read",
            "file_write",
            "git_diff",
            "git_status",
            "http_request",
            "mcp_call",
            "memory_search",
            "memory_write",
            "shell_run",
            "skill_read",
            "task_update",
            "web_fetch",
            "web_search",
        ]
    );
}
