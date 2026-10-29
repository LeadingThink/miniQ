use super::*;
use miniq_protocol::*;
use serde_json::json;
use std::sync::{Arc, Barrier};

fn setup() -> (Arc<Store>, String, String) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/concurrent", "concurrent").unwrap();
    let session = store.create_session(&workspace.id, "sources").unwrap();
    (store, workspace.id, session.id)
}
#[test]
fn memory_concurrent_corrections_have_exactly_one_winner() {
    let (store, ws, _) = setup();
    let input:MemoryWriteParams=serde_json::from_value(json!({"target":{"scope":"workspace","workspaceId":ws},"content":"预算 100 元","key":"project.budget"})).unwrap();
    let saved = store.write_memory(&input, None).unwrap().memory.unwrap();
    let gate = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|n| {
            let store = store.clone();
            let gate = gate.clone();
            let mut input = input.clone();
            input.content = format!("预算 {} 元", 200 + n);
            input.replaces = Some(MemoryReplacement {
                id: saved.id.clone(),
                expected_revision: saved.revision,
            });
            std::thread::spawn(move || {
                gate.wait();
                store.write_memory(&input, None).unwrap().status
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|s| **s == MemoryWriteStatus::Updated)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|s| **s == MemoryWriteStatus::NeedsConfirmation)
            .count(),
        1
    );
}
#[test]
fn memory_independent_sources_survive_until_last_source_is_removed() {
    let (store, ws, first) = setup();
    let second = store.create_session(&ws, "independent").unwrap();
    let input: MemoryWriteParams = serde_json::from_value(
        json!({"target":{"scope":"workspace","workspaceId":ws},"content":"项目使用 Rust"}),
    )
    .unwrap();
    let mut id = String::new();
    for session in [&first, &second.id] {
        let source = store
            .append_message(session, Role::User, "项目使用 Rust")
            .unwrap();
        let evidence = store.memory_evidence(&source.id).unwrap();
        id = store
            .write_memory(&input, Some(&evidence))
            .unwrap()
            .memory
            .unwrap()
            .id;
    }
    assert_eq!(store.memory_sources(&input.target, &id).unwrap().len(), 2);
    store.delete_session(&first).unwrap();
    assert_eq!(store.memory_sources(&input.target, &id).unwrap().len(), 1);
    assert!(store.memory_by_id(&input.target, &id).unwrap().is_some());
    store.delete_session(&second.id).unwrap();
    assert!(store.memory_by_id(&input.target, &id).unwrap().is_none());
}
#[test]
fn memory_recall_switch_keeps_pending_auto_save_sources_and_verifies_source_span() {
    let (store, ws, session) = setup();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    let text = "背景：这是工作项目。以后报告先给结论。谢谢。";
    store.append_message(&session, Role::User, text).unwrap();
    store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: false,
            auto_save: true,
        })
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    let evidence = "以后报告先给结论";
    let saved = store
        .commit_memory_job(
            &job,
            &[MemoryCandidate {
                content: evidence.into(),
                kind: MemoryKind::Preference,
                key: "report.order".into(),
                evidence: evidence.into(),
            }],
        )
        .unwrap()[0]
        .memory
        .clone()
        .unwrap();
    let sources = store
        .memory_sources(&MemoryTarget::Workspace { workspace_id: ws }, &saved.id)
        .unwrap();
    assert_eq!(&text[sources[0].byte_start..sources[0].byte_end], evidence);
    assert!(store.recall_memories(&session, "报告").unwrap().is_empty());
}

#[test]
fn memory_project_handoff_uses_live_status_decisions_and_artifact_references() {
    let (store, ws, source) = setup();
    let reader = store.create_session(&ws, "new conversation").unwrap();
    let user = store
        .append_message(&source, Role::User, "项目采用 SQLite，交付报告")
        .unwrap();
    let mut goal = SessionGoalUpdate {
        session_id: source.clone(),
        goal: "交付报告".into(),
        status: SessionGoalStatus::Active,
        token_budget: None,
    };
    store.update_session_goal(&goal).unwrap();
    store
        .set_session_plan(
            &source,
            &[
                PlanTask {
                    content: "整理材料".into(),
                    status: PlanTaskStatus::Completed,
                },
                PlanTask {
                    content: "交付报告".into(),
                    status: PlanTaskStatus::Pending,
                },
            ],
        )
        .unwrap();
    store
        .create_artifact(&source, "reports/交付.md", "md", "交付报告")
        .unwrap();
    let input:MemoryWriteParams=serde_json::from_value(json!({"target":{"scope":"workspace","workspaceId":ws},"content":"项目采用 SQLite","kind":"project"})).unwrap();
    let evidence = store.memory_evidence(&user.id).unwrap();
    let decision = store
        .write_memory(&input, Some(&evidence))
        .unwrap()
        .memory
        .unwrap();
    store
        .record_turn_outcome(&source, "failed", Some("交付步骤失败"))
        .unwrap();
    let handoff = store.memory_project_summary(&reader.id, &source).unwrap();
    assert_eq!(handoff.plan[1].status, PlanTaskStatus::Pending);
    assert_eq!(handoff.last_turn_outcome.unwrap()["status"], "failed");
    assert_eq!(handoff.artifacts[0].path, "reports/交付.md");
    assert_eq!(handoff.decisions[0].id, decision.id);
    goal.status = SessionGoalStatus::Completed;
    store.update_session_goal(&goal).unwrap();
    assert_eq!(
        store
            .memory_project_summary(&reader.id, &source)
            .unwrap()
            .goal
            .unwrap()
            .status,
        SessionGoalStatus::Completed
    );
    store
        .delete_memory(&MemoryDeleteParams {
            target: input.target,
            id: decision.id,
            expected_updated_at: decision.updated_at,
            expected_content: decision.content,
        })
        .unwrap();
    assert!(store
        .memory_project_summary(&reader.id, &source)
        .unwrap()
        .decisions
        .is_empty());
    let other = store.create_workspace("/other-project", "other").unwrap();
    let outsider = store.create_session(&other.id, "other").unwrap();
    assert!(store.memory_project_summary(&outsider.id, &source).is_err());
    store
        .update_session_memory_settings(&SessionMemorySettings {
            session_id: source.clone(),
            enabled: false,
        })
        .unwrap();
    assert!(store.memory_project_summary(&reader.id, &source).is_err());
}

#[test]
fn memory_identical_text_with_different_conditions_is_not_merged() {
    let (store, ws, _) = setup();
    let mut p:MemoryWriteParams=serde_json::from_value(json!({"target":{"scope":"workspace","workspaceId":ws},"content":"默认中文","kind":"preference","key":"user.report.language"})).unwrap();
    let first = store.write_memory(&p, None).unwrap().memory.unwrap();
    p.key = Some("user.email.language".into());
    let other = store.write_memory(&p, None).unwrap();
    assert_eq!(other.status, MemoryWriteStatus::Added);
    assert_ne!(other.memory.unwrap().id, first.id);
    assert_eq!(
        store.write_memory(&p, None).unwrap().status,
        MemoryWriteStatus::Unchanged
    );
}
