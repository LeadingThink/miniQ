use super::*;
fn adapt(name: &str, arguments: serde_json::Value) -> Result<AdaptedToolCall, NativeToolError> {
    adapt_native_tool_call(&ToolCallRequest {
        id: "call".into(),
        name: name.into(),
        arguments,
    })
    .map(Option::unwrap)
}
#[test]
fn exec_and_stdin_preserve_millisecond_wait_budget_and_terminal_intent() {
    let call = adapt(
        "exec_command",
        json!({"cmd":"cat","workdir":"src","yield_time_ms":25,"max_output_tokens":1024,"tty":true}),
    )
    .unwrap();
    assert_eq!(
        call.call.arguments,
        json!({"command":"cat","cwd":"src","yieldTimeMs":25,"maxOutputTokens":1024,"tty":true,"interactive":true})
    );
    let input = adapt(
        "write_stdin",
        json!({"session_id":"shell_abc","chars":"x\n","yield_time_ms":0,"max_output_tokens":10}),
    )
    .unwrap();
    assert_eq!(
        input.call.arguments,
        json!({"id":"shell_abc","chars":"x\n","yieldTimeMs":0,"maxOutputTokens":10})
    );
    for extra in [
        json!({"cmd":"cat","login":true}),
        json!({"cmd":"cat","sandbox_permissions":"require_escalated"}),
    ] {
        assert!(adapt("exec_command", extra).is_err());
    }
}
#[test]
fn task_output_routes_agent_and_process_contracts_without_ignoring_wait() {
    let read = adapt("TaskOutput", json!({"task_id":"agent_a","block":false})).unwrap();
    assert_eq!(read.call.name, "agent_result");
    assert_eq!(read.call.arguments, json!({"id":"agent_a"}));
    let wait = adapt(
        "TaskOutput",
        json!({"task_id":"agent_a","block":true,"timeout":1500}),
    )
    .unwrap();
    assert_eq!(wait.call.name, "agent_wait");
    assert_eq!(
        wait.call.arguments,
        json!({"ids":["agent_a"],"timeoutMs":2000})
    );
    assert_eq!(
        adapt("TaskOutput", json!({"task_id":"shell_a"}))
            .unwrap()
            .call
            .name,
        "process_output"
    );
}

#[test]
fn agents_use_explicit_background_creation_and_a_separate_multi_agent_wait() {
    let spawn = adapt(
        "spawn_agent",
        json!({"message":"inspect","agent_type":"explorer","fork_context":false}),
    )
    .unwrap();
    assert_eq!(spawn.call.name, "agent_run");
    assert_eq!(
        spawn.call.arguments,
        json!({"prompt":"inspect","subagentType":"explorer","runInBackground":true})
    );
    let wait = adapt(
        "wait_agent",
        json!({"ids":["agent_a","agent_b"],"timeout_ms":250}),
    )
    .unwrap();
    assert_eq!(wait.call.name, "agent_wait");
    assert_eq!(
        wait.call.arguments,
        json!({"ids":["agent_a","agent_b"],"timeoutMs":250})
    );
    let send = adapt(
        "send_input",
        json!({"id":"agent_a","message":"continue","interrupt":false}),
    )
    .unwrap();
    assert_eq!(
        send.call.arguments,
        json!({"recipient":"agent_a","message":"continue"})
    );
    assert_eq!(
        adapt("close_agent", json!({"id":"agent_a"}))
            .unwrap()
            .call
            .name,
        "process_kill"
    );
    assert!(adapt("spawn_agent", json!({"message":"x","fork_context":true})).is_err());
    assert!(adapt(
        "send_input",
        json!({"id":"agent_a","message":"x","interrupt":true})
    )
    .is_err());
    // Codex v2 mailbox messages do not start work; miniQ followups do. No false alias.
    assert!(canonical_name("send_message").is_none());
    assert!(canonical_name("interrupt_agent").is_none());
}
