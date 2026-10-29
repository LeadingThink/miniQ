//! File handles for authenticated local/SSH RPC downloads, independent of relay storage.
//! Like Codex exec-server's fs/open, fs/readBlock and fs/close, reads are bounded
//! and a prepared file is released explicitly or when its lease expires.
use super::{invalid, opened_session_file, params, revision, scope, transfer::MAX_TRANSFER_BYTES};
use crate::state::AppState;
use base64::Engine;
use miniq_protocol::RpcError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

const CHUNK_BYTES: usize = 256 * 1024;
const LEASE: Duration = Duration::from_secs(15 * 60);

pub(crate) struct Downloads {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    slots: Arc<Semaphore>,
    preparing: Arc<Semaphore>,
}
impl Default for Downloads {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            slots: Arc::new(Semaphore::new(64)),
            preparing: Arc::new(Semaphore::new(2)),
        }
    }
}
struct Entry {
    file: Mutex<File>,
    identity: same_file::Handle,
    path: String,
    session: String,
    actor: Option<String>,
    revision: String,
    size: u64,
    expires: u64,
    cancel: CancellationToken,
    _slot: OwnedSemaphorePermit,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareInput {
    session_id: String,
    path: String,
    revision: String,
    #[serde(default, rename = "forceRefresh")]
    _force_refresh: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferInput {
    session_id: String,
    transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    transfer_id: String,
    offset: u64,
    length: usize,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) async fn dispatch(
    state: &AppState,
    method: &str,
    raw: Option<Value>,
    actor: Option<String>,
) -> Result<Value, RpcError> {
    if method == "file.download.prepare" {
        return prepare(state, params(raw)?, actor).await;
    }
    if method == "file.download.read" {
        let input: ReadInput = params(raw)?;
        if input.length == 0 || input.length > CHUNK_BYTES {
            return Err(invalid(
                "download block length must be between 1 and 262144",
            ));
        }
        let entry = state
            .file_downloads
            .entry(&input.session_id, &input.transfer_id, &actor)?;
        let state = state.clone();
        return tokio::task::spawn_blocking(move || read_block(&state, &entry, &input))
            .await
            .map_err(invalid)?
            .map_err(invalid);
    }
    let input: TransferInput = params(raw)?;
    let entry = state
        .file_downloads
        .entry(&input.session_id, &input.transfer_id, &actor)?;
    if method == "file.transfer.cancel" {
        entry.cancel.cancel();
        state
            .file_downloads
            .entries
            .lock()
            .unwrap()
            .remove(&input.transfer_id);
        return Ok(json!({"transferId":input.transfer_id,"status":"cancelled"}));
    }
    Ok(json!({"transferId":input.transfer_id,"status":"ready"}))
}

impl Downloads {
    fn entry(
        &self,
        session: &str,
        id: &str,
        actor: &Option<String>,
    ) -> Result<Arc<Entry>, RpcError> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|e| {
                e.session == session
                    && &e.actor == actor
                    && e.expires > now()
                    && !e.cancel.is_cancelled()
            })
            .cloned()
            .ok_or_else(|| invalid("File download unavailable; prepare it again"))
    }
}

async fn prepare(
    state: &AppState,
    input: PrepareInput,
    actor: Option<String>,
) -> Result<Value, RpcError> {
    let downloads = &state.file_downloads;
    let slot = downloads
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("Too many file downloads"))?;
    let preparing = downloads
        .preparing
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("File downloads busy"))?;
    let source = state.clone();
    let (entry, hash) = tokio::task::spawn_blocking(move || {
        let _preparing = preparing;
        open_download(&source, input, actor, slot)
    })
    .await
    .map_err(invalid)?
    .map_err(invalid)?;
    let id = uuid::Uuid::new_v4().to_string();
    let result = json!({"transport":"connection","transferId":id,"size":entry.size,
        "revision":entry.revision,"sha256":hash,"expiresAt":entry.expires,"chunkBytes":CHUNK_BYTES});
    let cancel = entry.cancel.clone();
    downloads
        .entries
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(entry));
    let weak = Arc::downgrade(downloads);
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(LEASE) => {},
            _ = cancel.cancelled() => {},
        }
        cancel.cancel();
        if let Some(downloads) = weak.upgrade() {
            downloads.entries.lock().unwrap().remove(&id);
        }
    });
    Ok(result)
}

fn open_download(
    state: &AppState,
    input: PrepareInput,
    actor: Option<String>,
    slot: OwnedSemaphorePermit,
) -> Result<(Entry, String), String> {
    let scope = scope(state, &input.session_id).map_err(|e| e.message)?;
    // Forwarded origin strings never grant access outside the session's roots/attachments.
    let (path, mut file) =
        opened_session_file(state, &scope, &input.session_id, &input.path, false)?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let size = metadata.len();
    if size > MAX_TRANSFER_BYTES {
        return Err("File too large: maximum 200 MiB".into());
    }
    if revision(&metadata)? != input.revision {
        return Err("file changed; describe it again before transferring".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut received = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > size {
            return Err("file changed during download preparation".into());
        }
        hash.update(&buffer[..count]);
    }
    if received != size || revision(&file.metadata().map_err(|e| e.to_string())?)? != input.revision
    {
        return Err("file changed during download preparation".into());
    }
    let identity = same_file::Handle::from_file(file.try_clone().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok((
        Entry {
            file: Mutex::new(file),
            identity,
            path: path.to_string_lossy().into_owned(),
            session: input.session_id,
            actor,
            revision: input.revision,
            size,
            expires: now() + LEASE.as_millis() as u64,
            cancel: CancellationToken::new(),
            _slot: slot,
        },
        format!("{:x}", hash.finalize()),
    ))
}

fn read_block(state: &AppState, entry: &Entry, input: &ReadInput) -> Result<Value, String> {
    let scope = scope(state, &entry.session).map_err(|e| e.message)?;
    let (_, current) = opened_session_file(state, &scope, &entry.session, &entry.path, false)?;
    if same_file::Handle::from_file(current).map_err(|e| e.to_string())? != entry.identity {
        return Err("file changed; prepare the download again".into());
    }
    let mut file = entry.file.lock().unwrap();
    let check = |file: &File| -> Result<(), String> {
        if entry.cancel.is_cancelled() || entry.expires <= now() {
            return Err("File download cancelled or expired".into());
        }
        if revision(&file.metadata().map_err(|e| e.to_string())?)? != entry.revision {
            return Err("file changed during download".into());
        }
        Ok(())
    };
    check(&file)?;
    if input.offset > entry.size {
        return Err("Invalid file download offset".into());
    }
    let length = (entry.size - input.offset).min(input.length as u64) as usize;
    let mut bytes = vec![0u8; length];
    file.seek(SeekFrom::Start(input.offset))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    check(&file)?;
    let next = input.offset + length as u64;
    Ok(
        json!({"offset":input.offset,"nextOffset":next,"totalBytes":entry.size,
        "revision":entry.revision,"done":next == entry.size,
        "dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}
