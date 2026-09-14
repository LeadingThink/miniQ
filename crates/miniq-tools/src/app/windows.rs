//! Window discovery uses a frozen page source: changing z-order, closing a
//! window, or opening another one cannot shift results between offset pages.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use super::{
    backend::{AppBackend, AppWindow},
    input::AppInput,
    LEASE_TIME,
};
use crate::ToolContext;

pub(super) type WindowLists = Arc<Mutex<HashMap<String, WindowList>>>;

pub(super) struct WindowList {
    id: String,
    windows: Vec<AppWindow>,
    pid: Option<i32>,
    created: Instant,
}

pub(super) fn page(
    shared: &WindowLists,
    backend: &dyn AppBackend,
    ctx: &ToolContext,
    input: &AppInput,
) -> Result<Value, String> {
    let mut lists = shared.lock().map_err(|_| "window list lock poisoned")?;
    lists.retain(|_, list| list.created.elapsed() < LEASE_TIME);
    if input.observation_id.is_none() {
        let mut windows = backend
            .windows()?
            .into_iter()
            .filter(|w| input.pid.is_none_or(|pid| w.pid == pid))
            .collect::<Vec<_>>();
        windows.sort_by_key(|window| (window.pid, window.window_id));
        let id = uuid::Uuid::new_v4().to_string();
        lists.insert(
            ctx.task_scope.clone(),
            WindowList {
                id: id.clone(),
                windows,
                pid: input.pid,
                created: Instant::now(),
            },
        );
        let shared = shared.clone();
        let owner = ctx.task_scope.clone();
        let cancel = ctx.cancellation.clone();
        tokio::spawn(async move {
            tokio::select! { _ = cancel.cancelled() => {}, _ = tokio::time::sleep(LEASE_TIME) => {} }
            if let Ok(mut lists) = shared.lock() {
                if lists.get(&owner).is_some_and(|list| list.id == id) {
                    lists.remove(&owner);
                }
            }
        });
    }
    let list = lists
        .get(&ctx.task_scope)
        .ok_or("window list expired; call windows without observationId")?;
    if input
        .observation_id
        .as_ref()
        .is_some_and(|id| id != &list.id)
        || input.pid != list.pid
    {
        return Err(
            "window page does not belong to this task or filter; start a new window list".into(),
        );
    }
    let total = list.windows.len();
    if input.offset > total {
        return Err("window page offset exceeds total".into());
    }
    let end = input.offset.saturating_add(input.limit).min(total);
    Ok(
        json!({"windows": list.windows[input.offset..end], "total": total, "observationId": list.id,
        "nextOffset": (end < total).then_some(end), "untrustedContent": true}),
    )
}
