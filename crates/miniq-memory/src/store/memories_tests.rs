use super::*;

fn input(target: MemoryTarget) -> MemoryListParams {
    MemoryListParams {
        target,
        query: String::new(),
        before: None,
        limit: 20,
    }
}

fn project(id: &str) -> MemoryTarget {
    MemoryTarget::Workspace {
        workspace_id: id.into(),
    }
}

#[test]
fn memory_scope_is_exact_in_management_and_shared_only_for_agent_search() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workspace("/a", "a").unwrap();
    let b = store.create_workspace("/b", "b").unwrap();
    let private_a = store
        .create_memory(Some(&a.id), "workspace", "private A")
        .unwrap();
    let private_b = store
        .create_memory(Some(&b.id), "workspace", "private B")
        .unwrap();
    let global = store.create_memory(None, "global", "shared").unwrap();
    assert_eq!(
        store
            .list_memories(&input(project(&a.id)))
            .unwrap()
            .memories[0]
            .id,
        private_a.id
    );
    assert_eq!(
        store
            .list_memories(&input(project(&b.id)))
            .unwrap()
            .memories[0]
            .id,
        private_b.id
    );
    let globals = store
        .list_memories(&input(MemoryTarget::Global {}))
        .unwrap();
    assert_eq!(globals.memories.len(), 1);
    assert_eq!(globals.memories[0].id, global.id);
    assert_eq!(store.search_memories(None, "", 50).unwrap().len(), 1);
    let visible = store.search_memories(Some(&a.id), "", 50).unwrap();
    assert_eq!(visible.len(), 2);
    assert!(visible.iter().all(|row| row.id != private_b.id));
    assert!(store.search_memories(Some("missing"), "", 50).is_err());
    assert!(store.list_memories(&input(project("missing"))).is_err());
    assert!(store.create_memory(Some(&a.id), "global", "wrong").is_err());
    assert!(store.create_memory(None, "workspace", "wrong").is_err());
    assert!(store
        .create_memory(Some("missing"), "workspace", "wrong")
        .is_err());
    assert!(store.create_memory(None, "global", " \n ").is_err());
}

#[test]
fn pagination_is_stable_with_equal_timestamps_and_preserves_full_text() {
    let store = Store::open_in_memory().unwrap();
    let content = "完整中文内容 % _ \\ tail".repeat(2000);
    for _ in 0..5 {
        store.create_memory(None, "global", &content).unwrap();
    }
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE memories SET updated_at = '2026-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
    let mut request = input(MemoryTarget::Global {});
    request.limit = 2;
    let mut ids = Vec::new();
    loop {
        let page = store.list_memories(&request).unwrap();
        assert!(page.memories.len() <= 2);
        for item in &page.memories {
            assert_eq!(item.content, content);
            ids.push(item.id.clone());
        }
        if page.next_cursor.is_none() {
            break;
        }
        request.before = page.next_cursor;
    }
    assert_eq!(ids.len(), 5);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 5);
}

#[test]
fn search_treats_sql_like_wildcards_and_backslashes_literally() {
    let store = Store::open_in_memory().unwrap();
    store
        .create_memory(None, "global", "C:\\files\\100%_done")
        .unwrap();
    store.create_memory(None, "global", "no wildcard").unwrap();
    for query in ["%", "_", "\\", "100%_done"] {
        let mut request = input(MemoryTarget::Global {});
        request.query = query.into();
        assert_eq!(store.list_memories(&request).unwrap().memories.len(), 1);
        assert_eq!(store.search_memories(None, query, 20).unwrap().len(), 1);
    }
}

#[test]
fn delete_is_atomic_and_requires_the_displayed_scope_and_version() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workspace("/a", "a").unwrap();
    let b = store.create_workspace("/b", "b").unwrap();
    let item = store
        .create_memory(Some(&a.id), "workspace", "private")
        .unwrap();
    let mut request = MemoryDeleteParams {
        target: project(&b.id),
        id: item.id.clone(),
        expected_updated_at: item.updated_at.clone(),
        expected_content: item.content.clone(),
    };
    assert!(store.delete_memory(&request).is_err());
    request.target = MemoryTarget::Global {};
    assert!(store.delete_memory(&request).is_err());
    request.target = project(&a.id);
    request.expected_updated_at = "stale".into();
    assert!(store.delete_memory(&request).is_err());
    assert_eq!(
        store
            .list_memories(&input(project(&a.id)))
            .unwrap()
            .memories
            .len(),
        1
    );
    request.expected_updated_at = item.updated_at;
    // A concurrent content change can share the same clock value. Compare the
    // displayed text as well so confirming an old card cannot erase new facts.
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE memories SET content = 'updated fact' WHERE id = ?1",
            [&item.id],
        )
        .unwrap();
    assert!(store.delete_memory(&request).is_err());
    request.expected_content = "updated fact".into();
    store.delete_memory(&request).unwrap();
    assert!(store
        .list_memories(&input(project(&a.id)))
        .unwrap()
        .memories
        .is_empty());
    assert!(store.delete_memory(&request).is_err());
}

#[test]
fn malformed_legacy_rows_are_not_exposed_as_global_data() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workspace("/a", "a").unwrap();
    let item = store
        .create_memory(Some(&a.id), "workspace", "private")
        .unwrap();
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE memories SET scope = 'global' WHERE id = ?1",
            [&item.id],
        )
        .unwrap();
    assert!(store.search_memories(None, "", 20).unwrap().is_empty());
    assert!(store
        .list_memories(&input(MemoryTarget::Global {}))
        .unwrap()
        .memories
        .is_empty());
    let retained: u32 = store
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id = ?1",
            [&item.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1);
}
