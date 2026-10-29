use super::*;
use miniq_protocol::{MemoryListParams, MemoryTarget};

#[test]
fn memory_migration_preserves_legacy_text_scope_and_unknown_provenance() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)",
    )
    .unwrap();
    for (name, sql) in MIGRATIONS
        .iter()
        .filter(|(name, _)| *name != "0029_personal_memory")
    {
        conn.execute_batch(sql).unwrap();
        conn.execute("INSERT INTO schema_migrations VALUES (?1,'before')", [name])
            .unwrap();
    }
    let content = "完整原文\n偏好中文，保留条件。".repeat(2000);
    conn.execute(
        "INSERT INTO memories VALUES ('legacy',NULL,'global',?1,'{}','old','old')",
        [&content],
    )
    .unwrap();
    let store = Store::init(conn).unwrap();
    let page = store
        .list_memories(&MemoryListParams {
            target: MemoryTarget::Global {},
            query: String::new(),
            before: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(page.memories[0].content, content);
    assert_eq!(page.memories[0].origin, "unknown");
    assert_eq!(page.memories[0].revision, 1);
    assert!(store
        .memory_sources(&MemoryTarget::Global {}, "legacy")
        .unwrap()
        .is_empty());
    assert_eq!(
        store.search_memories(None, "中文", 10).unwrap()[0].id,
        "legacy"
    );
}

#[test]
#[ignore = "manual 10k-row local recall latency baseline"]
fn memory_recall_latency_10000_rows() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("/benchmark", "benchmark").unwrap();
    let session = store.create_session(&ws.id, "benchmark").unwrap();
    {
        let mut conn = store.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        for n in 0..10000 {
            tx.execute("INSERT INTO memories(id,workspace_id,scope,content,metadata_json,created_at,updated_at,kind) VALUES (?1,?2,'workspace',?3,'{}','now','now',?4)",
                params![format!("m{n}"),ws.id,format!("项目 {n} 使用 Rust，预算 {} 元，李雷负责第 {} 组",30000+n,n%100),if n<5 {"preference"} else {"project"}]).unwrap();
        }
        memory_index::rebuild(&tx).unwrap();
        tx.commit().unwrap();
    }
    let mut timings = Vec::new();
    for _ in 0..40 {
        let start = std::time::Instant::now();
        assert!(!store
            .recall_memories(&session.id, "李雷负责 Rust 项目预算")
            .unwrap()
            .is_empty());
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    eprintln!(
        "memory recall 10000 rows: p50={:.2}ms p95={:.2}ms",
        timings[20], timings[38]
    );
}
