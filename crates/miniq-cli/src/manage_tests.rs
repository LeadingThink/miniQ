use super::*;
use crate::client::test_fixture::{Fixture, Reply};
use crate::manage_args::*;
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Parse {
    #[command(subcommand)]
    command: ParseCommand,
}

#[derive(Subcommand)]
enum ParseCommand {
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    Queue {
        #[command(subcommand)]
        command: QueueCommand,
    },
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
}

fn session_target() -> SessionTarget {
    SessionTarget {
        session: "s".into(),
        json: true,
    }
}

fn agent_target() -> AgentTarget {
    AgentTarget {
        session: "s".into(),
        agent: "agent_child".into(),
        json: true,
    }
}

#[test]
fn parser_rejects_unbounded_pages_implicit_delete_and_unselected_publication() {
    for args in [
        vec!["miniq", "session", "events", "s", "--limit", "0"],
        vec!["miniq", "session", "model-calls", "s", "--limit", "101"],
        vec!["miniq", "agent", "history", "s", "a", "--limit", "101"],
        vec!["miniq", "session", "delete", "s"],
        vec![
            "miniq",
            "session",
            "share",
            "create",
            "s",
            "--id",
            "0123456789abcdef0123456789abcdef",
            "--title",
            "share",
        ],
        vec![
            "miniq",
            "session",
            "share",
            "create",
            "s",
            "--id",
            "INVALID",
            "--title",
            "share",
            "--message",
            "m",
        ],
        vec![
            "miniq",
            "session",
            "goal",
            "set",
            "s",
            "work",
            "--token-budget",
            "0",
        ],
    ] {
        assert!(Parse::try_parse_from(args).is_err());
    }
    assert!(Parse::try_parse_from(["miniq", "session", "delete", "s", "--yes"]).is_ok());
    assert!(Parse::try_parse_from(["miniq", "queue", "move", "s", "q", "down"]).is_ok());
}

#[test]
fn diagnostic_parameters_match_real_protocol_and_keep_cursor_and_scope() {
    let before = json!({"at":"2026-10-21T00:00:00Z","id":"old"});
    let (method, value, _) = session::request(SessionCommand::Events(SessionPage {
        session: "s".into(),
        limit: 100,
        before: Some(before.to_string()),
        agent: Some("agent_child".into()),
        json: true,
    }))
    .unwrap();
    assert_eq!(method, "session.executionEvents");
    let params: miniq_protocol::ExecutionEventsParams = serde_json::from_value(value).unwrap();
    assert_eq!(params.agent_id.as_deref(), Some("agent_child"));
    assert_eq!(params.before.unwrap().id, "old");
    let (method, value, _) = session::request(SessionCommand::Process {
        session: "s".into(),
        turn: Some("turn".into()),
        limit: 100,
        before: None,
        include_internal: true,
        json: true,
    })
    .unwrap();
    assert_eq!(method, "session.processRecords");
    let params: miniq_protocol::ProcessRecordsParams = serde_json::from_value(value).unwrap();
    assert_eq!(params.turn_id.as_deref(), Some("turn"));
    assert!(params.include_internal);
    let (method, value, _) = session::request(SessionCommand::ToolDetail {
        session: "s".into(),
        tool: "tool".into(),
        json: true,
    })
    .unwrap();
    assert_eq!(method, "tool.detail");
    let params: miniq_protocol::ToolDetailParams = serde_json::from_value(value).unwrap();
    assert_eq!(params.session_id, "s");
    assert_eq!(params.tool_call_id, "tool");
    assert!(history_cursor(Some(
        "{\"at\":\"x\",\"id\":\"m\",\"unexpected\":true}".into()
    ))
    .is_err());
}

#[test]
fn agent_message_is_a_revision_scoped_read_not_a_send() {
    let revision = 9_007_199_254_740_993;
    let (method, value, _) = agent_request(AgentCommand::Message {
        target: agent_target(),
        revision,
        index: 12,
    })
    .unwrap();
    assert_eq!(method, "agent.message");
    let params: miniq_protocol::AgentMessageParams = serde_json::from_value(value).unwrap();
    assert_eq!(params.revision, revision);
    assert_eq!(params.index, 12);
    let (_, value, _) = agent_request(AgentCommand::History {
        target: agent_target(),
        limit: 100,
        cursor: Some(json!({"revision":revision,"before":12}).to_string()),
    })
    .unwrap();
    let params: miniq_protocol::AgentHistoryParams = serde_json::from_value(value).unwrap();
    assert_eq!(params.cursor.unwrap().revision, revision);
}

#[test]
fn goal_edits_preserve_budget_and_state_until_explicitly_changed() {
    let saved = json!({"goal":"old","status":"paused","tokenBudget":42000});
    let value = session::goal_set_params("s", "new".into(), None, false, &saved).unwrap();
    let params: miniq_protocol::SessionGoalUpdate = serde_json::from_value(value).unwrap();
    assert_eq!(params.token_budget, Some(42000));
    assert_eq!(params.status, miniq_protocol::SessionGoalStatus::Paused);
    let value = session::goal_set_params("s", "new".into(), None, true, &saved).unwrap();
    assert!(value["tokenBudget"].is_null());
    assert!(session::goal_status_params("s", GoalStatus::Active, &Value::Null).is_err());
}

#[test]
fn readable_history_retains_long_content_payload_metadata_and_pagination() {
    let text = format!("{}END-OF-LONG-MESSAGE", "完整正文\n".repeat(500));
    let output = format!("{}END-OF-TOOL-OUTPUT", "payload\n".repeat(500));
    let page = json!({"messages":[{"id":"m","role":"user","createdAt":"2026-10-21T00:00:00Z",
        "content":text,"attachments":[{"path":"/tmp/file with spaces.png"}],"newMetadata":"retained"}],
        "toolCalls":[{"id":"t","toolName":"shell_run","createdAt":"2026-10-21T00:00:01Z",
            "status":"failed","input":{"command":"inspect"},"output":output}],
        "processSummaries":[{"turnId":"m","recordCount":9}],
        "nextCursor":{"at":"2026-10-20T00:00:00Z","id":"older"}});
    let rendered = render_history(&page);
    assert!(rendered.contains(&text));
    assert!(rendered.contains("END-OF-TOOL-OUTPUT"));
    assert!(rendered.contains("/tmp/file with spaces.png"));
    assert!(rendered.contains("newMetadata"));
    assert!(rendered.contains("processSummaries"));
    assert!(rendered.contains("Continue with --before"));
    assert!(rendered.contains("older"));
    assert!(rendered.find("user · m").unwrap() < rendered.find("tool shell_run").unwrap());
    assert!(
        !render_history(&json!({"messages":[{"content":"unsafe\u{001b}[2J"}]}))
            .contains('\u{001b}')
    );
}

#[tokio::test]
async fn queue_edit_uses_observed_full_content_and_does_not_replace_attachments() {
    let old = "原始内容\n".repeat(500);
    let item = json!({"id":"q","sessionId":"s","content":old,"position":7,
        "attachments":[{"path":"/shared/original.png","name":"original.png"}]});
    let mut fixture = Fixture::new(vec![
        ("session.queueList", Reply::Result(json!({"queue":[item]}))),
        (
            "session.queueUpdate",
            Reply::Result(json!({"updated":true})),
        ),
    ])
    .await;
    dispatch(
        &mut fixture.client,
        ManageCommand::Queue(QueueCommand::Update {
            session: "s".into(),
            id: "q".into(),
            content: "修改后的全文".into(),
            json: true,
        }),
    )
    .await
    .unwrap();
    let requests = fixture.finish().await;
    assert_eq!(
        requests[1]["params"],
        json!({"sessionId":"s","queuedMessageId":"q",
        "expectedContent":old,"content":"修改后的全文"})
    );
    assert!(requests[1]["params"].get("attachments").is_none());
}

#[tokio::test]
async fn queue_move_uses_observed_position_and_never_retries_a_conflict() {
    let mut fixture = Fixture::new(vec![
        (
            "session.queueList",
            Reply::Result(json!({"queue":[{"id":"q","position":7}]})),
        ),
        (
            "session.queueMove",
            Reply::Error(-32602, "message moved from observed position"),
        ),
    ])
    .await;
    assert!(dispatch(
        &mut fixture.client,
        ManageCommand::Queue(QueueCommand::Move {
            session: "s".into(),
            id: "q".into(),
            direction: QueueDirection::Down,
            json: true,
        })
    )
    .await
    .is_err());
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["params"]["expectedPosition"], 7);
    assert_eq!(requests[1]["params"]["direction"], "down");
}

#[tokio::test]
async fn queue_remove_does_not_mutate_an_id_outside_the_requested_session() {
    let mut fixture = Fixture::new(vec![(
        "session.queueList",
        Reply::Result(json!({"queue":[]})),
    )])
    .await;
    assert!(dispatch(
        &mut fixture.client,
        ManageCommand::Queue(QueueCommand::Remove(QueueTarget {
            session: "s".into(),
            id: "q".into(),
            json: true,
        }))
    )
    .await
    .is_err());
    assert_eq!(fixture.finish().await.len(), 1);
}

#[tokio::test]
async fn goal_state_controls_execution_before_persisting_and_retains_budget() {
    for (status, method, stored_status) in [
        (GoalStatus::Paused, "session.pause", "paused"),
        (GoalStatus::Active, "session.resume", "active"),
        (GoalStatus::Cancelled, "session.cancel", "cancelled"),
        (GoalStatus::Completed, "session.cancel", "completed"),
    ] {
        let mut fixture = Fixture::new(vec![
            (
                "session.goal.get",
                Reply::Result(json!({"goal":{"goal":"任务","status":"active","tokenBudget":80}})),
            ),
            (method, Reply::Result(json!({"accepted":true}))),
            (
                "session.goal.update",
                Reply::Result(json!({"status":stored_status})),
            ),
        ])
        .await;
        dispatch(
            &mut fixture.client,
            ManageCommand::Session(SessionCommand::Goal {
                command: GoalCommand::Status {
                    session: "s".into(),
                    status,
                    json: true,
                },
            }),
        )
        .await
        .unwrap();
        let requests = fixture.finish().await;
        assert_eq!(requests[2]["params"]["status"], stored_status);
        assert_eq!(requests[2]["params"]["tokenBudget"], 80);
    }
}

#[tokio::test]
async fn failed_goal_control_does_not_record_a_false_pause() {
    let mut fixture = Fixture::new(vec![
        (
            "session.goal.get",
            Reply::Result(json!({"goal":{"goal":"任务","status":"active","tokenBudget":null}})),
        ),
        ("session.pause", Reply::Error(-32602, "no active turn")),
    ])
    .await;
    assert!(dispatch(
        &mut fixture.client,
        ManageCommand::Session(SessionCommand::Goal {
            command: GoalCommand::Status {
                session: "s".into(),
                status: GoalStatus::Paused,
                json: true
            },
        })
    )
    .await
    .is_err());
    assert_eq!(fixture.finish().await.len(), 2);
}

#[tokio::test]
async fn rewrite_finds_older_message_and_preserves_every_original_attachment() {
    let cursor = json!({"at":"2026-10-20T00:00:00Z","id":"older"});
    let mut fixture = Fixture::new(vec![
        ("session.history", Reply::Result(json!({"messages":[{"id":"newer","role":"user"}],"nextCursor":cursor}))),
        ("session.history", Reply::Result(json!({"messages":[{"id":"original","role":"user",
            "attachments":[{"path":"/shared/a.png"},{"path":"/shared/b with spaces.pdf"}]}],"nextCursor":null}))),
        ("session.rewriteMessage", Reply::Result(json!({"accepted":true}))),
    ]).await;
    dispatch(
        &mut fixture.client,
        ManageCommand::Session(SessionCommand::Rewrite {
            session: "s".into(),
            message: "original".into(),
            content: "new text".into(),
            attachments: vec![],
            clear_attachments: false,
            json: true,
        }),
    )
    .await
    .unwrap();
    let requests = fixture.finish().await;
    assert_eq!(requests[1]["params"]["before"], cursor);
    assert_eq!(
        requests[2]["params"]["message"]["attachments"],
        json!(["/shared/a.png", "/shared/b with spaces.pdf"])
    );
    assert_eq!(requests[2]["params"]["message"]["content"], "new text");
}

#[test]
fn share_publication_contains_only_explicit_selection_and_stable_id() {
    let id = "0123456789abcdef0123456789abcdef";
    let (method, params, _) = session::share_request(ShareCommand::Create {
        session: "s".into(),
        id: id.into(),
        title: "Selected answer".into(),
        messages: vec!["m2".into()],
        artifacts: vec!["a1".into()],
        days: "30".into(),
        include_details: true,
        json: true,
    })
    .unwrap();
    assert_eq!(method, "session.shareCreate");
    assert_eq!(params["id"], id);
    assert_eq!(params["messageIds"], json!(["m2"]));
    assert_eq!(params["artifactIds"], json!(["a1"]));
    assert_eq!(params["expiresInDays"], 30);
    let (_, params, _) = session::share_request(ShareCommand::List {
        target: session_target(),
        after: Some(id.into()),
    })
    .unwrap();
    assert_eq!(params["after"], id);
}
