//! Read-only Git queries belong to their requesting socket, unlike model tasks.

use std::collections::HashMap;

use miniq_protocol::{RequestId, RpcResponse};
use serde::Deserialize;
use tokio::task::{AbortHandle, Id, JoinSet};

#[derive(Default)]
pub(super) struct GitQueries {
    tasks: JoinSet<RpcResponse>,
    keys: HashMap<Id, String>,
    active: HashMap<String, (Id, AbortHandle)>,
}

pub(super) fn cancellable(method: &str) -> bool {
    matches!(method, "git.status" | "git.diff" | "git.branches")
}

impl GitQueries {
    pub fn spawn<F>(&mut self, request_id: &RequestId, task: F)
    where
        F: std::future::Future<Output = RpcResponse> + Send + 'static,
    {
        // JSON encoding keeps numeric IDs distinct from string IDs.
        let key = serde_json::to_string(request_id).expect("request ID serialization");
        let handle = self.tasks.spawn(task);
        let id = handle.id();
        self.keys.insert(id, key.clone());
        if let Some((_, previous)) = self.active.insert(key, (id, handle)) {
            previous.abort();
        }
    }

    /// Cancellation notifications bypass the dispatch semaphore. They can
    /// only release these audited reads, never a session turn or a write.
    pub fn cancel_notification(&mut self, text: &str) -> bool {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Notification {
            jsonrpc: String,
            method: String,
            params: Params,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            request_id: RequestId,
        }
        let Ok(notification) = serde_json::from_str::<Notification>(text) else {
            return false;
        };
        if notification.jsonrpc != "2.0" || notification.method != "request.cancel" {
            return false;
        }
        let key = serde_json::to_string(&notification.params.request_id)
            .expect("request ID serialization");
        if let Some((_, task)) = self.active.remove(&key) {
            task.abort();
        }
        true
    }

    pub async fn join_next(&mut self) -> Option<RpcResponse> {
        let Some(joined) = self.tasks.join_next_with_id().await else {
            return std::future::pending().await;
        };
        let id = match &joined {
            Ok((id, _)) => *id,
            Err(error) => error.id(),
        };
        let key = self.keys.remove(&id)?;
        // A cancelled or superseded task cannot clear its replacement or
        // deliver an obsolete response after the same ID has been reused.
        if !self.active.get(&key).is_some_and(|(owner, _)| *owner == id) {
            return None;
        }
        self.active.remove(&key);
        match joined {
            Ok((_, response)) => Some(response),
            Err(error) => {
                if !error.is_cancelled() {
                    tracing::warn!(%error, "local Git query task failed");
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests;
