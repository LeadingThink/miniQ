//! Read-only, session-scoped artifact access for browser and mobile clients.
use super::common::{params, store_err};
use crate::state::AppState;
use base64::Engine;
use miniq_local::files::{preview_format, validated_file, MAX_PREVIEW_BYTES};
use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

// Each chunk can use the existing encrypted object-storage data plane. Requests
// remain cancellable between chunks and never require one giant RPC response.
const CHUNK_BYTES: u64 = 3 * 1024 * 1024;
const PAGE_SIZE: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInput {
    session_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    path: String,
    revision: String,
    offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    session_id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    after: Option<String>,
}

struct Scope {
    cwd: String,
    roots: Vec<String>,
}

fn scope(state: &AppState, session_id: &str) -> Result<Scope, RpcError> {
    let session = state.store.get_session(session_id).map_err(store_err)?;
    let workspace = state
        .store
        .get_workspace(&session.workspace_id)
        .map_err(store_err)?;
    Ok(Scope {
        cwd: session.working_directory,
        roots: std::iter::once(workspace.path)
            .chain(workspace.additional_paths)
            .collect(),
    })
}

fn invalid(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, error.to_string())
}

pub(super) async fn describe(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: FileInput = params(raw)?;
    let scope = scope(state, &input.session_id)?;
    tokio::task::spawn_blocking(move || {
        let path = validated_file(&input.path, &scope.cwd, &scope.roots)?;
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        let (kind, mime_type) = preview_format(&path);
        Ok::<_, String>(json!({"path":path, "kind":kind, "mimeType":mime_type,
            "size":metadata.len(), "revision":revision(&metadata)?,
            "chunkBytes":CHUNK_BYTES, "maxPreviewBytes":MAX_PREVIEW_BYTES}))
    })
    .await
    .map_err(invalid)?
    .map_err(invalid)
}

pub(super) async fn read(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ReadInput = params(raw)?;
    let scope = scope(state, &input.session_id)?;
    tokio::task::spawn_blocking(move || read_chunk(&scope, &input))
        .await
        .map_err(invalid)?
        .map_err(invalid)
}

fn revision(metadata: &std::fs::Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(format!("{}:{modified}", metadata.len()))
}

fn read_chunk(scope: &Scope, input: &ReadInput) -> Result<Value, String> {
    let path = validated_file(&input.path, &scope.cwd, &scope.roots)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if revision(&metadata)? != input.revision {
        return Err("文件已更新，请重新加载预览".into());
    }
    if input.offset > metadata.len() {
        return Err("文件读取位置无效".into());
    }
    file.seek(SeekFrom::Start(input.offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(CHUNK_BYTES.min(metadata.len() - input.offset))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if revision(&file.metadata().map_err(|e| e.to_string())?)? != input.revision {
        return Err("文件在读取期间更新，请重新加载预览".into());
    }
    let next = input.offset + bytes.len() as u64;
    if next < metadata.len() && bytes.is_empty() {
        return Err("文件读取不完整".into());
    }
    Ok(
        json!({"offset":input.offset, "nextOffset":next, "totalBytes":metadata.len(),
        "revision":input.revision, "done":next == metadata.len(),
        "dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}

pub(super) async fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ListInput = params(raw)?;
    let scope = scope(state, &input.session_id)?;
    tokio::task::spawn_blocking(move || list_directory(&scope, &input))
        .await
        .map_err(invalid)?
        .map_err(invalid)
}

fn list_directory(scope: &Scope, input: &ListInput) -> Result<Value, String> {
    let path = Path::new(&scope.cwd)
        .join(&input.path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut roots = Vec::<PathBuf>::new();
    for root in std::iter::once(&scope.cwd).chain(scope.roots.iter()) {
        if let Ok(root) = Path::new(root).canonicalize() {
            if root.is_dir() && !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    if !path.is_dir() || !roots.iter().any(|root| path.starts_with(root)) {
        return Err("只能浏览当前会话的项目目录".into());
    }
    let mut entries = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut page = Vec::new();
    let mut next_cursor = None;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if input.after.as_ref().is_some_and(|after| &name <= after) {
            continue;
        }
        let metadata = match entry.path().canonicalize() {
            Ok(canonical) => {
                if !roots.iter().any(|root| canonical.starts_with(root)) {
                    continue;
                }
                canonical.metadata()
            }
            Err(error) => Err(error),
        };
        if metadata
            .as_ref()
            .is_ok_and(|value| !value.is_dir() && !value.is_file())
        {
            continue;
        }
        if page.len() == PAGE_SIZE {
            next_cursor = page
                .last()
                .and_then(|entry: &Value| entry["name"].as_str())
                .map(str::to_owned);
            break;
        }
        let item = match metadata {
            Ok(metadata) => {
                json!({"name":name,"path":entry.path(),"directory":metadata.is_dir(),"size":metadata.len()})
            }
            Err(_) => {
                json!({"name":name,"path":entry.path(),"directory":false,"size":0,"unavailable":true})
            }
        };
        page.push(item);
    }
    let parent = path
        .parent()
        .filter(|parent| roots.iter().any(|root| parent.starts_with(root)));
    Ok(json!({"path":path,"parent":parent,"roots":roots,"entries":page,"nextCursor":next_cursor}))
}

#[cfg(test)]
mod tests;
