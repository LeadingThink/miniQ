use super::*;
use serde_json::Value;

fn call(name: &str, arguments: Value) -> ToolCallRequest {
    ToolCallRequest {
        id: "provider-call-id".into(),
        name: name.into(),
        arguments,
    }
}

#[test]
fn maps_claude_file_tools_and_preserves_call_id() {
    let adapted = adapt_native_tool_call(&call(
        "Edit",
        json!({"file_path":"a.md","old_string":"a","new_string":"b","replace_all":true}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(adapted.call.id, "provider-call-id");
    assert_eq!(adapted.call.name, "file_edit");
    assert_eq!(adapted.call.arguments["path"], "a.md");
    assert_eq!(adapted.call.arguments["replaceAll"], true);
}

#[test]
fn converts_read_view_range_without_losing_boundaries() {
    let adapted = adapt_native_tool_call(&call(
        "Read",
        json!({"file_path":"a.md","view_range":[4, 9]}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(
        adapted.call.arguments,
        json!({"path":"a.md","offset":4,"limit":6})
    );
}

#[test]
fn routes_native_document_reads_and_pdf_pages() {
    let pdf = adapt_native_tool_call(&call(
        "Read",
        json!({"file_path":"report.PDF","pages":"1-3,5"}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(pdf.call.name, "doc_read");
    assert_eq!(pdf.call.arguments["pages"], "1-3,5");

    let docx = adapt_native_tool_call(&call(
        "Read",
        json!({"file_path":"report.docx","view_range":[4, 9]}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(docx.call.name, "doc_read");
    assert_eq!(docx.call.arguments["lineOffset"], 4);
    assert_eq!(docx.call.arguments["lineLimit"], 6);
}

#[test]
fn refuses_native_sandbox_bypass_and_maps_background_mode() {
    let bypass = adapt_native_tool_call(&call(
        "Bash",
        json!({"command":"pwd","dangerouslyDisableSandbox":true}),
    ))
    .unwrap_err();
    assert_eq!(bypass.code, "unsupported_native_tool_feature");

    let background = adapt_native_tool_call(&call(
        "Bash",
        json!({"command":"pwd","run_in_background":true}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(background.call.name, "shell_run");
    assert_eq!(background.call.arguments["runInBackground"], true);
}

#[test]
fn maps_native_background_process_controls() {
    let output = adapt_native_tool_call(&call(
        "TaskOutput",
        json!({"task_id":"shell-1","block":true,"timeout":10}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(output.call.name, "process_output");
    assert_eq!(output.call.arguments["id"], "shell-1");
    assert_eq!(output.call.arguments["timeoutSecs"], 1);

    let kill = adapt_native_tool_call(&call("KillShell", json!({"shell_id":"shell-1"})))
        .unwrap()
        .unwrap();
    assert_eq!(kill.call.name, "process_kill");
    assert_eq!(kill.call.arguments["id"], "shell-1");
}

#[test]
fn maps_claude_search_and_question_shapes() {
    let grep = adapt_native_tool_call(&call(
        "Grep",
        json!({"pattern":"TODO","output_mode":"content","head_limit":25,"-i":true}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(grep.call.name, "file_grep");
    assert_eq!(grep.call.arguments["maxResults"], 25);
    assert_eq!(grep.call.arguments["caseInsensitive"], true);

    let typed = adapt_native_tool_call(&call(
        "Grep",
        json!({"pattern":"unsafe","type":"rust","-C":2}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(typed.call.arguments["glob"], "*.rs");
    assert_eq!(typed.call.arguments["beforeContext"], 2);
    assert_eq!(typed.call.arguments["afterContext"], 2);

    let question = adapt_native_tool_call(&call(
        "AskUserQuestion",
        json!({"questions":[{"question":"Pick","header":"Mode","multiSelect":true,"options":[{"label":"A","description":"first"},{"label":"B","description":"second"}]}]}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(
        question.call.arguments["questions"][0]["options"],
        json!(["A", "B"])
    );
    assert_eq!(question.call.arguments["questions"][0]["multiSelect"], true);
}

#[test]
fn search_web_alias_preserves_every_advertised_parameter() {
    let adapted = adapt_native_tool_call(&call(
        "search_web",
        json!({
            "query": "miniQ",
            "maxResults": 3,
            "allowedDomains": ["example.com"],
            "blockedDomains": ["blocked.example"],
            "provider": "bing"
        }),
    ))
    .unwrap()
    .unwrap();

    assert_eq!(adapted.call.name, "web_search");
    assert_eq!(adapted.call.arguments["query"], "miniQ");
    assert_eq!(adapted.call.arguments["maxResults"], 3);
    assert_eq!(adapted.call.arguments["allowedDomains"][0], "example.com");
    assert_eq!(
        adapted.call.arguments["blockedDomains"][0],
        "blocked.example"
    );
    assert_eq!(adapted.call.arguments["provider"], "bing");
}

#[test]
fn maps_openai_commands_plans_and_native_mcp_names() {
    let command = adapt_native_tool_call(&call(
        "exec_command",
        json!({"cmd":"cargo check","workdir":"crates","yield_time_ms":10000}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(command.call.name, "shell_run");
    assert_eq!(command.call.arguments["cwd"], "crates");

    let plan = adapt_native_tool_call(&call(
        "update_plan",
        json!({"plan":[{"step":"Test","status":"in_progress"}]}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(plan.call.arguments["tasks"][0]["content"], "Test");

    let mcp = adapt_native_tool_call(&call("mcp__github__search_code", json!({"q":"x"})))
        .unwrap()
        .unwrap();
    assert_eq!(mcp.call.name, "mcp_call");
    assert_eq!(mcp.call.arguments["server"], "github");
    assert_eq!(mcp.call.arguments["tool"], "search_code");
}

#[test]
fn rejects_conflicting_arguments_and_maps_agent_orchestration() {
    let conflict =
        adapt_native_tool_call(&call("Read", json!({"file_path":"a","path":"b"}))).unwrap_err();
    assert_eq!(conflict.code, "invalid_native_tool_input");

    let task = adapt_native_tool_call(&call(
        "Task",
        json!({"prompt":"work","subagent_type":"Explore","run_in_background":true,"isolation":"worktree"}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(task.call.name, "agent_run");
    assert_eq!(task.call.arguments["subagentType"], "Explore");
    assert_eq!(task.call.arguments["runInBackground"], true);
    assert_eq!(task.call.arguments["isolation"], "worktree");

    let stop = adapt_native_tool_call(&call("TaskStop", json!({"task_id":"agent-1"})))
        .unwrap()
        .unwrap();
    assert_eq!(stop.call.name, "process_kill");
    assert_eq!(stop.call.arguments["id"], "agent-1");
}

#[test]
fn maps_claude_task_graph_messages_and_plan_mode() {
    let create = adapt_native_tool_call(&call(
        "TaskCreate",
        json!({"subject":"Build","description":"Build app","activeForm":"Building"}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(create.call.name, "task_create");
    assert_eq!(create.call.arguments["activeForm"], "Building");

    let update = adapt_native_tool_call(&call(
        "TaskUpdate",
        json!({"taskId":"1","status":"in_progress","addBlockedBy":["2"]}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(update.call.name, "task_item_update");
    assert_eq!(update.call.arguments["addBlockedBy"], json!(["2"]));

    let message = adapt_native_tool_call(&call(
        "SendMessage",
        json!({"to":"researcher","message":"Return findings","summary":"Need findings"}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(message.call.name, "agent_message");
    assert_eq!(message.call.arguments["recipient"], "researcher");

    let enter = adapt_native_tool_call(&call("EnterPlanMode", json!({})))
        .unwrap()
        .unwrap();
    assert_eq!(enter.call.arguments, json!({"action":"enter"}));
}

#[test]
fn passes_skill_arguments_through_to_the_canonical_tool() {
    let skill = adapt_native_tool_call(&call(
        "Skill",
        json!({"skill":"release-check","args":"--dry-run"}),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(skill.call.arguments["name"], "release-check");
    assert_eq!(skill.call.arguments["args"], "--dry-run");
}
