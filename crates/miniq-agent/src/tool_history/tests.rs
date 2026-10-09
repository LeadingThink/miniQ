use super::*;

struct Tools;
#[async_trait]
impl ToolExecutor for Tools {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "read".into(),
            description: "Read".into(),
            parameters: json!({"type":"object"}),
        }]
    }
    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        Ok(json!({"ok":true}))
    }
}

fn history() -> Vec<ChatMessage> {
    let mut assistant = ChatMessage::assistant("");
    assistant.tool_calls.push(ToolCallRequest {
        id: "call-1".into(),
        name: "read".into(),
        arguments: json!({"path":"evidence.txt"}),
    });
    vec![
        ChatMessage::system("runtime"),
        ChatMessage::user("inspect"),
        assistant,
        ChatMessage::tool_result("call-1", "甲乙丙🙂\nabcdef"),
    ]
}

#[test]
fn archive_survives_repeated_compaction_and_runtime_prefix_replacement() {
    let mut messages = history();
    let archive = collect_tool_archive(&messages);
    attach_tool_archive(&mut messages, archive);
    messages.remove(0); // daemon rebuilds runtime instructions on resume
    messages.insert(0, ChatMessage::system("refreshed runtime"));
    let persisted = serde_json::to_string(&messages).unwrap();
    let mut resumed: Vec<ChatMessage> = serde_json::from_str(&persisted).unwrap();
    resumed.last_mut().unwrap().content = json!({"compacted":true}).to_string();
    let archive = collect_tool_archive(&resumed);
    assert_eq!(archive.len(), 1);
    assert_eq!(archive[0].content, "甲乙丙🙂\nabcdef");
    attach_tool_archive(&mut resumed, archive);
    let executor = ToolHistoryExecutor::new(&Tools, true);
    executor.sync(&resumed);
    let listed = executor
        .result(&json!({"action":"list","limit":1}))
        .unwrap();
    assert_eq!(listed["results"][0]["toolCallId"], "call-1");
    assert_eq!(listed["results"][0]["tool"], "read");
}

#[test]
fn unicode_pages_recover_every_character_without_cross_conversation_access() {
    let executor = ToolHistoryExecutor::new(&Tools, true);
    let mut messages = history();
    let archive = collect_tool_archive(&messages);
    attach_tool_archive(&mut messages, archive);
    executor.sync(&messages);
    let mut offset = 0;
    let mut recovered = String::new();
    loop {
        let page = executor
            .result(&json!({"action":"read","toolCallId":"call-1","offset":offset,"length":2}))
            .unwrap();
        assert_eq!(page["arguments"]["path"], "evidence.txt");
        recovered.push_str(page["content"].as_str().unwrap());
        let Some(next) = page["next_offset"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(recovered, "甲乙丙🙂\nabcdef");
    assert!(executor
        .result(&json!({"action":"read","toolCallId":"other-call"}))
        .is_err());
    assert!(executor
        .result(&json!({"action":"list","limit":0}))
        .is_err());
    assert!(executor
        .result(&json!({"action":"read","toolCallId":"call-1","length":20001}))
        .is_err());
    assert!(ToolHistoryExecutor::new(&Tools, true)
        .result(&json!({"action":"read","toolCallId":"call-1"}))
        .is_err());
}

#[tokio::test]
async fn native_compaction_retires_old_input_and_preserves_latest_tool_pair() {
    use miniq_models::{mock::MockProvider, ApiProtocol, ChatDelta, ProviderContext};
    let call = ToolCallRequest {
        id: "call-2".into(),
        name: "read".into(),
        arguments: json!({}),
    };
    let native = ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!([
            {"type":"reasoning","encrypted_content":"obsolete"},
            {"type":"compaction","id":"cmp-1","encrypted_content":"opaque"},
            {"type":"function_call","call_id":"call-2","name":"read","arguments":"{}"}
        ]),
    };
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(call), ChatDelta::Context(native)],
        vec![ChatDelta::Text("finished".into())],
    ]);
    let (events, mut receiver) = tokio::sync::mpsc::channel(32);
    let outcome = crate::run_turn(
        &provider,
        &Tools,
        history(),
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].messages[0].content,
        requests[1].messages[0].content
    );
    let next = &requests[1].messages;
    assert!(!next.iter().any(|m| m.content == "inspect"));
    let context = next
        .iter()
        .find_map(|m| m.provider_context.as_ref())
        .unwrap();
    assert_eq!(context.data[0]["type"], "compaction");
    assert_eq!(context.data[0]["encrypted_content"], "opaque");
    assert!(next
        .iter()
        .any(|m| m.tool_call_id.as_deref() == Some("call-2")));
    let archived = collect_tool_archive(&outcome.provider_history);
    assert!(archived
        .iter()
        .any(|r| r.id == "call-1" && r.content == "甲乙丙🙂\nabcdef"));
    let mut compactions = 0;
    while let Ok(event) = receiver.try_recv() {
        if matches!(event, crate::AgentEvent::ContextCompacted { .. }) {
            compactions += 1;
        }
    }
    assert_eq!(compactions, 1);
    assert_eq!(outcome.final_text, "finished");
}
