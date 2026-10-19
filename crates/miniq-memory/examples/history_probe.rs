//! Measure `session.history` paging on a copy of a real database.
//!
//! cargo run --release -p miniq-memory --example history_probe -- COPY.db [SESSIONS]
//!
//! Always pass a copy: opening a store may run migrations.

use std::time::Instant;

use miniq_memory::Store;
use miniq_protocol::{HistoryPage, HistoryParams, ProcessRecordsParams};
use serde_json::json;

fn params(session: &str, limit: u32, view: &str) -> HistoryParams {
    serde_json::from_value(json!({"sessionId": session, "limit": limit, "view": view})).unwrap()
}

fn report(label: &str, page: &HistoryPage, started: Instant) {
    let bytes = serde_json::to_vec(page).unwrap().len();
    println!(
        "  {label:<34} messages={:<3} tools={:<3} summaries={:<3} bytes={:<7} ms={:.1}",
        page.messages.len(),
        page.tool_calls.len(),
        page.process_summaries.len(),
        bytes,
        started.elapsed().as_secs_f64() * 1000.0
    );
}

/// Raw pages needed until `wanted` visible (user/assistant) messages are loaded.
fn raw_until_visible(store: &Store, session: &str, wanted: usize) {
    let mut input = params(session, 40, "raw");
    let started = Instant::now();
    let (mut pages, mut rows, mut visible, mut bytes) = (0, 0, 0, 0);
    while visible < wanted {
        let page = store.history_page(&input).unwrap();
        pages += 1;
        rows += page.messages.len() + page.tool_calls.len();
        bytes += serde_json::to_vec(&page).unwrap().len();
        visible += page.messages.len();
        input.before = page.next_cursor;
        if input.before.is_none() {
            break;
        }
    }
    println!(
        "  raw, until {wanted} visible messages: pages={pages} rows={rows} visible={visible} bytes={bytes} ms={:.1}",
        started.elapsed().as_secs_f64() * 1000.0
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("database copy path");
    let store = Store::open(std::path::Path::new(&path)).unwrap();
    let sessions = args.collect::<Vec<_>>();
    for session in sessions {
        println!("session {session}");
        let mut raw = params(&session, 40, "raw");
        for step in 1..=3 {
            let started = Instant::now();
            let page = store.history_page(&raw).unwrap();
            report(&format!("raw limit=40 page {step}"), &page, started);
            raw.before = page.next_cursor;
        }
        raw_until_visible(&store, &session, 40);
        let mut visible = params(&session, 40, "visible");
        let mut first = None;
        for step in 1..=3 {
            let started = Instant::now();
            let page = store.history_page(&visible).unwrap();
            report(&format!("visible limit=40 page {step}"), &page, started);
            first.get_or_insert_with(|| page.clone());
            visible.before = page.next_cursor;
        }
        let started = Instant::now();
        let page = store
            .history_page(&params(&session, 16, "visible"))
            .unwrap();
        report("visible limit=16 (remote open)", &page, started);
        let largest = first
            .iter()
            .flat_map(|page| page.process_summaries.iter())
            .max_by_key(|summary| summary.record_count);
        if let Some(summary) = largest {
            let started = Instant::now();
            let page = store
                .process_records_page(&ProcessRecordsParams {
                    session_id: session.clone(),
                    turn_id: summary.turn_id.clone(),
                    before: None,
                    limit: 100,
                    include_internal: false,
                })
                .unwrap();
            report(
                &format!("processRecords 100 of {}", summary.record_count),
                &page,
                started,
            );
        }
    }
}
