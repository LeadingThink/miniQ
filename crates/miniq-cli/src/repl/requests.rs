//! RPC contracts for terminal background jobs, reusable by deterministic fixtures.
use super::{copy_options, picker::Purpose};
use crate::{args::ChatOptions, client::Client};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

pub enum Request {
    Rpc {
        method: String,
        params: Value,
    },
    Picker {
        purpose: Purpose,
        options: ChatOptions,
    },
    Switch(String),
    Refresh(Option<String>),
    New(ChatOptions),
    Model(ChatOptions),
    Send {
        text: String,
        files: Vec<PathBuf>,
        steer: bool,
    },
    Fork {
        anchor: Option<String>,
        title: String,
    },
    Export(PathBuf),
    Clipboard(PathBuf),
    Copy(String),
    Preview(PathBuf),
    Locate(String),
}

impl Request {
    pub async fn local(&self) -> Option<Result<Value>> {
        if let Self::Copy(text) = self {
            return Some(super::commands::copy_text(text).await);
        }
        let operation = match self {
            Self::Clipboard(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || super::platform::paste(&path))
            }
            Self::Preview(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || super::attachments::preview(&path))
            }
            _ => return None,
        };
        Some(
            operation
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result),
        )
    }

    pub fn mutates(&self) -> bool {
        match self {
            Self::New(_) | Self::Model(_) | Self::Send { .. } | Self::Fork { .. } => true,
            Self::Rpc { method, .. } => matches!(
                method.as_str(),
                "session.modelUpdate"
                    | "session.approval.update"
                    | "session.rename"
                    | "session.setPinned"
                    | "session.setArchived"
                    | "session.delete"
                    | "session.undo"
                    | "session.redo"
                    | "session.compact"
                    | "session.rewriteMessage"
                    | "session.queueUpdate"
                    | "session.queueMove"
                    | "session.queueRemove"
                    | "session.queueSteer"
                    | "mcp.update"
                    | "skill.setEnabled"
                    | "approval.resolve"
                    | "question.resolve"
            ),
            _ => false,
        }
    }

    pub async fn execute(self, client: &mut Client, session: &str) -> Result<Value> {
        if let Some(result) = self.local().await {
            return result;
        }
        match self {
            Self::Locate(id) => locate(client, session, &id).await,
            Self::Export(path) => export(client, session, &path).await,
            Self::Clipboard(_) | Self::Copy(_) | Self::Preview(_) => {
                unreachable!("handled locally")
            }
            Self::Rpc { method, params } => client.call(&method, params).await,
            Self::Picker { purpose, options } => picker(client, session, purpose, &options).await,
            Self::Switch(id) => snapshot(client, &id).await,
            Self::Refresh(anchor) => refresh(client, session, anchor.as_deref()).await,
            Self::New(options) => {
                let id = crate::sessions::prepare(client, &options, None).await?;
                snapshot(client, &id).await
            }
            Self::Model(options) => {
                crate::sessions::update_model(client, session, &options).await?;
                client
                    .call("session.modelGet", json!({"sessionId":session}))
                    .await
            }
            Self::Send { text, files, steer } => {
                let outcome = crate::sessions::send_with_policy(
                    client,
                    session,
                    &text,
                    &files,
                    Some(crate::busy_policy::BusyPolicy::Queue),
                )
                .await?;
                match outcome {
                    crate::sessions::SendOutcome::Started => Ok(json!({"started":true})),
                    crate::sessions::SendOutcome::Queued { id } => {
                        if steer {
                            if let Err(error) = client
                                .call("session.queueSteer", json!({"queuedMessageId":id}))
                                .await
                            {
                                return Ok(
                                    json!({"queued":id,"steered":false,"steerError":format!("{error:#}")}),
                                );
                            }
                        }
                        Ok(json!({"queued":id,"steered":steer}))
                    }
                    crate::sessions::SendOutcome::Cancelled => Ok(json!({"cancelled":true})),
                }
            }
            Self::Fork { anchor, title } => {
                let anchor = match anchor {
                    Some(anchor) => anchor,
                    None => last_assistant(client, session).await?,
                };
                let mut params = json!({"sessionId":session,"anchorMessageId":anchor});
                if !title.is_empty() {
                    params["title"] = json!(title);
                }
                let result = client.call("session.fork", params).await?;
                let id = result["session"]["id"]
                    .as_str()
                    .or(result["sessionId"].as_str())
                    .or(result["id"].as_str())
                    .context("daemon did not return the forked session")?;
                snapshot(client, id).await
            }
        }
    }
}

pub async fn snapshot(client: &mut Client, session: &str) -> Result<Value> {
    let mut snapshot = client
        .call(
            "session.open",
            json!({"sessionId":session,"includePayloads":true}),
        )
        .await?;
    if !snapshot["session"]["external"].is_null() {
        bail!("imported sessions cannot be opened as local sessions");
    }
    snapshot["modelSelection"] = client
        .call("session.modelGet", json!({"sessionId":session}))
        .await?;
    snapshot["permissionSelection"] = client
        .call("session.approval.get", json!({"sessionId":session}))
        .await?;
    Ok(snapshot)
}

async fn last_assistant(client: &mut Client, session: &str) -> Result<String> {
    let mut params = json!({"sessionId":session,"limit":100});
    loop {
        let page = client.call("session.history", params.clone()).await?;
        if let Some(id) = page["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|message| message["role"] == "assistant")
            .and_then(|message| message["id"].as_str())
        {
            return Ok(id.into());
        }
        let Some(cursor) = page.get("nextCursor").filter(|cursor| !cursor.is_null()) else {
            bail!("nothing to fork yet: no assistant reply in this session");
        };
        params["before"] = cursor.clone();
    }
}

async fn picker(
    client: &mut Client,
    session: &str,
    purpose: Purpose,
    options: &ChatOptions,
) -> Result<Value> {
    match purpose {
        Purpose::Models => client.call("model.list", json!({})).await,
        Purpose::Effort => {
            let state = client
                .call("session.modelGet", json!({"sessionId":session}))
                .await?;
            client.call("model.describe", json!({"model":state["effective"]["model"],"apiProtocol":state["effective"]["apiProtocol"]})).await
        }
        Purpose::Sessions => crate::sessions::list(client, &copy_options(options), true).await,
        Purpose::Queue => {
            client
                .call("session.queueList", json!({"sessionId":session}))
                .await
        }
        Purpose::Agents => {
            client
                .call("agent.list", json!({"sessionId":session}))
                .await
        }
        Purpose::Mcp => client.call("mcp.list", json!({})).await,
        Purpose::Skills => {
            let snapshot = client
                .call("session.open", json!({"sessionId":session}))
                .await?;
            client
                .call(
                    "skill.list",
                    json!({"workspaceId":snapshot["session"]["workspaceId"]}),
                )
                .await
        }
        Purpose::Diff => {
            client
                .call("session.diff", json!({"sessionId":session}))
                .await
        }
        _ => bail!("this panel does not load remote data"),
    }
}

async fn export(client: &mut Client, session: &str, path: &std::path::Path) -> Result<Value> {
    use std::io::Write;
    anyhow::ensure!(!path.exists(), "Export destination already exists");
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    let mut pages = Vec::new();
    let mut params =
        json!({"sessionId":session,"limit":100,"includePayloads":true,"includeInternal":true});
    loop {
        let page = client.call("session.history", params.clone()).await?;
        let next = page
            .get("nextCursor")
            .filter(|value| !value.is_null())
            .cloned();
        pages.push(page);
        match next {
            Some(cursor) => params["before"] = cursor,
            None => break,
        }
    }
    // Pages remain individually structured, including complete tool payloads and attachments.
    pages.reverse();
    serde_json::to_writer_pretty(&mut file, &json!({"sessionId":session,"pages":pages}))?;
    file.write_all(b"\n")?;
    file.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(json!({"path":path}))
}

async fn refresh(client: &mut Client, session: &str, anchor: Option<&str>) -> Result<Value> {
    let mut snapshot = client
        .call(
            "session.open",
            json!({"sessionId":session,"includePayloads":true}),
        )
        .await?;
    let Some(anchor) = anchor else {
        return Ok(snapshot);
    };
    while !snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|message| message["id"] == anchor)
    {
        let Some(cursor) = snapshot.get("nextCursor").filter(|v| !v.is_null()).cloned() else {
            break;
        };
        let page = client
            .call(
                "session.history",
                json!({"sessionId":session,"before":cursor,"limit":100,"includePayloads":true}),
            )
            .await?;
        for key in ["messages", "toolCalls"] {
            let mut entries = snapshot[key].as_array().cloned().unwrap_or_default();
            entries.extend(page[key].as_array().into_iter().flatten().cloned());
            snapshot[key] = json!(entries);
        }
        snapshot["nextCursor"] = page["nextCursor"].clone();
    }
    Ok(snapshot)
}

async fn locate(client: &mut Client, session: &str, id: &str) -> Result<Value> {
    let mut messages = Vec::new();
    let mut tools = Vec::new();
    let mut params = json!({"sessionId":session,"limit":100,"includePayloads":true});
    loop {
        let page = client.call("session.history", params.clone()).await?;
        messages.extend(page["messages"].as_array().into_iter().flatten().cloned());
        tools.extend(page["toolCalls"].as_array().into_iter().flatten().cloned());
        if messages.iter().any(|message| message["id"] == id) {
            return Ok(
                json!({"messages":messages,"toolCalls":tools,"nextCursor":page["nextCursor"]}),
            );
        }
        let Some(cursor) = page.get("nextCursor").filter(|cursor| !cursor.is_null()) else {
            bail!("message no longer exists");
        };
        params["before"] = cursor.clone();
    }
}
