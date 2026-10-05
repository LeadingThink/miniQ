//! In-flight mobile RPC tasks for one relay connection.
//!
//! Every task owns at most one cancellation entry keyed by `(source, id)`.
//! The entry is removed when the task finishes, fails or panics, so the map
//! never outgrows the set of live tasks. A failing request only affects its
//! own reply; it never tears down the relay connection.

use std::collections::HashMap;

use tokio::sync::mpsc;
use tokio::task::{Id, JoinSet};
use tokio_util::sync::CancellationToken;

use super::super::transport::Outbound;

pub(super) const MAX_IN_FLIGHT: usize = 128;

type Key = (String, String);

#[derive(Default)]
pub(super) struct Requests {
    tasks: JoinSet<anyhow::Result<()>>,
    keys: HashMap<Id, Key>,
    cancellations: HashMap<Key, (Id, CancellationToken)>,
}

impl Requests {
    pub fn is_full(&self) -> bool {
        self.tasks.len() >= MAX_IN_FLIGHT
    }

    /// Spawns a request task. A newer request reusing `key` cancels the
    /// transport of the older one, matching the mobile client's retry model.
    pub fn spawn<F>(&mut self, key: Option<Key>, cancel: CancellationToken, task: F)
    where
        F: std::future::Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let id = self.tasks.spawn(task).id();
        if let Some(key) = key {
            self.keys.insert(id, key.clone());
            if let Some((_, previous)) = self.cancellations.insert(key, (id, cancel)) {
                previous.cancel();
            }
        }
    }

    /// Queues a reply that must reach the phone (busy, invalid upload). It
    /// waits for writer capacity instead of being dropped when the queue is
    /// full; the task is aborted with the connection.
    pub fn reply(&mut self, sender: &mpsc::Sender<Outbound>, outbound: Outbound) {
        let sender = sender.clone();
        self.tasks.spawn(async move {
            sender
                .send(outbound)
                .await
                .map_err(|_| anyhow::anyhow!("relay writer closed"))
        });
    }

    pub fn cancel(&mut self, source: &str, id: &str) {
        if let Some((task, token)) = self
            .cancellations
            .remove(&(source.to_string(), id.to_string()))
        {
            self.keys.remove(&task);
            token.cancel();
        }
    }

    /// Waits for the next task to finish and releases its bookkeeping.
    /// Pending forever while no task is running, so it fits a `select!` arm.
    pub async fn join_next(&mut self) {
        let Some(joined) = self.tasks.join_next_with_id().await else {
            return std::future::pending().await;
        };
        let task = match &joined {
            Ok((task, _)) => *task,
            Err(error) => error.id(),
        };
        self.release(task);
        match joined {
            Ok((_, Ok(()))) => {}
            Ok((_, Err(error))) => tracing::warn!(%error, "remote request task failed"),
            Err(error) => tracing::warn!(%error, "remote request task panicked"),
        }
    }

    fn release(&mut self, task: Id) {
        let Some(key) = self.keys.remove(&task) else {
            return;
        };
        if self
            .cancellations
            .get(&key)
            .is_some_and(|(owner, _)| *owner == task)
        {
            self.cancellations.remove(&key);
        }
    }

    #[cfg(test)]
    pub fn tracked(&self) -> (usize, usize) {
        (self.keys.len(), self.cancellations.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> Option<Key> {
        Some(("phone".into(), id.into()))
    }

    #[tokio::test]
    async fn finished_failed_and_panicked_tasks_release_their_cancellation_entries() {
        let mut requests = Requests::default();
        requests.spawn(key("ok"), CancellationToken::new(), async { Ok(()) });
        requests.spawn(key("err"), CancellationToken::new(), async {
            anyhow::bail!("dispatch failed")
        });
        requests.spawn(key("panic"), CancellationToken::new(), async {
            panic!("request handler bug")
        });
        assert_eq!(requests.tracked(), (3, 3));
        for _ in 0..3 {
            requests.join_next().await;
        }
        assert_eq!(requests.tracked(), (0, 0));
        assert!(requests.tasks.is_empty());
    }

    #[tokio::test]
    async fn retried_request_cancels_the_older_task_and_keeps_its_own_entry() {
        let mut requests = Requests::default();
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let first = CancellationToken::new();
        requests.spawn(key("same"), first.clone(), async move {
            let _ = wait.await;
            Ok(())
        });
        let second = CancellationToken::new();
        requests.spawn(key("same"), second.clone(), std::future::pending());
        assert!(first.is_cancelled());
        release.send(()).unwrap();
        requests.join_next().await;
        assert_eq!(requests.tracked(), (1, 1));
        requests.cancel("phone", "same");
        assert!(second.is_cancelled());
        assert_eq!(requests.tracked(), (0, 0));
    }

    #[tokio::test]
    async fn critical_replies_wait_for_queue_capacity_instead_of_being_dropped() {
        let mut requests = Requests::default();
        let (sender, mut receiver) = mpsc::channel(1);
        sender
            .try_send(Outbound::new(
                "phone".into(),
                serde_json::json!({"bulk": true}),
            ))
            .unwrap();
        requests.reply(
            &sender,
            Outbound::new("phone".into(), serde_json::json!({"busy": true})),
        );
        tokio::task::yield_now().await;
        assert_eq!(receiver.recv().await.unwrap().payload["bulk"], true);
        assert_eq!(receiver.recv().await.unwrap().payload["busy"], true);
        requests.join_next().await;
        assert!(requests.tasks.is_empty());
    }
}
