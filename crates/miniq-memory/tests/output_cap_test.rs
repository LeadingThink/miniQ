//! Tool output written to the database stays bounded.

use miniq_memory::Store;
use miniq_protocol::ToolCallStatus;
use serde_json::json;

#[test]
fn oversized_tool_output_is_shortened_when_stored() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("/tmp/proj", "proj").unwrap();
    let sess = store.create_session(&ws.id, "t").unwrap();
    let huge = format!("HEAD{}TAIL", "a".repeat(12 * 1024 * 1024));
    let big = store
        .create_tool_call(
            &sess.id,
            "shell_run",
            &json!({}),
            None,
            ToolCallStatus::Running,
        )
        .unwrap();
    store
        .finish_tool_call(
            &big.id,
            ToolCallStatus::Succeeded,
            Some(&json!({"stdout": huge, "exitCode": 0})),
        )
        .unwrap();
    let small = store
        .create_tool_call(
            &sess.id,
            "shell_run",
            &json!({}),
            None,
            ToolCallStatus::Running,
        )
        .unwrap();
    store
        .finish_tool_call(
            &small.id,
            ToolCallStatus::Succeeded,
            Some(&json!({"stdout": "ok", "exitCode": 0})),
        )
        .unwrap();

    let calls = store.list_tool_calls(&sess.id).unwrap();
    let stored_big = calls.iter().find(|c| c.id == big.id).unwrap();
    let output = stored_big.output.as_ref().unwrap();
    let stdout = output["stdout"].as_str().unwrap();
    assert!(
        stdout.len() < 5 * 1024 * 1024,
        "stored {} bytes",
        stdout.len()
    );
    assert!(stdout.starts_with("HEAD") && stdout.ends_with("TAIL"));
    assert_eq!(output["outputTruncated"], true);
    assert_eq!(output["exitCode"], 0);

    let stored_small = calls.iter().find(|c| c.id == small.id).unwrap();
    assert_eq!(
        stored_small.output.as_ref().unwrap(),
        &json!({"stdout": "ok", "exitCode": 0})
    );
}
