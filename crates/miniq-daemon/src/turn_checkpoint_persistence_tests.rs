use super::*;
use miniq_models::ToolCallRequest;
use serde_json::json;
use std::time::Duration;

fn checkpoint(
    store: Arc<miniq_memory::Store>,
    session_id: &str,
    anchor: &str,
) -> SessionCheckpoint {
    SessionCheckpoint {
        memory_generation: store.memory_generation().unwrap(),
        store,
        session_id: session_id.into(),
        anchor_id: Mutex::new(anchor.into()),
        message_id: Mutex::new("partial-result".into()),
        state: AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "test".into(),
            Arc::new(miniq_models::mock::MockProvider::text("unused")),
        ),
        events: tokio::sync::mpsc::channel(1).0.downgrade(),
        model_identity: Some("model".into()),
        partial_message: Default::default(),
    }
}

#[tokio::test]
async fn blocking_checkpoint_preserves_redaction_memory_stripping_and_tool_evidence() {
    let store = Arc::new(miniq_memory::Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/tmp", "checkpoint").unwrap();
    let session = store.create_session(&workspace.id, "checkpoint").unwrap();
    let user = store
        .append_message(&session.id, Role::User, "task")
        .unwrap();
    let checkpoint = checkpoint(store.clone(), &session.id, &user.id);
    let mut assistant = ChatMessage::assistant("working");
    assistant.tool_calls = vec![
        ToolCallRequest {
            id: "memory".into(),
            name: "memory_read".into(),
            arguments: json!({}),
        },
        ToolCallRequest {
            id: "file".into(),
            name: "file_read".into(),
            arguments: json!({"api_key":"fixture-secret"}),
        },
    ];
    checkpoint.save(TurnCheckpoint {
        history: vec![
            ChatMessage::system("runtime-only"), ChatMessage::user("task"), assistant,
            ChatMessage::tool_result("memory", json!({"memory":{"id":"m1","scope":"global","revision":1,"content":"historical-memory-secret"}}).to_string()),
            ChatMessage::tool_result("file", "confirmed file evidence"),
        ],
        display_text: String::new(), reasoning: String::new(), stopped: false,
    }).await.unwrap();
    let snapshot = store.get_model_context(&session.id).unwrap().unwrap();
    let serialized = snapshot.history.to_string();
    assert!(!serialized.contains("runtime-only"));
    assert!(!serialized.contains("fixture-secret"));
    assert!(!serialized.contains("historical-memory-secret"));
    assert!(serialized.contains("confirmed file evidence"));
    let history: Vec<ChatMessage> = serde_json::from_value(snapshot.history).unwrap();
    assert_eq!(history[1].tool_calls[1].arguments["api_key"], "[REDACTED]");
    let memory: serde_json::Value = serde_json::from_str(&history[2].content).unwrap();
    assert_eq!(memory["memoryReferences"][0]["id"], "m1");
    assert_eq!(snapshot.last_message_id, user.id);
}

#[tokio::test]
async fn stale_blocking_checkpoint_keeps_actual_reply_without_restoring_forgotten_context() {
    let store = Arc::new(miniq_memory::Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/tmp", "checkpoint").unwrap();
    let session = store.create_session(&workspace.id, "checkpoint").unwrap();
    let user = store
        .append_message(&session.id, Role::User, "task")
        .unwrap();
    let mut checkpoint = checkpoint(store.clone(), &session.id, &user.id);
    checkpoint.memory_generation -= 1;
    checkpoint
        .save(TurnCheckpoint {
            history: vec![
                ChatMessage::system("runtime"),
                ChatMessage::user("stale context"),
            ],
            display_text: "actual partial reply".into(),
            reasoning: String::new(),
            stopped: true,
        })
        .await
        .unwrap();
    assert!(store.get_model_context(&session.id).unwrap().is_none());
    let messages = store.list_messages(&session.id).unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages[1].content.contains("actual partial reply"));
    assert_eq!(
        messages[1].assistant_kind,
        Some(miniq_protocol::AssistantMessageKind::Interrupted)
    );
    assert!(checkpoint.partial_message.lock().unwrap().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn checkpoint_waits_for_durability_without_blocking_the_async_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("context.sqlite");
    let store = Arc::new(miniq_memory::Store::open(&database).unwrap());
    let workspace = store.create_workspace("/tmp", "checkpoint").unwrap();
    let session = store.create_session(&workspace.id, "checkpoint").unwrap();
    let user = store
        .append_message(&session.id, Role::User, "task")
        .unwrap();
    let checkpoint = checkpoint(store.clone(), &session.id, &user.id);
    let writer = rusqlite::Connection::open(&database).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let unlock = std::thread::spawn(move || {
        // A bounded unlock also lets the regression fail instead of hanging
        // if checkpoint persistence ever blocks the sole runtime thread.
        let _ = wait.recv_timeout(Duration::from_secs(2));
        writer.execute_batch("ROLLBACK").unwrap();
    });
    let save = tokio::spawn(async move {
        checkpoint
            .save(TurnCheckpoint {
                history: vec![ChatMessage::system("runtime"), ChatMessage::user("task")],
                // Insert the actual reply first, so the transaction waits on
                // the writer before taking a read snapshot of memory policy.
                display_text: "partial reply".into(),
                reasoning: String::new(),
                stopped: true,
            })
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !save.is_finished(),
        "checkpoint acknowledged before its transaction committed"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), save)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    unlock.join().unwrap();
    assert_eq!(
        store
            .get_model_context(&session.id)
            .unwrap()
            .unwrap()
            .last_message_id,
        "partial-result"
    );
}
