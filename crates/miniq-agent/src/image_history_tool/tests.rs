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

fn history(directory: &std::path::Path) -> Vec<ChatMessage> {
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
        let path = directory.join(format!("observation-{batch}.png"));
        std::fs::write(&path, crate::missing_images::tests::PNG).unwrap();
        result.images.push(image(path.to_str().unwrap()));
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
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let executor = ImageHistoryExecutor::new(&inner, &history(directory.path()));
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
            image(directory.path().join("observation-1.png").to_str().unwrap()),
            image(directory.path().join("observation-4.png").to_str().unwrap())
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
    let directory = tempfile::tempdir().unwrap();
    let original = history(directory.path());
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
    assert_eq!(
        read.images[0].path,
        directory.path().join("observation-1.png").to_str().unwrap()
    );
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
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let mut original = history(directory.path());
    let mut user = ChatMessage::user("original references");
    let reference_path = directory.path().join("reference.png");
    std::fs::write(&reference_path, crate::missing_images::tests::PNG).unwrap();
    user.images = vec![image(reference_path.to_str().unwrap())];
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
        .any(|image| image.path == reference_path.to_str().unwrap())));
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
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let messages = history(directory.path());
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

#[tokio::test]
async fn mixed_recall_reports_missing_pixels_and_recovers_them_after_restoration() {
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let messages = history(directory.path());
    let executor = ImageHistoryExecutor::new(&inner, &messages);
    let deleted = directory.path().join("observation-1.png");
    std::fs::remove_file(&deleted).unwrap();
    let read = call(json!({"action":"read","ids":["img_1","img_4","img_1"]}));
    let output = executor.execute(&read).await.unwrap();
    assert_eq!(output["image_references"], json!(["img_1", "img_4"]));
    assert_eq!(
        output["missing_visual_evidence"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        output["missing_visual_evidence"][0]["image_reference"],
        "img_1"
    );
    assert_eq!(
        output["missing_visual_evidence"][0]["image"]["path"],
        deleted.to_str().unwrap()
    );
    assert_eq!(
        executor.result_images(&read, &output),
        vec![messages.last().unwrap().images[0].clone()]
    );
    let sources = executor
        .execute(&call(json!({"action":"sources","id":"img_1"})))
        .await
        .unwrap();
    assert!(sources.to_string().contains("observation-1"));
    std::fs::write(&deleted, crate::missing_images::tests::PNG).unwrap();
    let restored = executor.execute(&read).await.unwrap();
    assert!(restored["missing_visual_evidence"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(executor.result_images(&read, &restored).len(), 2);
}

#[tokio::test]
async fn removal_between_recall_execution_and_projection_still_reports_missing_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let messages = history(directory.path());
    let executor = ImageHistoryExecutor::new(&inner, &messages);
    let read = call(json!({"action":"read","ids":["img_1","img_4"]}));
    let output = executor.execute(&read).await.unwrap();
    assert_eq!(
        output["attached_image_references"],
        json!(["img_1", "img_4"])
    );
    std::fs::remove_file(directory.path().join("observation-1.png")).unwrap();
    let mut result = ChatMessage::tool_result("recall-call", output.to_string());
    result.images = executor.result_images(&read, &output);
    assert_eq!(result.images.len(), 2);
    let outgoing = executor.messages(&[result]);
    let recalled = outgoing.last().unwrap();
    assert_eq!(recalled.images.len(), 1);
    let body: Value = serde_json::from_str(&recalled.content).unwrap();
    assert_eq!(
        body["missing_visual_evidence"][0]["image_reference"],
        "img_1"
    );
    assert!(body["missing_visual_evidence"][0]["image"]["path"]
        .as_str()
        .unwrap()
        .ends_with("observation-1.png"));
}

#[tokio::test]
async fn missing_user_reference_survives_compaction_and_resume_without_blocking_text() {
    let directory = tempfile::tempdir().unwrap();
    let inner = Executor::default();
    let deleted = directory.path().join("missing-reference.png");
    let mut user = ChatMessage::user("Original source text that must survive compaction");
    user.images.push(image(deleted.to_str().unwrap()));
    let original = vec![
        ChatMessage::system("test policy"),
        user,
        ChatMessage::assistant("previous work ".repeat(4_000)),
        ChatMessage::user("Continue the text-only explanation"),
    ];
    let provider = MockProvider::text("Summary with no images");
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    // NoTools must retain visual source metadata too, even without a recall tool.
    let compacted = crate::compact_history(
        &provider,
        original,
        &[],
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
    assert!(compacted.compacted);
    let persisted: Vec<ChatMessage> =
        serde_json::from_slice(&serde_json::to_vec(&compacted.messages).unwrap()).unwrap();
    let executor = ImageHistoryExecutor::new(&inner, &persisted);
    let outgoing = executor.messages(&persisted);
    assert!(outgoing.iter().all(|message| message.images.is_empty()));
    assert!(outgoing
        .iter()
        .any(|message| message.content.contains("missing_visual_evidence")));
    assert_eq!(
        outgoing.last().unwrap().content,
        "Continue the text-only explanation"
    );
    let sources = executor
        .execute(&call(json!({"action":"sources","id":"img_1"})))
        .await
        .unwrap();
    assert_eq!(
        sources["sources"][0]["source_content"],
        "Original source text that must survive compaction"
    );
    let requests = provider.requests.lock().unwrap();
    assert!(requests.iter().all(|request| request
        .messages
        .iter()
        .all(|message| message.images.is_empty())));
    assert!(requests[0].messages[1]
        .content
        .contains("missing_visual_evidence"));
    drop(requests);
    std::fs::write(&deleted, crate::missing_images::tests::PNG).unwrap();
    let restored = executor.messages(&persisted);
    assert_eq!(
        restored
            .iter()
            .map(|message| message.images.len())
            .sum::<usize>(),
        1
    );
}
