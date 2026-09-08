use anyhow::{bail, Context, Result};
use miniq_protocol::SessionModelSettings;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::args::ChatOptions;
use crate::client::Client;

pub fn absolute(path: &Path) -> Result<String> {
    Ok(path
        .canonicalize()
        .with_context(|| format!("cannot resolve {}", path.display()))?
        .to_string_lossy()
        .into_owned())
}

pub fn working_directory(options: &ChatOptions) -> Result<String> {
    let path = match &options.directory {
        Some(path) => path.clone(),
        None => std::env::current_dir()?,
    };
    if !path.is_dir() {
        bail!("project must be a directory: {}", path.display());
    }
    absolute(&path)
}

pub async fn list(client: &mut Client, options: &ChatOptions, all: bool) -> Result<Value> {
    let mut params = json!({});
    if !all {
        let path = working_directory(options)?;
        let workspaces = client.call("workspace.list", json!({})).await?;
        let workspace = workspaces["workspaces"]
            .as_array()
            .context("invalid workspace list")?
            .iter()
            .find(|workspace| same_path(workspace["path"].as_str().unwrap_or(""), &path));
        let Some(workspace) = workspace else {
            return Ok(json!({"sessions":[]}));
        };
        params["workspaceId"] = workspace["id"].clone();
    }
    client.call("session.list", params).await
}

fn same_path(left: &str, right: &str) -> bool {
    let normalize = |path: &str| {
        path.strip_prefix(r"\\?\")
            .unwrap_or(path)
            .replace('\\', "/")
    };
    if cfg!(windows) {
        normalize(left).eq_ignore_ascii_case(&normalize(right))
    } else {
        normalize(left) == normalize(right)
    }
}

pub async fn last(client: &mut Client, options: &ChatOptions) -> Result<String> {
    let result = list(client, options, false).await?;
    result["sessions"]
        .as_array()
        .context("invalid session list")?
        .iter()
        .filter(|session| session["archived"] != true && session["external"].is_null())
        .max_by_key(|session| session["updatedAt"].as_str().unwrap_or(""))
        .and_then(|session| session["id"].as_str())
        .map(str::to_owned)
        .context("no local session in this project; run miniq to create one")
}

pub async fn prepare(
    client: &mut Client,
    options: &ChatOptions,
    session: Option<&str>,
) -> Result<String> {
    let id = if let Some(id) = session {
        let snapshot = client.call("session.open", json!({"sessionId":id})).await?;
        if !snapshot["session"]["external"].is_null() {
            bail!("imported external sessions cannot be resumed as local sessions");
        }
        if options.directory.is_some()
            && !same_path(
                snapshot["session"]["workingDirectory"]
                    .as_str()
                    .unwrap_or(""),
                &working_directory(options)?,
            )
        {
            bail!("-C does not match the resumed session's working directory");
        }
        if !options.add_dir.is_empty() {
            let workspaces = client.call("workspace.list", json!({})).await?;
            let workspace = workspaces["workspaces"]
                .as_array()
                .context("invalid workspaces")?
                .iter()
                .find(|workspace| workspace["id"] == snapshot["session"]["workspaceId"])
                .context("session workspace missing")?;
            add_roots(client, workspace, &options.add_dir).await?;
        }
        id.to_owned()
    } else {
        let workspace = client
            .call(
                "workspace.open",
                json!({"path":working_directory(options)?}),
            )
            .await?;
        add_roots(client, &workspace, &options.add_dir).await?;
        let session = client
            .call("session.create", json!({"workspaceId":workspace["id"]}))
            .await?;
        session["id"]
            .as_str()
            .context("session ID missing")?
            .to_owned()
    };
    client.scope(&id);
    update_model(client, &id, options).await?;
    Ok(id)
}

async fn add_roots(client: &mut Client, workspace: &Value, extra: &[PathBuf]) -> Result<()> {
    if extra.is_empty() {
        return Ok(());
    }
    let mut paths = vec![workspace["path"].clone()];
    paths.extend(
        workspace["additionalPaths"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    for path in extra {
        paths.push(json!(absolute(path)?));
    }
    client
        .call(
            "workspace.updateRoots",
            json!({"workspaceId":workspace["id"], "paths":paths}),
        )
        .await?;
    Ok(())
}

pub async fn update_model(client: &mut Client, id: &str, options: &ChatOptions) -> Result<()> {
    if options.model.is_none() && options.effort.is_none() && options.protocol.is_none() {
        return Ok(());
    }
    let result = client
        .call("session.modelGet", json!({"sessionId":id}))
        .await?;
    let mut settings: SessionModelSettings = serde_json::from_value(result["settings"].clone())?;
    if let Some(model) = &options.model {
        settings.model = Some(model.clone());
        settings.reasoning_effort = None;
        settings.api_protocol = miniq_protocol::ApiProtocol::Auto;
    }
    if let Some(protocol) = &options.protocol {
        settings.api_protocol =
            miniq_protocol::ApiProtocol::parse(protocol).map_err(anyhow::Error::msg)?;
    }
    if let Some(effort) = &options.effort {
        settings.reasoning_effort = if effort == "default" {
            None
        } else {
            Some(serde_json::from_value(json!(effort))?)
        };
    }
    client
        .call(
            "session.modelUpdate",
            json!({"sessionId":id,"settings":settings}),
        )
        .await?;
    Ok(())
}

pub fn attachments(paths: &[PathBuf]) -> Result<Vec<String>> {
    if paths.len() > 10 {
        bail!("at most 10 attachments per message; send additional files in another message");
    }
    paths
        .iter()
        .map(|path| {
            if !path.is_file() {
                bail!("attachment must be a regular file: {}", path.display());
            }
            absolute(path)
        })
        .collect()
}

pub async fn send(
    client: &mut Client,
    session: &str,
    content: &str,
    paths: &[PathBuf],
) -> Result<()> {
    if !client.reject_busy {
        bail!("running daemon lacks atomic CLI turn admission. Update it when tasks are idle; status/history/watch remain available. Nothing was sent");
    }
    let result = client
        .call(
            "session.sendMessage",
            json!({"sessionId":session, "rejectIfBusy":true,
        "message":{"role":"user", "content":content, "attachments":attachments(paths)?}}),
        )
        .await?;
    if result.get("queued").is_some() {
        bail!("daemon queued this message behind an active task; inspect the session before continuing");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_are_canonical_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(attachments(&[dir.path().into()]).is_err());
        let file = dir.path().join("test image.png");
        std::fs::write(&file, "fixture").unwrap();
        assert_eq!(attachments(&[file]).unwrap().len(), 1);
        assert!(attachments(&vec![dir.path().into(); 11]).is_err());
    }
}
