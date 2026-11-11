//! Connection-scoped chunked uploads for local and forwarded RPC clients.
//!
//! This data plane deliberately does not use relay object storage. Each handle
//! owns a staged `Destination`, and publication is performed only after the
//! declared length and SHA-256 have been verified.
use super::{invalid, params, transfer_destination, AppState, TransferScope};
use base64::Engine;
use miniq_protocol::RpcError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) const CHUNK_BYTES: usize = 262_144;
const LEASE: Duration = Duration::from_secs(15 * 60);
const MAX_ENTRIES: usize = 64;
const MAX_UPLOADS: usize = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareInput {
    session_id: Option<String>,
    workspace_id: Option<String>,
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteInput {
    session_id: Option<String>,
    workspace_id: Option<String>,
    transfer_id: String,
    offset: u64,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferInput {
    pub(crate) session_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) transfer_id: String,
}

impl PrepareInput {
    fn scope(&self) -> Result<TransferScope, String> {
        TransferScope::from_ids(self.session_id.as_deref(), self.workspace_id.as_deref())
    }
}

impl TransferInput {
    pub(crate) fn scope(&self) -> Result<TransferScope, String> {
        TransferScope::from_ids(self.session_id.as_deref(), self.workspace_id.as_deref())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ready,
    Publishing,
    Completed,
    Cancelled,
    Failed,
}

fn phase(phase: Phase) -> &'static str {
    match phase {
        Phase::Ready => "ready",
        Phase::Publishing => "publishing",
        Phase::Completed => "completed",
        Phase::Cancelled => "cancelled",
        Phase::Failed => "failed",
    }
}

struct UploadState {
    destination: Option<super::Destination>,
    received: u64,
    digest: Sha256,
    phase: Phase,
    result: Value,
    slot: Option<OwnedSemaphorePermit>,
}

impl UploadState {
    fn finish(&mut self, phase: Phase) {
        self.phase = phase;
        self.destination.take();
        self.slot.take();
    }
}

struct Entry {
    scope: TransferScope,
    actor: Option<String>,
    size: u64,
    hash: String,
    expires: u64,
    deadline: Instant,
    cancel: CancellationToken,
    state: AsyncMutex<UploadState>,
}

pub(crate) struct Uploads {
    entries: Arc<Mutex<HashMap<String, Arc<Entry>>>>,
    slots: Arc<Semaphore>,
}

impl Default for Uploads {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::default()),
            slots: Arc::new(Semaphore::new(MAX_UPLOADS)),
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Uploads {
    pub(crate) fn owns(&self, transfer_id: &str) -> bool {
        self.expire();
        self.entries.lock().unwrap().contains_key(transfer_id)
    }

    fn expire(&self) {
        let now = Instant::now();
        self.entries.lock().unwrap().retain(|_, entry| {
            let keep = entry.deadline > now;
            if !keep {
                entry.cancel.cancel();
            }
            keep
        });
    }

    fn entry(&self, input: &TransferInput, actor: &Option<String>) -> Result<Arc<Entry>, RpcError> {
        let scope = input.scope().map_err(invalid)?;
        self.expire();
        self.entries
            .lock()
            .unwrap()
            .get(&input.transfer_id)
            .filter(|entry| {
                entry.scope == scope && &entry.actor == actor && entry.deadline > Instant::now()
            })
            .cloned()
            .ok_or_else(|| invalid("File upload unavailable; prepare it again"))
    }

    pub(crate) async fn dispatch(
        &self,
        state: &AppState,
        method: &str,
        raw: Option<Value>,
        actor: Option<String>,
    ) -> Result<Value, RpcError> {
        match method {
            "file.upload.prepare" => self.prepare(state, params(raw)?, actor).await,
            "file.upload.write" => self.write(params(raw)?, actor).await,
            "file.upload.commit" => self.commit(params(raw)?, actor).await,
            _ => Err(invalid("Unknown file upload operation")),
        }
    }

    pub(crate) async fn status_or_cancel(
        &self,
        raw: Option<Value>,
        actor: Option<String>,
        cancel: bool,
    ) -> Result<Value, RpcError> {
        let input: TransferInput = params(raw)?;
        let entry = self.entry(&input, &actor)?;
        let mut upload = entry.state.lock().await;
        if cancel && matches!(upload.phase, Phase::Ready) {
            entry.cancel.cancel();
            upload.finish(Phase::Cancelled);
        }
        if upload.phase == Phase::Completed {
            return Ok(upload.result.clone());
        }
        Ok(json!({"transferId":input.transfer_id,"status":phase(upload.phase)}))
    }

    async fn prepare(
        &self,
        state: &AppState,
        input: PrepareInput,
        actor: Option<String>,
    ) -> Result<Value, RpcError> {
        validate_prepare(&input)?;
        let scope = input.scope().map_err(invalid)?;
        self.expire();
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid("Too many active file uploads"))?;
        let destination = transfer_destination(state, &scope, &input.name)
            .await
            .map_err(invalid)?;
        self.expire();
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_ENTRIES {
            return Err(invalid("Too many active file uploads; retry later"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + LEASE;
        let entry = Arc::new(Entry {
            scope,
            actor,
            size: input.size,
            hash: input.sha256.to_ascii_lowercase(),
            expires: now() + LEASE.as_millis() as u64,
            deadline,
            cancel: CancellationToken::new(),
            state: AsyncMutex::new(UploadState {
                destination: Some(destination),
                received: 0,
                digest: Sha256::new(),
                phase: Phase::Ready,
                result: Value::Null,
                slot: Some(slot),
            }),
        });
        entries.insert(id.clone(), entry.clone());
        let entries = Arc::downgrade(&self.entries);
        let cancel = entry.cancel.clone();
        let expired_id = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            cancel.cancel();
            if let Some(entries) = entries.upgrade() {
                entries.lock().unwrap().remove(&expired_id);
            }
        });
        Ok(json!({
            "transport":"connection",
            "transferId":id,
            "chunkBytes":CHUNK_BYTES,
            "expiresAt":entry.expires
        }))
    }

    async fn write(&self, input: WriteInput, actor: Option<String>) -> Result<Value, RpcError> {
        let decoded = decode_chunk(&input.data_base64).map_err(invalid)?;
        let transfer = TransferInput {
            session_id: input.session_id,
            workspace_id: input.workspace_id,
            transfer_id: input.transfer_id.clone(),
        };
        let entry = self.entry(&transfer, &actor)?;
        let mut upload = entry.state.lock().await;
        if upload.phase != Phase::Ready
            || entry.cancel.is_cancelled()
            || entry.deadline <= Instant::now()
        {
            return Err(invalid("File upload unavailable"));
        }
        let remaining = entry
            .size
            .checked_sub(upload.received)
            .ok_or_else(|| invalid("File upload size exceeded"))?;
        let expected = remaining.min(CHUNK_BYTES as u64) as usize;
        if input.offset != upload.received || decoded.len() != expected {
            return Err(invalid("File upload requires the next exact chunk"));
        }
        let write_result = if let Some(destination) = upload.destination.as_mut() {
            use tokio::io::AsyncWriteExt;
            destination.file.write_all(&decoded).await
        } else {
            return {
                upload.finish(Phase::Failed);
                Err(invalid("File upload destination is unavailable"))
            };
        };
        if let Err(error) = write_result {
            upload.finish(Phase::Failed);
            return Err(invalid(error.to_string()));
        }
        upload.digest.update(&decoded);
        upload.received += decoded.len() as u64;
        Ok(json!({"nextOffset":upload.received}))
    }

    async fn commit(&self, input: TransferInput, actor: Option<String>) -> Result<Value, RpcError> {
        let entry = self.entry(&input, &actor)?;
        let mut upload = entry.state.lock().await;
        if upload.phase == Phase::Completed {
            return Ok(upload.result.clone());
        }
        if upload.phase != Phase::Ready
            || entry.cancel.is_cancelled()
            || entry.deadline <= Instant::now()
        {
            return Err(invalid("File upload unavailable"));
        }
        if upload.received != entry.size {
            return Err(invalid("File upload is incomplete"));
        }
        let digest = format!("{:x}", upload.digest.clone().finalize());
        if digest != entry.hash {
            upload.finish(Phase::Failed);
            return Err(invalid("File upload SHA-256 mismatch"));
        }
        upload.phase = Phase::Publishing;
        let destination = upload
            .destination
            .take()
            .ok_or_else(|| invalid("File upload destination is unavailable"))?;
        let path = match destination.finish().await {
            Ok(path) => path,
            Err(error) => {
                upload.finish(Phase::Failed);
                return Err(invalid(error));
            }
        };
        let result = json!({
            "status":"completed",
            "path":path,
            "size":entry.size,
            "sha256":digest
        });
        upload.finish(Phase::Completed);
        upload.result = result.clone();
        Ok(result)
    }
}

fn validate_prepare(input: &PrepareInput) -> Result<(), RpcError> {
    if input.size > super::MAX_TRANSFER_BYTES
        || input.sha256.len() != 64
        || !input.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid("Invalid file size or SHA-256"));
    }
    Ok(())
}

fn decode_chunk(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() || encoded.len() > CHUNK_BYTES.div_ceil(3) * 4 {
        return Err("Upload chunk must contain 1 to 262144 bytes".into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid base64 upload chunk".to_string())?;
    if decoded.is_empty() || decoded.len() > CHUNK_BYTES {
        return Err("Upload chunk must contain 1 to 262144 bytes".into());
    }
    if base64::engine::general_purpose::STANDARD.encode(&decoded) != encoded {
        return Err("Upload chunk base64 is not canonical".into());
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_chunks_are_canonical_and_bounded() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"bytes");
        assert_eq!(decode_chunk(&encoded).unwrap(), b"bytes");
        for invalid in ["", "Ynl0ZXM", "Ynl0ZXM=\n"] {
            assert!(decode_chunk(invalid).is_err(), "{invalid:?}");
        }
        let oversized = vec![0u8; CHUNK_BYTES + 1];
        assert!(
            decode_chunk(&base64::engine::general_purpose::STANDARD.encode(oversized)).is_err()
        );
    }
}
