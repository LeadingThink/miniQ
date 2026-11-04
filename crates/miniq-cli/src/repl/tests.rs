use super::*;
use crate::client::test_fixture::{Fixture, Reply};
use picker::Purpose;

#[test]
fn mentions_attach_existing_files_only() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.rs"), "").unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    let files = mentioned_files("look at @a.rs, @src/ and @missing.md @a.rs", dir.path());
    assert_eq!(files, vec![dir.path().join("a.rs")]);
}

#[test]
fn pending_approval_keeps_complete_context_and_resolves_without_losing_other_cards() {
    let mut repl = Repl::new("s", &Default::default());
    let reason = "Complete approval reason ".repeat(200);
    repl.card(&json!({"type":"approval_requested","approval":{"id":"a","reason":reason,"riskLevel":"high"},"toolName":"shell","input":{"command":"ls"}}));
    assert!(repl.cards.front().unwrap().body().contains(&reason));
    repl.resolved_card(&json!({"type":"approval_resolved","approval":{"id":"a"}}));
    assert!(repl.cards.is_empty());
}

#[test]
fn streamed_answer_is_not_printed_twice() {
    let mut repl = Repl::new("s", &Default::default());
    repl.style = Style::plain();
    repl.event(&json!({"type":"assistant_delta","delta":"hello "}));
    assert_eq!(repl.ui.transcript.entries[0].content, "hello ");
    repl.event(
        &json!({"type":"message_created","message":{"role":"assistant","content":"hello world"}}),
    );
    assert_eq!(repl.last_answer, "hello world");
    assert_eq!(repl.ui.transcript.entries.len(), 1);
    repl.event(&json!({"type":"turn_completed"}));
    assert!(!repl.running);
}

#[test]
fn busy_phase_tracks_model_and_tool_events_and_stops_on_terminal_outcomes() {
    for end in [
        json!({"type":"turn_completed"}),
        json!({"type":"turn_failed","error":"provider failed"}),
        json!({"type":"turn_failed","error":"cancelled"}),
        json!({"type":"session_status_changed","status":"idle"}),
        json!({"type":"session_status_changed","status":"failed"}),
    ] {
        let mut repl = Repl::new("s", &Default::default());
        repl.event(&json!({"type":"session_status_changed","status":"running"}));
        assert!(repl.running);
        assert_eq!(repl.phase, "Thinking");
        let started = repl.started;
        for (phase, label) in [
            ("preparing_context", "Preparing context"),
            ("compacting_context", "Compacting context"),
            ("requesting_model", "Thinking"),
            ("receiving_model", "Responding"),
            ("waiting_retry", "Waiting to retry"),
            ("finalizing", "Finishing"),
        ] {
            repl.event(&json!({"type":"turn_progress_changed","progress":{"phase":phase,"startedAt":"2026-11-04T00:00:00Z"}}));
            assert_eq!(repl.phase, label);
        }
        repl.event(&json!({"type":"tool_call_started","toolCallId":"t","toolName":"shell"}));
        assert_eq!(repl.phase, "Running shell");
        repl.event(&json!({"type":"tool_call_finished","toolCallId":"t","status":"completed"}));
        assert_eq!(repl.phase, "Thinking");
        repl.event(&json!({"type":"assistant_delta","delta":"answer"}));
        assert_eq!(repl.phase, "Responding");
        assert_eq!(repl.started, started);
        repl.event(&end);
        assert!(!repl.running);
        assert!(repl.phase.is_empty());
    }
}

#[tokio::test]
async fn model_overlay_updates_only_session_model_and_preserves_prompt_draft() {
    let state = json!({"settings":{"model":null,"apiProtocol":"auto","reasoningEffort":null},"effective":{"model":"old","apiProtocol":"auto"}});
    let mut fixture = Fixture::new(vec![
        ("model.list", Reply::Result(json!({"models":["old","new"]}))),
        ("session.modelGet", Reply::Result(state)),
        ("session.modelUpdate", Reply::Result(json!({}))),
        (
            "session.modelGet",
            Reply::Result(json!({"effective":{"model":"new","reasoningEffort":"high"}})),
        ),
    ])
    .await;
    let mut repl = Repl::new("s", &Default::default());
    let mut editor = Editor::new(commands::list(), PathBuf::from("."));
    editor.insert("unfinished 中文 prompt");
    commands::run(&mut repl, &mut editor, &mut fixture.client, "/models")
        .await
        .unwrap();
    assert_eq!(repl.ui.picker.as_ref().unwrap().purpose, Purpose::Models);
    repl.finish_jobs(&mut editor, &mut fixture.client).await;
    repl.choose(&mut editor, &mut fixture.client, "new")
        .await
        .unwrap();
    repl.finish_jobs(&mut editor, &mut fixture.client).await;
    assert_eq!(editor.buffer(), "unfinished 中文 prompt");
    assert_eq!(repl.model, "new");
    let requests = fixture.finish().await;
    assert_eq!(requests[2]["params"]["sessionId"], "s");
    assert_eq!(requests[2]["params"]["settings"]["model"], "new");
}

#[tokio::test]
async fn escape_closes_palette_without_cancelling_a_running_turn_or_erasing_the_draft() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    repl.running = true;
    let mut editor = Editor::new(commands::list(), PathBuf::from("."));
    editor.insert("draft");
    repl.open_picker(&mut fixture.client, Purpose::Commands)
        .await
        .unwrap();
    navigation::key(
        &mut repl,
        &mut editor,
        &mut fixture.client,
        KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
    )
    .await
    .unwrap();
    assert!(repl.ui.picker.is_none());
    assert!(repl.running);
    assert_eq!(editor.buffer(), "draft");
    assert!(fixture.finish().await.is_empty());
}

#[tokio::test]
async fn choosing_reject_sends_exact_approval_decision_and_keeps_draft_untouched() {
    let mut fixture = Fixture::new(vec![("approval.resolve", Reply::Result(json!({})))]).await;
    let mut repl = Repl::new("s", &Default::default());
    repl.cards.push_back(Card::Approval {
        id: json!("a"),
        body: "Review before execution".into(),
    });
    repl.ui.card_selected = 3;
    let mut editor = Editor::new(commands::list(), PathBuf::from("."));
    navigation::key(
        &mut repl,
        &mut editor,
        &mut fixture.client,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
    )
    .await
    .unwrap();
    repl.finish_jobs(&mut editor, &mut fixture.client).await;
    assert!(repl.cards.is_empty());
    let requests = fixture.finish().await;
    assert_eq!(
        requests[0]["params"],
        json!({"approvalId":"a","decision":"reject"})
    );
}

#[tokio::test]
async fn earlier_history_uses_the_returned_cursor_and_requests_complete_payloads() {
    let mut fixture = Fixture::new(vec![("session.history", Reply::Result(json!({"messages":[{"id":"old","role":"user","content":"old","createdAt":"0"}],"nextCursor":null})))]).await;
    let mut repl = Repl::new("s", &Default::default());
    repl.ui.transcript.restore(&json!({"messages":[{"id":"new","role":"assistant","content":"new","createdAt":"1"}],"nextCursor":{"at":"1","id":"new"}}));
    repl.ui.transcript_area.width = 80;
    repl.ui.scroll = Some(0);
    repl.earlier(&mut fixture.client).await.unwrap();
    let mut editor = Editor::new(commands::list(), PathBuf::from("."));
    repl.finish_jobs(&mut editor, &mut fixture.client).await;
    assert_eq!(repl.ui.transcript.entries[0].id, "old");
    assert_eq!(repl.ui.transcript.entries[1].id, "new");
    let requests = fixture.finish().await;
    assert_eq!(
        requests[0]["params"]["before"],
        json!({"at":"1","id":"new"})
    );
    assert_eq!(requests[0]["params"]["includePayloads"], true);
}

#[tokio::test]
async fn page_up_loads_older_messages_even_when_current_history_fits_the_viewport() {
    let mut fixture = Fixture::new(vec![("session.history", Reply::Result(json!({"messages":[{"id":"old","role":"user","content":"older context","createdAt":"0"}],"nextCursor":null})))]).await;
    let mut repl = Repl::new("s", &Default::default());
    repl.ui.transcript.restore(&json!({"messages":[{"id":"new","role":"assistant","content":"new","createdAt":"1"}],"nextCursor":{"at":"1","id":"new"}}));
    repl.ui.total = 5;
    repl.ui.page_height = 20;
    repl.ui.transcript_area.width = 80;
    let mut editor = Editor::new(commands::list(), PathBuf::from("."));
    navigation::key(
        &mut repl,
        &mut editor,
        &mut fixture.client,
        KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
    )
    .await
    .unwrap();
    repl.finish_jobs(&mut editor, &mut fixture.client).await;
    assert_eq!(repl.ui.transcript.entries[0].content, "older context");
    assert!(repl.ui.transcript.next_cursor.is_none());
    assert_eq!(fixture.finish().await.len(), 1);
}
