use std::collections::{BTreeSet, HashSet};

use miniq_protocol::{
    HistoryFilter, HistoryPage, HistoryParams, HistoryView, ProcessRecordsParams,
};
use rusqlite::params;
use serde_json::json;

use super::*;
use crate::Store;

/// A session with explicit timestamps so ordering is deterministic.
struct Fixture {
    store: Store,
    session: String,
    clock: u32,
    /// Message ids a turn must show, oldest first.
    visible: Vec<String>,
    /// Ids of every folded record, per opening user message (`""` for the head).
    process: Vec<(String, Vec<String>)>,
}

impl Fixture {
    fn new() -> Self {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/visible", "visible").unwrap();
        let session = store.create_session(&workspace.id, "visible").unwrap().id;
        Self {
            store,
            session,
            clock: 0,
            visible: Vec::new(),
            process: Vec::new(),
        }
    }

    fn at(&mut self) -> String {
        self.clock += 1;
        format!("2026-01-01T00:00:{:02}.000000Z", self.clock)
    }

    fn message(&mut self, id: &str, role: &str, kind: Option<&str>, steered: bool) {
        let at = self.at();
        self.store
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO messages (id, session_id, role, content, created_at, steered, assistant_kind)
                 VALUES (?1, ?2, ?3, ?1, ?4, ?5, ?6)",
                params![id, self.session, role, at, steered, kind],
            )
            .unwrap();
    }

    fn tool(&mut self, id: &str, name: &str, status: &str) {
        let at = self.at();
        self.store
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO tool_calls (id, session_id, tool_name, input_json, output_json, status, created_at)
                 VALUES (?1, ?2, ?3, '{\"big\":true}', '{\"big\":true}', ?4, ?5)",
                params![id, self.session, name, status, at],
            )
            .unwrap();
    }

    fn fold(&mut self, turn: &str, id: &str) {
        match self.process.iter_mut().find(|(key, _)| key == turn) {
            Some((_, ids)) => ids.push(id.into()),
            None => self.process.push((turn.into(), vec![id.into()])),
        }
    }

    /// user, `tools` tool calls (the second fails, the third writes a file),
    /// commentary, a steering message and a final reply.
    fn turn(&mut self, name: &str, tools: usize) {
        let user = format!("user-{name}");
        self.message(&user, "user", None, false);
        self.visible.push(user.clone());
        for index in 0..tools {
            let id = format!("tool-{name}-{index}");
            let (tool, status) = match index {
                1 => ("shell_run", "failed"),
                2 => ("apply_patch", "succeeded"),
                _ => ("file_read", "succeeded"),
            };
            self.tool(&id, tool, status);
            self.fold(&user, &id);
        }
        let note = format!("note-{name}");
        self.message(&note, "assistant", Some("commentary"), false);
        self.fold(&user, &note);
        let steer = format!("steer-{name}");
        self.message(&steer, "user", None, true);
        self.fold(&user, &steer);
        let reply = format!("reply-{name}");
        self.message(&reply, "assistant", Some("final"), false);
        self.visible.push(reply);
    }

    fn params(&self, limit: u32) -> HistoryParams {
        serde_json::from_value(json!({
            "sessionId": self.session, "limit": limit, "view": "visible"
        }))
        .unwrap()
    }

    fn visible_pages(&self, limit: u32) -> Vec<HistoryPage> {
        let mut input = self.params(limit);
        let mut pages = Vec::new();
        loop {
            let page = self.store.history_page(&input).unwrap();
            input.before = page.next_cursor.clone();
            pages.push(page);
            if input.before.is_none() {
                return pages;
            }
        }
    }

    fn process_ids(&self, turn: Option<&str>, limit: u32) -> Vec<String> {
        let mut input = ProcessRecordsParams {
            session_id: self.session.clone(),
            turn_id: turn.map(str::to_string),
            before: None,
            limit,
            include_internal: false,
        };
        let mut ids = Vec::new();
        loop {
            let page = self.store.process_records_page(&input).unwrap();
            assert!(page.process_summaries.is_empty());
            assert!(page.tool_calls.iter().all(|tool| tool.payload_deferred
                && tool.call.input.is_null()
                && tool.call.output.is_none()));
            // Pages arrive newest page first, each page oldest first.
            let mut page_ids = page
                .messages
                .iter()
                .map(|m| (m.created_at.clone(), m.id.clone()))
                .chain(
                    page.tool_calls
                        .iter()
                        .map(|t| (t.call.created_at.clone(), t.call.id.clone())),
                )
                .collect::<Vec<_>>();
            page_ids.sort();
            assert!(page_ids.len() <= limit as usize);
            ids.splice(0..0, page_ids.into_iter().map(|(_, id)| id));
            input.before = page.next_cursor;
            if input.before.is_none() {
                return ids;
            }
        }
    }
}

#[test]
fn visible_pages_cover_every_turn_once_and_summaries_match_the_records() {
    let mut f = Fixture::new();
    f.tool("head-tool", "file_read", "succeeded");
    f.fold("", "head-tool");
    for (name, tools) in [("a", 5), ("b", 0), ("c", 3), ("d", 12), ("e", 1)] {
        f.turn(name, tools);
    }
    for limit in [1, 2, 3, 100] {
        let pages = f.visible_pages(limit);
        let shown = pages
            .iter()
            .rev()
            .flat_map(|page| page.messages.iter().map(|m| m.id.clone()))
            .collect::<Vec<_>>();
        assert_eq!(shown, f.visible, "limit {limit}");
        let mut seen = HashSet::new();
        assert!(shown.iter().all(|id| seen.insert(id.clone())));
        for page in &pages {
            assert!(page.tool_calls.is_empty());
            // Whole turns only: a page never splits a turn.
            let opens = page
                .messages
                .iter()
                .filter(|m| m.id.starts_with("user-"))
                .count();
            assert_eq!(
                opens,
                page.process_summaries
                    .iter()
                    .filter(|s| s.turn_id.is_some())
                    .count()
            );
        }
        // Newest page first: cursors move strictly backwards.
        let cursors = pages
            .iter()
            .filter_map(|page| page.next_cursor.as_ref())
            .map(|c| (c.at.clone(), c.id.clone()))
            .collect::<Vec<_>>();
        assert!(
            cursors.windows(2).all(|pair| pair[0] > pair[1]),
            "{cursors:?}"
        );
        let summaries = pages
            .iter()
            .rev()
            .flat_map(|page| page.process_summaries.clone())
            .collect::<Vec<_>>();
        assert_eq!(summaries.len(), f.process.len());
        for (summary, (turn, ids)) in summaries.iter().zip(&f.process) {
            assert_eq!(summary.turn_id.as_deref().unwrap_or(""), turn);
            assert_eq!(summary.record_count as usize, ids.len());
            assert_eq!(
                summary.record_count,
                summary.tool_call_count + summary.message_count
            );
            assert_eq!(
                summary.status_counts.values().sum::<u32>(),
                summary.tool_call_count
            );
        }
    }
    let pages = f.visible_pages(100);
    let summaries = &pages[0].process_summaries;
    let turn_c = summaries
        .iter()
        .find(|s| s.turn_id.as_deref() == Some("user-c"))
        .unwrap();
    assert_eq!(turn_c.tool_call_count, 3);
    assert_eq!(turn_c.status_counts.get("failed"), Some(&1));
    assert_eq!(turn_c.status_counts.get("succeeded"), Some(&2));
    assert_eq!(turn_c.file_write_count, 1);
    assert_eq!(turn_c.message_count, 2);
    assert!(turn_c.first_at < turn_c.last_at);
    let turn_b = summaries
        .iter()
        .find(|s| s.turn_id.as_deref() == Some("user-b"))
        .unwrap();
    assert_eq!((turn_b.tool_call_count, turn_b.record_count), (0, 2));

    // Every folded record is returned exactly once by the on-demand pages.
    let mut all = BTreeSet::new();
    for (turn, ids) in &f.process {
        let expected = ids.iter().cloned().collect::<BTreeSet<_>>();
        for limit in [1, 4, 100] {
            let got = f.process_ids((!turn.is_empty()).then_some(turn.as_str()), limit);
            assert_eq!(got.len(), ids.len(), "{turn} limit {limit}");
            assert_eq!(got.iter().cloned().collect::<BTreeSet<_>>(), expected);
        }
        all.extend(expected);
    }
    let total: usize = f.process.iter().map(|(_, ids)| ids.len()).sum();
    assert_eq!(all.len(), total);
}

#[test]
fn legacy_trailing_reply_is_visible_and_earlier_unphased_replies_are_folded() {
    let mut f = Fixture::new();
    f.message("user-1", "user", None, false);
    f.message("legacy-early", "assistant", None, false);
    f.tool("t1", "file_read", "succeeded");
    f.message("legacy-last", "assistant", None, false);
    f.message("user-2", "user", None, false);
    f.message("legacy-mid", "assistant", None, false);
    f.tool("t2", "file_read", "succeeded");
    let pages = f.visible_pages(10);
    let ids = pages[0]
        .messages
        .iter()
        .map(|m| m.id.as_str())
        .collect::<Vec<_>>();
    // The second turn ends with a tool call, so none of its replies is final.
    assert_eq!(ids, ["user-1", "legacy-last", "user-2"]);
    assert_eq!(pages[0].process_summaries[0].record_count, 2);
    assert_eq!(pages[0].process_summaries[1].record_count, 2);
    assert_eq!(f.process_ids(Some("user-2"), 10), ["legacy-mid", "t2"]);
}

#[test]
fn internal_rows_are_counted_only_when_requested() {
    let mut f = Fixture::new();
    f.message("user-1", "user", None, false);
    f.tool("update", "task_update", "succeeded");
    f.tool("read", "file_read", "succeeded");
    f.message("sys", "system", None, false);
    f.message("reply", "assistant", Some("final"), false);
    let page = &f.visible_pages(10)[0];
    assert_eq!(page.process_summaries[0].record_count, 1);
    let mut input = f.params(10);
    input.include_internal = true;
    let internal = f.store.history_page(&input).unwrap();
    assert_eq!(internal.process_summaries[0].record_count, 3);
    assert_eq!(f.process_ids(Some("user-1"), 10), ["read"]);
}

#[test]
fn visible_view_rejects_filters_and_other_sessions_cannot_read_a_turn() {
    let mut f = Fixture::new();
    f.turn("a", 2);
    let mut input = f.params(10);
    input.filter = HistoryFilter::Errors;
    assert!(f.store.history_page(&input).is_err());
    let mut input = f.params(10);
    input.query = "a".into();
    assert!(f.store.history_page(&input).is_err());
    let mut input = f.params(10);
    input.include_payloads = true;
    assert!(f.store.history_page(&input).is_err());
    assert_eq!(input.view, HistoryView::Visible);

    let other = f.store.create_workspace("/tmp/other", "other").unwrap();
    let other = f.store.create_session(&other.id, "other").unwrap();
    let foreign = ProcessRecordsParams {
        session_id: other.id,
        turn_id: Some("user-a".into()),
        before: None,
        limit: 10,
        include_internal: false,
    };
    assert!(f.store.process_records_page(&foreign).is_err());
    let steered = ProcessRecordsParams {
        turn_id: Some("steer-a".into()),
        session_id: f.session.clone(),
        ..foreign
    };
    assert!(f.store.process_records_page(&steered).is_err());
}

#[test]
fn raw_view_stays_the_default_and_filters_by_tool_name() {
    let mut f = Fixture::new();
    f.turn("a", 3);
    let raw: HistoryParams =
        serde_json::from_value(json!({"sessionId": f.session, "limit": 100})).unwrap();
    let page = f.store.history_page(&raw).unwrap();
    assert_eq!(page.messages.len(), 4);
    assert_eq!(page.tool_calls.len(), 3);
    let by_tool: HistoryParams = serde_json::from_value(
        json!({"sessionId": f.session, "limit": 100, "toolName": "apply_patch"}),
    )
    .unwrap();
    let page = f.store.history_page(&by_tool).unwrap();
    assert!(page.messages.is_empty());
    assert_eq!(page.tool_calls.len(), 1);
}

#[test]
fn turn_summaries_are_answered_from_the_covering_index() {
    let f = Fixture::new();
    let (filter, _) = bounds(
        &TurnRange {
            start: Some(HistoryCursor {
                at: "a".into(),
                id: "a".into(),
            }),
            end: Some(HistoryCursor {
                at: "b".into(),
                id: "b".into(),
            }),
        },
        None,
    );
    let conn = f.store.conn.lock().unwrap();
    let plan = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {}", tool_summary_sql(&filter)))
        .unwrap()
        .query_map(
            rusqlite::named_params! {
                ":sid": "s", ":internal": 0, ":start_at": "a", ":start_id": "a",
                ":end_at": "b", ":end_id": "b",
            },
            |row| row.get::<_, String>(3),
        )
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n");
    assert!(
        plan.contains("COVERING INDEX idx_tool_calls_session_timeline"),
        "{plan}"
    );
}
