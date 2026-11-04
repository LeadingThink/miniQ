use super::*;
use crate::client::test_fixture::{Fixture, Reply};
use jobs::{Completion, Effect};
use picker::Purpose;

fn completion(id: u64, effect: Effect, result: Result<Value>) -> Completion {
    Completion {
        id,
        session: "s".into(),
        label: "test".into(),
        effect,
        result,
    }
}
fn editor() -> Editor {
    Editor::new(commands::list(), PathBuf::from("."))
}

#[tokio::test]
async fn failed_steer_does_not_recover_an_already_queued_prompt_as_unsent() {
    let mut fixture = Fixture::new(vec![
        (
            "session.sendMessage",
            Reply::Result(json!({"queued":{"id":"q"}})),
        ),
        ("session.queueSteer", Reply::Error(-1, "turn changed")),
    ])
    .await;
    let result = requests::Request::Send {
        text: "queued prompt".into(),
        files: vec![],
        steer: true,
    }
    .execute(&mut fixture.client, "s")
    .await
    .unwrap();
    assert_eq!(result["queued"], "q");
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            3,
            Effect::Sent {
                text: "queued prompt".into(),
                files: vec![],
            },
            Ok(result),
        ),
    );
    assert!(input.is_empty());
    assert!(repl.drafts.is_empty());
    assert!(repl
        .ui
        .transcript
        .entries
        .iter()
        .any(|e| e.content.contains("Prompt was queued")));
    fixture.finish().await;
}

#[tokio::test]
async fn removed_current_session_opens_a_new_one_without_losing_its_draft() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    input.set_buffer("unfinished input");
    repl.files.push("draft.png".into());
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(7, Effect::SessionRemoved("s".into()), Ok(json!({}))),
    );
    let pending = repl.jobs.pending.pop_front().unwrap();
    assert!(matches!(pending.request, requests::Request::New(_)));
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            pending.id,
            Effect::Switch,
            Ok(json!({"session":{"id":"new","status":"idle"},"messages":[]})),
        ),
    );
    assert_eq!(repl.session, "new");
    assert_eq!(repl.drafts["s"].text, "unfinished input");
    assert_eq!(repl.drafts["s"].files, vec![PathBuf::from("draft.png")]);
    fixture.finish().await;
}

#[test]
fn same_named_mcp_rows_keep_plugin_readonly_and_target_the_user_configuration() {
    let mut repl = Repl::new("s", &Default::default());
    let catalog = json!({"servers":[
        {"name":"duplicate","source":"settings","enabled":true,"command":"user"},
        {"name":"duplicate","source":"plugin","pluginId":"plugin.one","enabled":false,"readOnly":true}
    ]});
    let items = repl.resource_items(Purpose::Mcp, &catalog);
    assert_ne!(items[0].value, items[1].value);
    repl.catalogs.insert(Purpose::Mcp, catalog);
    repl.panel_target = items[1].value.clone();
    assert!(repl.resource_action(Purpose::McpActions, "toggle").is_err());
    assert!(repl.jobs.pending.is_empty());
    repl.panel_target = items[0].value.clone();
    repl.resource_action(Purpose::McpActions, "toggle").unwrap();
    let request = repl.jobs.pending.pop_front().unwrap().request;
    let requests::Request::Rpc { params, .. } = request else {
        panic!("expected update");
    };
    assert_eq!(params["servers"].as_array().unwrap().len(), 1);
    assert_eq!(params["servers"][0]["enabled"], false);
    assert_eq!(params["servers"][0]["command"], "user");
}

#[tokio::test]
async fn delayed_clipboard_does_not_paste_into_a_different_form() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.form("First", "original", forms::FormAction::Attach);
    let id = repl.ui.form.as_ref().unwrap().id;
    repl.form("Second", "leave unchanged", forms::FormAction::Export);
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            8,
            Effect::Clipboard(Some(id)),
            Ok(json!({"text":"pasted content"})),
        ),
    );
    assert_eq!(
        repl.ui.form.as_ref().unwrap().editor.buffer(),
        "leave unchanged"
    );
    assert_eq!(repl.drafts["unsent:s:8"].text, "pasted content");
    fixture.finish().await;
}

#[tokio::test]
async fn cancelled_send_recovers_text_and_files_and_failed_switch_clears_watch() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            4,
            Effect::Sent {
                text: "prompt".into(),
                files: vec!["image.png".into()],
            },
            Ok(json!({"cancelled":true})),
        ),
    );
    assert_eq!(input.buffer(), "prompt");
    assert_eq!(repl.files, vec![PathBuf::from("image.png")]);
    commands::switch(&mut repl, &mut fixture.client, "missing")
        .await
        .unwrap();
    assert_eq!(fixture.client.watched(), Some("missing"));
    let pending = repl.jobs.pending.pop_front().unwrap();
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(pending.id, Effect::Switch, Err(anyhow::anyhow!("missing"))),
    );
    assert!(fixture.client.watched().is_none());
    assert_eq!(repl.session, "s");
    fixture.finish().await;
}

#[tokio::test]
async fn history_search_is_paged_and_stale_results_do_not_replace_a_new_search() {
    let cursor = json!({"id":"b","at":"2"});
    let mut fixture = Fixture::new(vec![(
        "session.history",
        Reply::Result(
            json!({"messages":[{"id":"a","role":"user","content":"needle old","createdAt":"1"}]}),
        ),
    )])
    .await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.search_messages("needle", Some(cursor.clone()));
    let id = repl.ui.picker.as_ref().unwrap().request.unwrap();
    repl.complete(
        &mut input,
        &mut fixture.client,
        completion(
            id + 1,
            Effect::MessagePage("other".into()),
            Ok(json!({"messages":[{"id":"wrong"}]})),
        ),
    );
    assert!(repl.ui.picker.as_ref().unwrap().loading);
    repl.finish_jobs(&mut input, &mut fixture.client).await;
    assert_eq!(repl.ui.picker.as_ref().unwrap().items[0].value, "a");
    let requests = fixture.finish().await;
    assert_eq!(requests[0]["params"]["before"], cursor);
    assert_eq!(requests[0]["params"]["query"], "needle");
}

#[tokio::test]
async fn locate_and_refresh_fetch_the_older_page_without_reviving_deleted_messages() {
    let latest = json!({"session":{"id":"s","status":"idle"},"messages":[{"id":"new","role":"assistant","content":"new","createdAt":"2"}],"nextCursor":{"id":"new","at":"2"}});
    let older = json!({"messages":[{"id":"old","role":"user","content":"old","createdAt":"1"}],"nextCursor":null});
    let mut fixture = Fixture::new(vec![
        ("session.history", Reply::Result(latest.clone())),
        ("session.history", Reply::Result(older.clone())),
        ("session.open", Reply::Result(latest)),
        ("session.history", Reply::Result(older)),
    ])
    .await;
    let located = requests::Request::Locate("old".into())
        .execute(&mut fixture.client, "s")
        .await
        .unwrap();
    assert_eq!(located["messages"].as_array().unwrap().len(), 2);
    let mut repl = Repl::new("s", &Default::default());
    repl.restore(&json!({"messages":[{"id":"deleted","role":"user","content":"removed"}]}));
    let value = requests::Request::Refresh(Some("old".into()))
        .execute(&mut fixture.client, "s")
        .await
        .unwrap();
    repl.refresh_request = Some(2);
    repl.complete(
        &mut editor(),
        &mut fixture.client,
        completion(2, Effect::Refresh, Ok(value)),
    );
    assert_eq!(
        repl.ui
            .transcript
            .entries
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        vec!["old", "new"]
    );
    fixture.finish().await;
}

#[tokio::test]
async fn local_preview_works_without_a_daemon_and_preserves_the_original_image() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("original.png");
    let pixels = image::RgbImage::from_fn(320, 160, |x, y| image::Rgb([x as u8, y as u8, 42]));
    pixels.save(&path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut jobs = jobs::Jobs::default();
    jobs.push(
        "s",
        "Preview",
        Effect::Preview("image".into()),
        requests::Request::Preview(path.clone()),
    );
    jobs.start(directory.path(), None);
    let complete = tokio::time::timeout(Duration::from_secs(5), jobs.next())
        .await
        .unwrap();
    let value = complete.result.unwrap();
    assert_eq!(value["image"]["width"], 160);
    assert_eq!(value["image"]["height"], 80);
    assert!(value["text"].as_str().unwrap().contains("320 × 160"));
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(image_preview::ImagePreview::from_value(&value["image"]).is_some());
}

#[test]
fn restored_retry_shows_attempt_count_reason_and_original_elapsed_time() {
    let mut repl = Repl::new("s", &Default::default());
    let at = (time::OffsetDateTime::now_utc() - time::Duration::seconds(3))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    repl.restore(&json!({"session":{"id":"s","status":"running"},"turnProgress":{
        "phase":"waiting_retry","startedAt":at,"retry":{"attempt":2,"maxAttempts":4,"delayMs":10000,"reason":"rate limited"}
    }}));
    let phase = progress::phase(repl.progress.as_ref(), &repl.phase);
    assert!(phase.starts_with("Retry 2/4 in "), "{phase}");
    assert!(phase.contains("rate limited"));
    assert!(repl.started.unwrap().elapsed() >= Duration::from_secs(3));
}

#[tokio::test]
async fn favorite_models_sort_first_and_details_send_a_valid_protocol() {
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    repl.preferences.favorite_models = vec!["favorite".into()];
    repl.preferences.recent_models = vec!["recent".into()];
    let items = repl
        .picker_items(
            Purpose::Models,
            &json!({"models":["other","recent","favorite"]}),
        )
        .unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item.value.as_str())
            .collect::<Vec<_>>(),
        vec!["favorite", "recent", "other"]
    );
    repl.ui.picker = Some(picker::Picker::new(Purpose::Models, "Models", items, None));
    repl.panel_key(
        &mut editor(),
        &mut fixture.client,
        KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
    )
    .await
    .unwrap();
    let requests::Request::Rpc { params, method } = repl.jobs.pending.pop_front().unwrap().request
    else {
        panic!("expected describe");
    };
    assert_eq!(method, "model.describe");
    assert_eq!(params["apiProtocol"], "auto");
    fixture.finish().await;
}

#[tokio::test]
async fn rendered_card_buttons_and_drag_selection_use_the_same_mouse_coordinates() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{backend::TestBackend, Terminal};
    let mut fixture = Fixture::new(vec![]).await;
    let mut repl = Repl::new("s", &Default::default());
    let mut input = editor();
    repl.card(&json!({"type":"question_requested","question":{"id":"q","prompt":"Choose","options":["first","second"],"multiSelect":true}}));
    let state = screen::Status {
        card: Some((
            "Choose".into(),
            vec![
                "☐ first".into(),
                "☐ second".into(),
                "Submit selection".into(),
            ],
        )),
        ..Default::default()
    };
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| repl.ui.draw(frame, &input, &state))
        .unwrap();
    let area = repl.ui.card_hits[1].0;
    mouse::interact(
        &mut repl,
        &mut input,
        &mut fixture.client,
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        repl.ui.card_checked.iter().copied().collect::<Vec<_>>(),
        vec![1]
    );
    assert!(repl.jobs.pending.is_empty());
    repl.cards.clear();
    repl.ui.transcript.notice("alpha 中文 omega");
    terminal
        .draw(|frame| repl.ui.draw(frame, &input, &screen::Status::default()))
        .unwrap();
    let area = repl.ui.transcript_area;
    let selected_row = repl
        .ui
        .rows(area.width.saturating_sub(1) as usize, false)
        .iter()
        .position(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains("alpha 中文 omega")
        })
        .unwrap() as u16;
    for (kind, x) in [
        (MouseEventKind::Down(MouseButton::Left), area.x),
        (MouseEventKind::Drag(MouseButton::Left), area.right() - 1),
        (MouseEventKind::Up(MouseButton::Left), area.right() - 1),
    ] {
        mouse::interact(
            &mut repl,
            &mut input,
            &mut fixture.client,
            MouseEvent {
                kind,
                column: x,
                row: area.y + selected_row,
                modifiers: KeyModifiers::NONE,
            },
        )
        .await
        .unwrap();
    }
    assert!(repl
        .ui
        .selected_text()
        .unwrap()
        .contains("alpha 中文 omega"));
    assert!(repl.ui.picker.is_none());
    fixture.finish().await;
}
