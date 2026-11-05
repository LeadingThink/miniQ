use super::*;
use miniq_protocol::*;
use serde_json::json;

fn fixture() -> (Store, String, String, String) {
    let store = Store::open_in_memory().unwrap();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    let source = store.create_workspace("/source", "source").unwrap();
    let other = store.create_workspace("/other", "other").unwrap();
    let writer = store.create_session(&source.id, "writer").unwrap();
    let reader = store.create_session(&other.id, "reader").unwrap();
    (store, source.id, writer.id, reader.id)
}

fn candidate(kind: MemoryCandidateKind, key: &str, text: &str) -> MemoryCandidate {
    MemoryCandidate {
        kind,
        key: key.into(),
        content: text.into(),
        evidence: text.into(),
    }
}

fn deletion(row: &MemoryRow) -> MemoryDeleteParams {
    MemoryDeleteParams {
        target: row
            .workspace_id
            .as_ref()
            .map_or(MemoryTarget::Global {}, |id| MemoryTarget::Workspace {
                workspace_id: id.clone(),
            }),
        id: row.id.clone(),
        expected_updated_at: row.updated_at.clone(),
        expected_content: row.content.clone(),
    }
}

#[test]
fn memory_automatic_preferences_cross_projects_without_a_matching_query() {
    let (store, workspace, writer, reader) = fixture();
    let text = "我习惯先看结论再看解释。这个项目的代码注释用英文。项目采用 SQLite。";
    let source = store.append_message(&writer, Role::User, text).unwrap();
    store
        .record_turn_outcome(&writer, "completed", None)
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    let saved = store
        .commit_memory_job(
            &job,
            &[
                candidate(
                    MemoryCandidateKind::GlobalPreference,
                    "user.explanation.order",
                    "我习惯先看结论再看解释",
                ),
                candidate(
                    MemoryCandidateKind::Preference,
                    "project.comments.language",
                    "这个项目的代码注释用英文",
                ),
                candidate(
                    MemoryCandidateKind::Project,
                    "project.database",
                    "项目采用 SQLite",
                ),
            ],
        )
        .unwrap();
    assert!(saved.iter().all(|r| r.status == MemoryWriteStatus::Added));
    let shared = saved[0].memory.as_ref().unwrap();
    assert_eq!(shared.scope, "global");
    assert!(shared.workspace_id.is_none());
    assert_eq!(shared.kind, MemoryKind::Preference);
    assert_eq!(shared.origin, "extracted");
    let evidence = store
        .memory_sources(&MemoryTarget::Global {}, &shared.id)
        .unwrap();
    assert_eq!(evidence[0].message_id, source.id);
    assert_eq!(
        &text[evidence[0].byte_start..evidence[0].byte_end],
        shared.content
    );
    let recalled = store.recall_memories(&reader, "早上好").unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].id, shared.id);
    let local = store.recall_memories(&writer, "SQLite").unwrap();
    assert_eq!(local.len(), 3);
    assert!(local
        .iter()
        .filter(|r| r.scope == "workspace")
        .all(|r| r.workspace_id.as_deref() == Some(&workspace)));
    assert!(store.claim_memory_job().unwrap().is_none());

    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: false,
            auto_save: true,
        })
        .unwrap();
    assert!(store.recall_memories(&reader, "").unwrap().is_empty());
}

#[test]
fn memory_forgotten_project_fact_cannot_return_as_a_global_preference() {
    let (store, workspace, writer, reader) = fixture();
    let text = "我习惯先看结论再看解释";
    let source = store.append_message(&writer, Role::User, text).unwrap();
    store
        .record_turn_outcome(&writer, "completed", None)
        .unwrap();
    let local = candidate(
        MemoryCandidateKind::Preference,
        "user.explanation.order",
        text,
    );
    let saved = store
        .write_memory(
            &local.write_params(&workspace),
            Some(&store.memory_evidence(&source.id).unwrap()),
        )
        .unwrap()
        .memory
        .unwrap();
    store.delete_memory(&deletion(&saved)).unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    // Even changed wording and a changed key cannot reuse the forgotten source.
    let shared = MemoryCandidate {
        kind: MemoryCandidateKind::GlobalPreference,
        key: "user.answer.format".into(),
        content: "用户偏好先给结论".into(),
        evidence: text.into(),
    };
    let result = store.commit_memory_job(&job, &[shared]).unwrap();
    assert_eq!(result[0].status, MemoryWriteStatus::NeedsConfirmation);
    assert!(store.recall_memories(&reader, "结论").unwrap().is_empty());
    assert!(store.recall_memories(&writer, "结论").unwrap().is_empty());
}

#[test]
fn memory_forgetting_shared_preference_invalidates_other_project_context() {
    let (store, _, writer, reader) = fixture();
    let text = "我习惯先看结论再看解释";
    store.append_message(&writer, Role::User, text).unwrap();
    store
        .record_turn_outcome(&writer, "completed", None)
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    let row = store
        .commit_memory_job(
            &job,
            &[candidate(
                MemoryCandidateKind::GlobalPreference,
                "user.explanation.order",
                text,
            )],
        )
        .unwrap()
        .remove(0)
        .memory
        .unwrap();
    let selected = store.recall_memories(&reader, "帮我写代码").unwrap();
    assert_eq!(selected.len(), 1);
    let anchor = store
        .append_message(&reader, Role::User, "帮我写代码")
        .unwrap();
    store
        .save_model_context(&reader, &anchor.id, &json!([]), None)
        .unwrap();
    store.delete_memory(&deletion(&row)).unwrap();
    assert!(store.get_model_context(&reader).unwrap().is_none());
    assert!(store
        .current_recalled_memories(&reader, &selected)
        .unwrap()
        .is_empty());
    store.rebuild_memory_index().unwrap();
    assert!(store.recall_memories(&reader, "结论").unwrap().is_empty());
}
