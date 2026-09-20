use super::*;
use miniq_models::{mock::MockProvider, ChatDelta, ChatRole};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Executor {
    recorded: Mutex<Vec<Value>>,
}

#[async_trait]
impl ToolExecutor for Executor {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "view_image".into(),
            description: "Inspect".into(),
            parameters: json!({"type":"object"}),
        }]
    }
    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        panic!("history reads must not dispatch filesystem tools")
    }
    async fn record_image_history(
        &self,
        _: &ToolCallRequest,
        output: &Value,
    ) -> Result<(), AgentError> {
        self.recorded.lock().unwrap().push(output.clone());
        Ok(())
    }
}

fn image(path: &str) -> ChatImage {
    ChatImage {
        path: path.into(),
        mime_type: "image/png".into(),
        detail: ImageDetail::High,
    }
}

fn history() -> Vec<ChatMessage> {
    let mut messages = vec![
        ChatMessage::system("test policy"),
        ChatMessage::user("compare the diagrams"),
    ];
    for batch in 1..=4 {
        let id = format!("call-{batch}");
        let mut call = ChatMessage::assistant("");
        call.tool_calls.push(ToolCallRequest {
            id: id.clone(),
            name: "view_image".into(),
            arguments: json!({"path":format!("diagram-{batch}.png")}),
        });
        let mut result = ChatMessage::tool_result(
            id,
            json!({"page": batch, "screenshot":{"id":format!("observation-{batch}")}}).to_string(),
        );
        result
            .images
            .push(image(&format!("/private/observation-{batch}.png")));
        messages.extend([call, result]);
    }
    messages
}

fn call(arguments: Value) -> ToolCallRequest {
    ToolCallRequest {
        id: "recall-call".into(),
        name: TOOL_NAME.into(),
        arguments,
    }
}

#[tokio::test]
async fn list_is_paginated_and_read_is_scoped_without_arbitrary_paths() {
    let inner = Executor::default();
    let executor = ImageHistoryExecutor::new(&inner, &history());
    let first = executor
        .execute(&call(json!({"action":"list","limit":2})))
        .await
        .unwrap();
    assert_eq!(first["total"], 4);
    assert_eq!(first["images"].as_array().unwrap().len(), 2);
    assert_eq!(first["next_offset"], 2);
    assert_eq!(first["images"][0]["source_count"], 1);
    assert!(first["images"][0].get("sources").is_none());
    let sources = executor
        .execute(&call(json!({"action":"sources","id":"img_1"})))
        .await
        .unwrap();
    assert_eq!(sources["sources"][0]["tool_name"], "view_image");
    assert!(sources["sources"][0]["source_content"]
        .as_str()
        .unwrap()
        .contains("observation-1"));
    let last = executor
        .execute(&call(json!({"action":"list","offset":2,"limit":2})))
        .await
        .unwrap();
    assert!(last["next_offset"].is_null());
    assert_eq!(last["images"][1]["id"], "img_4");
    let read = call(json!({"action":"read","ids":["img_1","img_4"]}));
    let output = executor.execute(&read).await.unwrap();
    let pixels = executor.result_images(&read, &output);
    assert_eq!(
        pixels,
        vec![
            image("/private/observation-1.png"),
            image("/private/observation-4.png")
        ]
    );
    assert!(output.get("sources").is_none());
    assert!(output.get("screenshot").is_none());
    for arguments in [
        json!({"action":"read","ids":["img_999"]}),
        json!({"action":"read","ids":["/private/other-session.png"]}),
        json!({"action":"read","ids":["img_1"],"path":"/etc/passwd"}),
        json!({"action":"read","ids":[]}),
        json!({"action":"read","ids":["img_1"],"detail":"low"}),
        json!({"action":"list","limit":0}),
        json!({"action":"list","offset":5}),
        json!({"action":"list","limit":51}),
    ] {
        let rejected = call(arguments);
        let output = executor.execute(&rejected).await.unwrap();
        assert!(output.get("error").is_some(), "{output}");
        assert!(executor.result_images(&rejected, &output).is_empty());
    }
    let empty = ImageHistoryExecutor::new(&inner, &[ChatMessage::user("separate conversation")]);
    assert!(empty.execute(&read).await.unwrap().get("error").is_some());
    assert!(!inner.recorded.lock().unwrap().is_empty());
}

#[tokio::test]
async fn runner_retires_old_pixels_then_recalls_them_without_changing_original_history() {
    let original = history();
    let before = serde_json::to_value(&original).unwrap();
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(call(
            json!({"action":"read","ids":["img_1","img_2"]}),
        ))],
        vec![ChatDelta::Text("Compared the actual diagrams.".into())],
    ]);
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let outcome = crate::run_turn(
        &provider,
        &Executor::default(),
        original.clone(),
        tx,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(
        requests[0]
            .messages
            .iter()
            .map(|message| message.images.len())
            .sum::<usize>(),
        2
    );
    let read = requests[1]
        .messages
        .iter()
        .find(|message| message.tool_call_id.as_deref() == Some("recall-call"))
        .unwrap();
    assert_eq!(read.images.len(), 2);
    assert_eq!(read.images[0].path, "/private/observation-1.png");
    assert!(requests.iter().all(|request| request
        .messages
        .iter()
        .all(|message| message.image_archive.is_empty())));
    assert!(requests[0].tools.iter().any(|tool| tool.name == TOOL_NAME));
    assert_eq!(serde_json::to_value(original).unwrap(), before);
    for batch in 1..=4 {
        let id = format!("call-{batch}");
        assert_eq!(
            outcome
                .provider_history
                .iter()
                .find(|message| message.tool_call_id.as_deref() == Some(&id))
                .unwrap()
                .images
                .len(),
            1
        );
    }
    assert_eq!(
        VisualHistory::from_messages(&outcome.provider_history)
            .entries()
            .len(),
        4
    );
}

#[tokio::test]
async fn compaction_does_not_entrust_the_visual_archive_to_a_text_summary() {
    let inner = Executor::default();
    let mut original = history();
    let mut user = ChatMessage::user("original references");
    user.images = vec![image("/attachment/reference.png")];
    original.insert(2, user);
    original[1].content = "old context ".repeat(4_000);
    original.push(ChatMessage::user(
        "Now compare the new results with the reference",
    ));
    let executor = ImageHistoryExecutor::new(&inner, &original);
    executor.sync(&mut original);
    let provider =
        MockProvider::text("A deliberately incomplete text summary, with no image paths.");
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let outcome = crate::compact_history(
        &provider,
        original,
        &executor.specs(),
        &crate::ContextPolicy {
            soft_limit_tokens: 2_000,
            preserve_recent_messages: 1,
            prune_tool_results_over_tokens: 2_000,
            summary_batch_tokens: 100_000,
        },
        0,
        &tx,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(outcome.compacted);
    let persisted: Vec<ChatMessage> =
        serde_json::from_value(serde_json::to_value(&outcome.messages).unwrap()).unwrap();
    let restored = ImageHistoryExecutor::new(&inner, &persisted);
    let index = restored
        .execute(&call(json!({"action":"list"})))
        .await
        .unwrap();
    assert_eq!(index["total"], 5);
    assert!(index.to_string().contains("observation-1"));
    let projected = restored.messages(&persisted);
    assert!(projected.iter().any(|message| message
        .images
        .iter()
        .any(|image| image.path == "/attachment/reference.png")));
    assert_eq!(
        projected
            .iter()
            .filter(|message| message.role == ChatRole::User)
            .last()
            .unwrap()
            .content,
        "Now compare the new results with the reference"
    );
    assert!(provider.requests.lock().unwrap()[0]
        .messages
        .iter()
        .all(|message| message.images.is_empty()));
}

#[test]
fn repeated_projection_is_stable_and_plain_chat_does_not_advertise_a_tool() {
    let inner = Executor::default();
    let messages = history();
    let executor = ImageHistoryExecutor::new(&inner, &messages);
    assert_eq!(
        serde_json::to_value(executor.messages(&messages)).unwrap(),
        serde_json::to_value(executor.messages(&messages)).unwrap()
    );
    let disabled = ImageHistoryExecutor::new(&crate::NoTools, &messages);
    assert!(disabled.specs().is_empty());
    assert_eq!(
        disabled
            .messages(&messages)
            .iter()
            .map(|message| message.images.len())
            .sum::<usize>(),
        4
    );
}
