use super::*;
use crate::client::test_fixture::{Fixture, Reply};
use jobs::{Completion, Effect};
use picker::Purpose;

fn editor() -> Editor {
    Editor::new(commands::list(), PathBuf::from("."))
}
fn completion(id: u64, session: &str, effect: Effect, result: Result<Value>) -> Completion {
    Completion {
        id,
        session: session.into(),
        label: "Test operation".into(),
        effect,
        result,
    }
}

#[test]
fn windows_without_term_uses_tui_but_dumb_does_not() {
    assert!(terminal_capable(None, true));
    assert!(!terminal_capable(None, false));
    assert!(!terminal_capable(Some("dumb"), true));
}

#[test]
fn quoted_mentions_and_completion_preserve_spaces_unicode_and_punctuation() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["my file 中文.rs", "ends.", "other.rs"] {
        std::fs::write(dir.path().join(name), "text").unwrap();
    }
    let text = "read @\"my file 中文.rs\", @ends. @other.rs; email@other.rs";
    assert_eq!(
        mentioned_files(text, dir.path()),
        ["my file 中文.rs", "ends.", "other.rs"].map(|name| dir.path().join(name))
    );
    let mut editor = Editor::new(vec![], dir.path().into());
    editor.insert("look @\"my file");
    editor.select_completion(0);
    assert_eq!(
        mentioned_files(editor.buffer(), dir.path()),
        vec![dir.path().join("my file 中文.rs")]
    );
}

#[test]
fn pasted_text_is_folded_only_visually_and_sent_intact() {
    let text = "中文 👩‍💻 complete line\n".repeat(200);
    let mut editor = editor();
    editor.paste(&text);
    assert!(editor.folded);
    assert!(editor.view("").lines[0].contains("Pasted 200 lines"));
    assert_eq!(
        editor.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Action::Submit(text)
    );
    assert!(editor.is_empty());
}

#[test]
fn mouse_caret_tracks_unicode_graphemes_and_wrapping() {
    let mut editor = editor();
    editor.set_buffer("abc中e\u{301}👩‍💻\nnext");
    editor.click(4, 1, 2);
    assert_eq!(&editor.buffer()[..editor.cursor()], "abc中");
    editor.click(4, 2, 1);
    assert_eq!(&editor.buffer()[editor.cursor()..], "👩‍💻\nnext");
}

#[tokio::test]
async fn switching_running_sessions_preserves_drafts_files_viewport_and_paste() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("one", &Default::default());
    let mut input = editor();
    input.paste(&"draft\n".repeat(15));
    repl.files.push("one.png".into());
    repl.running = true;
    repl.last_answer = "answer from one".into();
    repl.queue = vec![json!({"id":"old queue"})];
    repl.ui.scroll = Some(5);
    repl.ui.expanded_tools.insert("tool-one".into());
    repl.drafts.insert(
        "two".into(),
        drafts::Draft {
            text: "draft two".into(),
            cursor: 5,
            files: vec!["two.png".into()],
            ..Default::default()
        },
    );
    repl.switch_request = Some(9);
    repl.complete(&mut input, &mut fixture.client, completion(9, "one", Effect::Switch,
        Ok(json!({"session":{"id":"two","status":"idle"},"messages":[],"eventCursor":{"epoch":"e","sequence":10}}))));
    assert_eq!(input.buffer(), "draft two");
    assert!(repl.last_answer.is_empty());
    assert!(repl.queue.is_empty());
    assert_eq!(input.cursor(), 5);
    assert_eq!(repl.files, vec![PathBuf::from("two.png")]);
    assert!(repl.drafts["one"].folded);
    assert_eq!(repl.drafts["one"].scroll, Some(5));
    assert!(repl.drafts["one"].expanded_tools.contains("tool-one"));
    fixture.finish().await;
}

#[tokio::test]
async fn failed_background_send_is_recoverable_without_changing_current_input() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("new", &Default::default());
    let mut input = editor();
    input.set_buffer("new input");
    repl.files.push("current.png".into());
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            4,
            "old",
            Effect::Sent {
                text: "failed input".into(),
                files: vec!["old.png".into()],
            },
            Err(anyhow::anyhow!("disconnected")),
        ),
    );
    let draft = &repl.drafts["unsent:old:4"];
    assert_eq!(draft.text, "failed input");
    assert_eq!(draft.files, vec![PathBuf::from("old.png")]);
    assert_eq!(input.buffer(), "new input");
    assert_eq!(repl.files, vec![PathBuf::from("current.png")]);
    fixture.finish().await;
}

#[tokio::test]
async fn completed_background_send_keeps_attachments_added_to_the_next_draft() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("new", &Default::default());
    let mut input = editor();
    repl.drafts.insert(
        "old".into(),
        drafts::Draft {
            files: vec!["next.png".into()],
            ..Default::default()
        },
    );
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            1,
            "old",
            Effect::Sent {
                text: "sent".into(),
                files: vec!["sent.png".into()],
            },
            Ok(json!({"started":true})),
        ),
    );
    assert_eq!(repl.drafts["old"].files, vec![PathBuf::from("next.png")]);
    fixture.finish().await;
}

#[tokio::test]
async fn snapshot_replays_later_deltas_once_and_preserves_scroll() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.ui.scroll = Some(3);
    repl.refresh_request = Some(1);
    repl.snapshot_events = vec![
        json!({"type":"assistant_delta","sessionId":"s","delta":"before","eventCursor":{"epoch":"e","sequence":1}}),
        json!({"type":"assistant_delta","sessionId":"s","delta":"after","eventCursor":{"epoch":"e","sequence":3}}),
    ];
    repl.complete(&mut input, &mut fixture.client, completion(1, "s", Effect::Refresh,
        Ok(json!({"session":{"id":"s","status":"running"},"streamingText":"before","eventCursor":{"epoch":"e","sequence":2}}))));
    assert_eq!(repl.ui.transcript.entries[0].content, "beforeafter");
    assert_eq!(repl.ui.scroll, Some(3));
    fixture.finish().await;
}

#[tokio::test]
async fn picker_opens_before_rpc_and_keeps_retry_state_on_failure() {
    let mut fixture = Fixture::new(vec![
        ("model.list", Reply::Error(-1, "offline")),
        ("model.list", Reply::Result(json!({"models":["ready"]}))),
    ])
    .await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    input.set_buffer("keep me");
    repl.open_picker(&mut fixture.client, Purpose::Models)
        .await
        .unwrap();
    assert!(repl.ui.picker.as_ref().unwrap().loading);
    repl.finish_jobs(&mut input, &mut fixture.client).await;
    assert!(repl
        .ui
        .picker
        .as_ref()
        .unwrap()
        .error
        .as_ref()
        .unwrap()
        .contains("offline"));
    navigation::key(
        &mut repl,
        &mut input,
        &mut fixture.client,
        KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL),
    )
    .await
    .unwrap();
    repl.finish_jobs(&mut input, &mut fixture.client).await;
    assert_eq!(repl.ui.picker.as_ref().unwrap().items[0].value, "ready");
    assert_eq!(input.buffer(), "keep me");
    fixture.finish().await;
}

#[tokio::test]
async fn multi_select_toggles_without_submitting_then_sends_selected_labels() {
    let mut fixture = Fixture::new(vec![("question.resolve", Reply::Result(json!({})))]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.card(&json!({"type":"question_requested","question":{"id":"q","prompt":"Choose","options":["alpha","beta","gamma"],"multiSelect":true}}));
    repl.choose_card(&mut fixture.client, true).await.unwrap();
    repl.ui.card_selected = 2;
    repl.choose_card(&mut fixture.client, true).await.unwrap();
    assert!(repl.jobs.pending.is_empty());
    repl.ui.card_selected = 3;
    repl.choose_card(&mut fixture.client, false).await.unwrap();
    repl.finish_jobs(&mut input, &mut fixture.client).await;
    assert!(repl.cards.is_empty());
    let requests = fixture.finish().await;
    assert_eq!(requests[0]["params"]["answer"], "alpha\ngamma");
}

#[tokio::test]
async fn failed_queue_edit_keeps_form_and_uses_conflict_preconditions() {
    let mut fixture = Fixture::new(vec![(
        "session.queueUpdate",
        Reply::Error(-1, "changed elsewhere"),
    )])
    .await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    input.set_buffer("draft");
    let attachment = json!({"id":"a","name":"a.png"});
    repl.form(
        "Edit queued message",
        "replacement",
        forms::FormAction::QueueEdit(
            json!({"id":"q","content":"original","attachments":[attachment]}),
        ),
    );
    repl.form_key(
        &mut fixture.client,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
    )
    .await
    .unwrap();
    repl.finish_jobs(&mut input, &mut fixture.client).await;
    let form = repl.ui.form.as_ref().unwrap();
    assert_eq!(form.editor.buffer(), "replacement");
    assert!(form.error.is_some());
    assert_eq!(input.buffer(), "draft");
    let requests = fixture.finish().await;
    assert_eq!(requests[0]["params"]["expectedContent"], "original");
    assert_eq!(
        requests[0]["params"]["expectedAttachments"],
        json!([attachment])
    );
}

#[tokio::test]
async fn export_preserves_every_page_and_refuses_to_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chat.json");
    let pages = vec![
        (
            "session.history",
            Reply::Result(
                json!({"messages":[{"id":"new","attachments":[{"name":"file"}]}],"nextCursor":{"id":"new","at":"2"}}),
            ),
        ),
        (
            "session.history",
            Reply::Result(
                json!({"messages":[{"id":"old"}],"toolCalls":[{"output":"full"}],"nextCursor":null}),
            ),
        ),
    ];
    let mut fixture = Fixture::new(pages).await;
    requests::Request::Export(path.clone())
        .execute(&mut fixture.client, "s")
        .await
        .unwrap();
    let original = std::fs::read_to_string(&path).unwrap();
    let value: Value = serde_json::from_str(&original).unwrap();
    assert!(requests::Request::Export(path.clone())
        .execute(&mut fixture.client, "s")
        .await
        .is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    assert_eq!(value["pages"][0]["messages"][0]["id"], "old");
    assert_eq!(
        value["pages"][1]["messages"][0]["attachments"][0]["name"],
        "file"
    );
    let requests = fixture.finish().await;
    assert_eq!(requests[1]["params"]["before"]["id"], "new");
}

#[test]
fn preferences_roundtrip_preserves_existing_configuration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("cli.json"),
        r#"{"keybindings":{"newline":"alt+enter"},"custom":42}"#,
    )
    .unwrap();
    prefs::save_values(
        dir.path(),
        json!({"theme":"light","animations":false,"favoriteModels":["x"],"recentModels":["y"]}),
    )
    .unwrap();
    let (prefs, warnings) = prefs::Prefs::load(dir.path());
    assert!(warnings.is_empty());
    assert_eq!(prefs.theme, "light");
    assert!(!prefs.animations);
    assert_eq!(prefs.favorite_models, vec!["x"]);
    assert_eq!(prefs.recent_models, vec!["y"]);
    assert_eq!(prefs.keybindings["newline"], vec!["alt+enter"]);
}
