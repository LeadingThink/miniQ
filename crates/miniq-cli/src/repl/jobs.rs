//! Background operations never borrow the live editor or screen.
use super::{picker::Purpose, requests::Request, Repl};
use crate::client::Client;
use anyhow::Result;
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde_json::Value;
use std::{collections::VecDeque, future::Future, path::Path, pin::Pin};

#[derive(Clone, Debug)]
pub enum Effect {
    Clipboard(Option<u64>),
    Preview(String),
    Tool {
        id: String,
        detail: bool,
    },
    Reader,
    MessagePage(String),
    Locate(String),
    Picker(Purpose),
    Switch,
    Refresh,
    History,
    Context,
    Model,
    Permissions,
    Sent {
        files: Vec<std::path::PathBuf>,
        text: String,
    },
    Resolved {
        id: Value,
        answer: Option<String>,
    },
    Notice(String),
    Copied,
    SessionRemoved(String),
    Detail(String),
    Undo,
}

pub struct Pending {
    pub id: u64,
    pub session: String,
    pub label: String,
    pub effect: Effect,
    pub request: Request,
}

pub struct Completion {
    pub id: u64,
    pub session: String,
    pub label: String,
    pub effect: Effect,
    pub result: Result<Value>,
}

type Running = Pin<Box<dyn Future<Output = Completion> + Send>>;

#[derive(Default)]
pub struct Jobs {
    pub pending: VecDeque<Pending>,
    running: FuturesUnordered<Running>,
    next_id: u64,
    mutation_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl Jobs {
    pub fn push(&mut self, session: &str, label: &str, effect: Effect, request: Request) -> u64 {
        self.next_id += 1;
        self.pending.push_back(Pending {
            id: self.next_id,
            session: session.into(),
            label: label.into(),
            effect,
            request,
        });
        self.next_id
    }

    pub fn start(&mut self, directory: &Path, max_turns: Option<u16>) {
        while let Some(pending) = self.pending.pop_front() {
            let directory = directory.to_owned();
            let mutation_lock = self.mutation_lock.clone();
            self.running.push(Box::pin(async move {
                let result = async {
                    if let Some(result) = pending.request.local().await {
                        return result;
                    }
                    let _guard = if pending.request.mutates() {
                        Some(mutation_lock.lock().await)
                    } else {
                        None
                    };
                    let mut client = Client::connect(&directory).await?;
                    client.max_turns = max_turns;
                    pending.request.execute(&mut client, &pending.session).await
                }
                .await;
                Completion {
                    id: pending.id,
                    session: pending.session,
                    label: pending.label,
                    effect: pending.effect,
                    result,
                }
            }));
        }
    }

    pub async fn next(&mut self) -> Completion {
        if self.running.is_empty() {
            return std::future::pending().await;
        }
        self.running.next().await.expect("at least one running job")
    }
}

impl Repl {
    pub(super) fn copy_selection(&mut self, text: &str) {
        self.request("Copying", Effect::Copied, Request::Copy(text.into()));
    }
    pub fn request(&mut self, label: &str, effect: Effect, request: Request) -> u64 {
        let refresh = matches!(effect, Effect::Refresh);
        if matches!(effect, Effect::Refresh | Effect::Switch)
            && self.refresh_request.is_none()
            && self.switch_request.is_none()
        {
            self.snapshot_events.clear();
        }
        let id = self.jobs.push(&self.session, label, effect, request);
        if refresh {
            self.refresh_request = Some(id);
        }
        self.pending_labels.insert(id, label.into());
        id
    }

    pub fn rpc(&mut self, label: &str, effect: Effect, method: &str, params: Value) -> u64 {
        self.request(
            label,
            effect,
            Request::Rpc {
                method: method.into(),
                params,
            },
        )
    }
}

#[cfg(test)]
impl Repl {
    pub async fn finish_jobs(&mut self, editor: &mut super::Editor, client: &mut Client) {
        while let Some(pending) = self.jobs.pending.pop_front() {
            let result = pending.request.execute(client, &pending.session).await;
            self.complete(
                editor,
                client,
                Completion {
                    id: pending.id,
                    session: pending.session,
                    label: pending.label,
                    effect: pending.effect,
                    result,
                },
            );
        }
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
