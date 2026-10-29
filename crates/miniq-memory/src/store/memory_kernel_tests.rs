use super::*;
use miniq_protocol::*;
use serde_json::json;

fn input(workspace: &str, content: &str) -> MemoryWriteParams {
    serde_json::from_value(json!({"target":{"scope":"workspace","workspaceId":workspace},"content":content,"kind":"preference","key":"user.report.order"})).unwrap()
}
fn fixture() -> (Store, String, String) {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("/memory", "memory").unwrap();
    let session = store.create_session(&ws.id, "source").unwrap();
    (store, ws.id, session.id)
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
fn memory_versions_deduplicate_correct_and_reject_stale_updates() {
    let (store, ws, session) = fixture();
    let source = store
        .append_message(&session, Role::User, "工作报告先给结论")
        .unwrap();
    let evidence = store.memory_evidence(&source.id).unwrap();
    let mut p = input(&ws, &source.content);
    let first = store.write_memory(&p, Some(&evidence)).unwrap();
    assert_eq!(first.status, MemoryWriteStatus::Added);
    let first = first.memory.unwrap();
    assert_eq!(
        store.write_memory(&p, Some(&evidence)).unwrap().status,
        MemoryWriteStatus::Unchanged
    );
    p.content = "工作报告先解释背景".into();
    assert_eq!(
        store.write_memory(&p, Some(&evidence)).unwrap().status,
        MemoryWriteStatus::NeedsConfirmation
    );
    p.replaces = Some(MemoryReplacement {
        id: first.id.clone(),
        expected_revision: 1,
    });
    let corrected = store.write_memory(&p, Some(&evidence)).unwrap();
    assert_eq!(corrected.status, MemoryWriteStatus::Updated);
    assert_eq!(corrected.memory.unwrap().revision, 2);
    assert_eq!(
        store.write_memory(&p, Some(&evidence)).unwrap().status,
        MemoryWriteStatus::NeedsConfirmation
    );
    let current = store.search_memories(Some(&ws), "报告", 10).unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].content, p.content);
    assert_eq!(
        store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM memory_versions", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        2
    );
}
#[test]
fn memory_forget_removes_versions_index_snapshot_and_blocks_source_replay() {
    let (store, ws, session) = fixture();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    let source = store
        .append_message(&session, Role::User, "以后报告先给结论")
        .unwrap();
    store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    let evidence = store.memory_evidence(&source.id).unwrap();
    let saved = store
        .write_memory(&input(&ws, &source.content), Some(&evidence))
        .unwrap()
        .memory
        .unwrap();
    store.recall_memories(&session, "报告").unwrap();
    store
        .save_model_context(&session, &source.id, &json!(["old summary"]), None)
        .unwrap();
    store.delete_memory(&deletion(&saved)).unwrap();
    assert!(store.get_model_context(&session).unwrap().is_none());
    let candidate = MemoryCandidate {
        content: "工作报告结论在前".into(),
        kind: MemoryKind::Preference,
        key: "different.key".into(),
        evidence: source.content.clone(),
    };
    assert!(store.commit_memory_job(&job, &[candidate.clone()]).is_err());
    store
        .conn
        .lock()
        .unwrap()
        .execute("UPDATE memory_jobs SET lease_until=0", [])
        .unwrap();
    let replay = store.claim_memory_job().unwrap().unwrap();
    assert_eq!(
        store.commit_memory_job(&replay, &[candidate]).unwrap()[0].status,
        MemoryWriteStatus::NeedsConfirmation
    );
    store.rebuild_memory_index().unwrap();
    assert!(store
        .search_memories(Some(&ws), "报告", 10)
        .unwrap()
        .is_empty());
    let conn = store.conn.lock().unwrap();
    for table in [
        "memories",
        "memory_versions",
        "memory_sources",
        "memory_fts",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn memory_source_deletion_and_changed_hash_invalidate_current_fact() {
    let (store, ws, session) = fixture();
    let source = store
        .append_message(&session, Role::User, "项目预算是 38000 元")
        .unwrap();
    let evidence = store.memory_evidence(&source.id).unwrap();
    let p = input(&ws, &source.content);
    store.write_memory(&p, Some(&evidence)).unwrap();
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE messages SET content='预算变了' WHERE id=?1",
            [&source.id],
        )
        .unwrap();
    assert!(store
        .search_memories(Some(&ws), "预算", 10)
        .unwrap()
        .is_empty());
    assert!(store.write_memory(&p, Some(&evidence)).is_err());
    let evidence = store.memory_evidence(&source.id).unwrap();
    store.write_memory(&p, Some(&evidence)).unwrap();
    store.delete_session(&session).unwrap();
    assert!(store
        .search_memories(Some(&ws), "预算", 10)
        .unwrap()
        .is_empty());
}
#[test]
fn memory_recall_is_scoped_budgeted_and_user_exceptions_do_not_write() {
    let (store, ws, session) = fixture();
    let other = store.create_workspace("/other", "other").unwrap();
    let mut p = input(&ws, "工作报告先给结论");
    store.write_memory(&p, None).unwrap();
    p.target = MemoryTarget::Workspace {
        workspace_id: other.id,
    };
    p.content = "保密项目预算 9000".into();
    store.write_memory(&p, None).unwrap();
    let chat = store.create_session(&ws, "new chat").unwrap();
    assert_eq!(
        store
            .recall_memories(&chat.id, "这次先讲背景")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.recall_memories(&session, "报告").unwrap()[0].content,
        "工作报告先给结论"
    );
    store
        .update_session_memory_settings(&SessionMemorySettings {
            session_id: chat.id.clone(),
            enabled: false,
        })
        .unwrap();
    assert!(store.recall_memories(&chat.id, "报告").unwrap().is_empty());
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: false,
            auto_save: false,
        })
        .unwrap();
    assert!(store.recall_memories(&session, "报告").unwrap().is_empty());
}
#[test]
fn memory_search_chinese_names_dates_money_and_mixed_language() {
    let (store, ws, _) = fixture();
    for (key, content) in [
        ("owner", "李雷负责 miniQ Rust 内核"),
        ("budget", "项目预算 38000 元，截止 2026-11-02"),
        ("style", "偏好中文回复，报告先给结论"),
    ] {
        let mut p = input(&ws, content);
        p.key = Some(key.into());
        store.write_memory(&p, None).unwrap();
    }
    for query in [
        "李雷",
        "Rust 内核",
        "38000",
        "2026-11-02",
        "中文",
        "报告结论",
    ] {
        assert!(
            !store
                .search_memories(Some(&ws), query, 10)
                .unwrap()
                .is_empty(),
            "{query}"
        );
    }
    assert!(store
        .search_memories(Some(&ws), "火星天气", 10)
        .unwrap()
        .is_empty());
}
#[test]
fn memory_jobs_paginate_every_byte_and_commit_cursor_atomically_across_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.db");
    let store = Store::open(&path).unwrap();
    let ws = store.create_workspace("/restart", "restart").unwrap();
    let session = store.create_session(&ws.id, "source").unwrap();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    let text = "完整中文abcdef\n".repeat(1400);
    store
        .append_message(&session.id, Role::User, &text)
        .unwrap();
    store
        .record_turn_outcome(&session.id, "completed", None)
        .unwrap();
    let first = store.claim_memory_job().unwrap().unwrap();
    assert!(!first.finished);
    assert!(store.claim_memory_job().unwrap().is_none());
    let invalid = MemoryCandidate {
        content: "假证据".into(),
        kind: MemoryKind::Fact,
        key: "x".into(),
        evidence: "不在原文".into(),
    };
    assert!(store.commit_memory_job(&first, &[invalid]).is_err());
    store.commit_memory_job(&first, &[]).unwrap();
    let mut rebuilt = first.content;
    drop(store);
    let store = Store::open(&path).unwrap();
    while let Some(job) = store.claim_memory_job().unwrap() {
        rebuilt.push_str(&job.content);
        store.commit_memory_job(&job, &[]).unwrap();
    }
    assert_eq!(rebuilt, text);
}
#[test]
fn memory_jobs_do_not_backfill_failed_turns_or_resume_after_consent_revocation() {
    let (store, _, session) = fixture();
    store
        .append_message(&session, Role::User, "old private content")
        .unwrap();
    store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    assert!(store.claim_memory_job().unwrap().is_none());
    store
        .append_message(&session, Role::User, "failed work")
        .unwrap();
    store.record_turn_outcome(&session, "failed", None).unwrap();
    store
        .append_message(&session, Role::User, "confirmed project decision")
        .unwrap();
    store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    assert_eq!(job.content, "confirmed project decision");
    store
        .update_memory_settings(&MemorySettings::default())
        .unwrap();
    assert!(store.commit_memory_job(&job, &[]).is_err());
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    assert!(store.claim_memory_job().unwrap().is_none());
}

#[test]
fn memory_forgetting_rejects_a_late_checkpoint_but_preserves_actual_reply() {
    let (store, ws, session) = fixture();
    let user = store
        .append_message(&session, Role::User, "记住偏好")
        .unwrap();
    let saved = store
        .write_memory(&input(&ws, "工作报告先给结论"), None)
        .unwrap()
        .memory
        .unwrap();
    let generation = store.memory_generation().unwrap();
    store.delete_memory(&deletion(&saved)).unwrap();
    let reply = Message {
        id: "late".into(),
        session_id: session.clone(),
        role: Role::Assistant,
        assistant_kind: Some(AssistantMessageKind::Final),
        content: "已经发送的回复".into(),
        attachments: vec![],
        created_at: now_iso(),
        turn_timing: None,
        steered: false,
    };
    store
        .save_guarded_context_with_message(
            &session,
            &reply.id,
            &json!(["stale opaque context"]),
            None,
            Some(&reply),
            generation,
        )
        .unwrap();
    assert!(store.get_model_context(&session).unwrap().is_none());
    assert_eq!(store.list_messages(&session).unwrap().len(), 2);
    assert_eq!(store.list_messages(&session).unwrap()[0].id, user.id);
}

#[test]
fn memory_branch_history_is_not_new_evidence_and_side_chats_never_extract() {
    let (store, _, session) = fixture();
    store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    store
        .append_message(&session, Role::User, "旧对话里的私人偏好")
        .unwrap();
    let answer = store
        .append_message(&session, Role::Assistant, "已记录历史")
        .unwrap();
    let branch = store
        .fork_session(
            &session,
            Some(&answer.id),
            None,
            SessionForkMode::Branch,
            None,
        )
        .unwrap();
    store
        .append_message(&branch.id, Role::User, "新项目约束")
        .unwrap();
    store
        .record_turn_outcome(&branch.id, "completed", None)
        .unwrap();
    let job = store.claim_memory_job().unwrap().unwrap();
    assert_eq!(job.content, "新项目约束");
    store.commit_memory_job(&job, &[]).unwrap();
    assert!(store.claim_memory_job().unwrap().is_none());
    let side = store
        .fork_session(
            &session,
            Some(&answer.id),
            None,
            SessionForkMode::Side,
            Some("临时侧聊"),
        )
        .unwrap();
    store
        .append_message(&side.id, Role::User, "侧聊中的临时偏好")
        .unwrap();
    store
        .record_turn_outcome(&side.id, "completed", None)
        .unwrap();
    assert!(store.claim_memory_job().unwrap().is_none());
    assert!(store.recall_memories(&side.id, "偏好").unwrap().is_empty());
}
