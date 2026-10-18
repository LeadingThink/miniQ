//! Bounded file data plane, owned by exactly one desktop relay connection.
use super::file_tickets::{now, Ticket, Tickets};
use crate::{gateway::files as disk, state::AppState};
use miniq_protocol::{ErrorCode, RpcError, RpcRequest, RpcResponse};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
const MAX_BYTES: u64 = 200 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
mod streaming;
#[derive(Clone)]
pub(super) struct Transfers {
    inner: Arc<Inner>,
}
struct Inner {
    entries: Mutex<HashMap<String, Entry>>,
    peers: Mutex<HashMap<String, CancellationToken>>,
    slots: Semaphore,
    tickets: Tickets,
    http: reqwest::Client,
    enabled: bool,
}
struct Entry {
    peer: String,
    session: String,
    cancel: CancellationToken,
    expires: u64,
    state: Phase,
    upload: Option<Upload>,
    cache_key: Option<(String, String)>,
    result: Value,
    created_at: u64,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Ready,
    Running,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Clone)]
struct Upload {
    ticket: Ticket,
    name: String,
    size: u64,
    hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadInput {
    session_id: String,
    path: String,
    revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadInput {
    session_id: String,
    name: String,
    size: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferInput {
    session_id: String,
    transfer_id: String,
}
fn parse<T: serde::de::DeserializeOwned>(raw: Option<Value>) -> Result<T, String> {
    serde_json::from_value(raw.unwrap_or(Value::Null))
        .map_err(|_| "Invalid file transfer parameters".into())
}
fn phase(phase: Phase) -> &'static str {
    match phase {
        Phase::Ready => "ready",
        Phase::Running => "running",
        Phase::Completed => "completed",
        Phase::Cancelled => "cancelled",
        Phase::Failed => "failed",
    }
}
impl Transfers {
    pub fn new(tickets: Tickets, enabled: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                entries: Mutex::default(),
                peers: Mutex::default(),
                slots: Semaphore::new(2),
                tickets,
                enabled,
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(600))
                    .build()
                    .expect("file HTTP client"),
            }),
        }
    }
    pub fn handles(method: &str) -> bool {
        matches!(
            method,
            "file.download.prepare"
                | "file.upload.prepare"
                | "file.upload.commit"
                | "file.transfer.cancel"
                | "file.transfer.status"
        )
    }
    pub fn retain(&self, peers: &[String]) {
        self.inner.peers.lock().unwrap().retain(|peer, token| {
            let keep = peers.contains(peer);
            if !keep {
                token.cancel();
            }
            keep
        });
        self.inner.entries.lock().unwrap().retain(|_, e| {
            let keep = peers.contains(&e.peer);
            if !keep {
                e.cancel.cancel();
            }
            keep
        });
    }
    pub fn expire(&self) {
        self.inner.entries.lock().unwrap().retain(|_, e| {
            let keep = e.expires > now();
            if !keep {
                e.cancel.cancel();
                e.upload = None;
                e.result = Value::Null;
            }
            keep
        });
    }
    fn insert(&self, entry: Entry) -> Result<String, String> {
        self.expire();
        let mut entries = self.inner.entries.lock().unwrap();
        if entries.len() >= MAX_ENTRIES {
            let oldest_download = entries
                .iter()
                .filter(|(_, entry)| {
                    entry.state == Phase::Completed
                        && entry.upload.is_none()
                        && entry.cache_key.is_some()
                })
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest_download {
                entries.remove(&id);
            } else {
                return Err("Too many active file transfers; retry later".into());
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(id.clone(), entry);
        Ok(id)
    }
    pub async fn dispatch(
        &self,
        state: &AppState,
        peer: &str,
        request: RpcRequest,
        cancel: &CancellationToken,
    ) -> RpcResponse {
        // This interceptor runs before gateway::dispatch, so preserve both
        // remote authorization and the daemon-wide idle-shutdown admission
        // guard explicitly. Keep the guard alive for the entire HTTP/object
        // transfer, not merely for ticket preparation.
        if let Err(error) = crate::remote_policy::check(&request.method, request.params.as_ref()) {
            return RpcResponse::err(request.id, error);
        }
        let _activity = match state.activity.enter() {
            Ok(guard) => guard,
            Err(error) => return RpcResponse::err(request.id, error),
        };
        let peer_cancel = self
            .inner
            .peers
            .lock()
            .unwrap()
            .entry(peer.into())
            .or_default()
            .clone();
        let result = tokio::select! { biased;
            _ = peer_cancel.cancelled() => Err("File peer disconnected".into()),
            result = self.call(state, peer, &request.method, request.params, cancel) => result,
        };
        match result {
            Ok(value) => RpcResponse::ok(request.id, value),
            Err(message) => {
                RpcResponse::err(request.id, RpcError::new(ErrorCode::InvalidParams, message))
            }
        }
    }
    async fn call(
        &self,
        state: &AppState,
        peer: &str,
        method: &str,
        raw: Option<Value>,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        match method {
            "file.transfer.cancel" | "file.transfer.status" => {
                self.status(peer, parse(raw)?, method.ends_with("cancel"))
            }
            "file.upload.commit" => self.commit(state, peer, parse(raw)?, cancel).await,
            "file.download.prepare" => {
                if !self.inner.enabled {
                    return Err("File storage unavailable".into());
                }
                tokio::select! { _=cancel.cancelled()=>Err("File transfer cancelled".into()),result=self.download(state,peer,parse(raw)?)=>result}
            }
            "file.upload.prepare" => {
                if !self.inner.enabled {
                    return Err("File storage unavailable".into());
                }
                tokio::select! { _=cancel.cancelled()=>Err("File transfer cancelled".into()),result=self.upload(state,peer,parse(raw)?)=>result}
            }
            _ => Err("Unknown transfer operation".into()),
        }
    }
    fn status(&self, peer: &str, input: TransferInput, cancel: bool) -> Result<Value, String> {
        let mut entries = self.inner.entries.lock().unwrap();
        let e = entries
            .get_mut(&input.transfer_id)
            .filter(|e| e.peer == peer && e.session == input.session_id)
            .ok_or("Unknown file transfer")?;
        if cancel && matches!(e.state, Phase::Ready | Phase::Running) {
            e.cancel.cancel();
            e.state = Phase::Cancelled;
        }
        if e.state == Phase::Completed && e.upload.is_some() {
            return Ok(e.result.clone());
        }
        Ok(json!({"transferId":input.transfer_id,"status":phase(e.state)}))
    }
    async fn upload(
        &self,
        state: &AppState,
        peer: &str,
        input: UploadInput,
    ) -> Result<Value, String> {
        validate_upload(&input)?;
        // Resolve authorization and validate the destination before minting a ticket.
        let destination = disk::transfer_destination(state, &input.session_id, &input.name).await?;
        drop(destination);
        let _slot = self
            .inner
            .slots
            .try_acquire()
            .map_err(|_| "File transfers busy")?;
        let ticket = self
            .inner
            .tickets
            .request(&input.session_id, input.size)
            .await?;
        let result = json!({"putUrl":ticket.put_url,"expiresAt":ticket.expires_at});
        let id = self.insert(Entry {
            peer: peer.into(),
            session: input.session_id,
            cancel: CancellationToken::new(),
            expires: ticket.expires_at,
            state: Phase::Ready,
            upload: Some(Upload {
                ticket,
                name: input.name,
                size: input.size,
                hash: input.sha256.to_ascii_lowercase(),
            }),
            cache_key: None,
            result: Value::Null,
            created_at: now(),
        })?;
        let mut result = result;
        result["transferId"] = json!(id);
        Ok(result)
    }
    async fn download(
        &self,
        state: &AppState,
        peer: &str,
        input: DownloadInput,
    ) -> Result<Value, String> {
        let _slot = self
            .inner
            .slots
            .try_acquire()
            .map_err(|_| "File transfers busy")?;
        let (file, size) =
            disk::transfer_source(state, &input.session_id, &input.path, &input.revision).await?;
        let source = file.try_clone().await.map_err(|_| "Cannot open source")?;
        {
            let entries = self.inner.entries.lock().unwrap();
            if let Some(e) = entries.values().find(|e| {
                e.peer == peer
                    && e.session == input.session_id
                    && e.cache_key.as_ref() == Some(&(input.path.clone(), input.revision.clone()))
                    && e.state == Phase::Completed
                    && e.expires > now() + 5000
            }) {
                return Ok(e.result.clone());
            }
        }
        let ticket = self.inner.tickets.request(&input.session_id, size).await?;
        let hash = Arc::new(Mutex::new((Sha256::new(), 0u64)));
        let hashing = hash.clone();
        let stream = futures_util::stream::try_unfold(file, move |mut file| {
            let hash = hashing.clone();
            async move {
                let mut bytes = vec![0u8; 64 * 1024];
                let n = file.read(&mut bytes).await?;
                if n == 0 {
                    return Ok::<_, std::io::Error>(None);
                }
                bytes.truncate(n);
                {
                    let mut h = hash.lock().unwrap();
                    h.1 += n as u64;
                    if h.1 > size {
                        return Err(std::io::Error::other("File changed"));
                    }
                    h.0.update(&bytes);
                }
                Ok(Some((bytes, file)))
            }
        });
        let response = self
            .inner
            .http
            .put(&ticket.put_url)
            .header("content-type", "application/octet-stream")
            .header("content-length", size)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|_| "File upload failed")?;
        if !response.status().is_success() {
            return Err("File upload failed".into());
        }
        // Revalidate authorization and metadata after streaming; never cache a changed revision.
        disk::check_transfer_revision(&source, &input.revision).await?;
        let _ =
            disk::transfer_source(state, &input.session_id, &input.path, &input.revision).await?;
        let digest = {
            let h = hash.lock().unwrap();
            if h.1 != size {
                return Err("Incomplete file upload".into());
            }
            format!("{:x}", h.0.clone().finalize())
        };
        let mut result = json!({"getUrl":ticket.get_url,"expiresAt":ticket.expires_at,"size":size,"sha256":digest,"revision":input.revision});
        let id = self.insert(Entry {
            peer: peer.into(),
            session: input.session_id,
            cancel: CancellationToken::new(),
            expires: ticket.expires_at,
            state: Phase::Completed,
            upload: None,
            cache_key: Some((input.path, input.revision)),
            result: Value::Null,
            created_at: now(),
        })?;
        result["transferId"] = json!(id);
        self.inner
            .entries
            .lock()
            .unwrap()
            .get_mut(&id)
            .ok_or("File transfer disconnected")?
            .result = result.clone();
        Ok(result)
    }
    async fn commit(
        &self,
        state: &AppState,
        peer: &str,
        input: TransferInput,
        request_cancel: &CancellationToken,
    ) -> Result<Value, String> {
        let _slot = self
            .inner
            .slots
            .try_acquire()
            .map_err(|_| "File transfers busy")?;
        let (upload, cancel) = {
            let mut entries = self.inner.entries.lock().unwrap();
            let e = entries
                .get_mut(&input.transfer_id)
                .filter(|e| e.peer == peer && e.session == input.session_id)
                .ok_or("Unknown file transfer")?;
            if e.state == Phase::Completed && e.upload.is_some() {
                return Ok(e.result.clone());
            }
            if e.expires <= now() || e.state != Phase::Ready {
                return Err("File transfer unavailable".into());
            }
            let upload = e.upload.clone().ok_or("Not an upload")?;
            e.state = Phase::Running;
            (upload, e.cancel.clone())
        };
        let result = tokio::select! {biased; _=cancel.cancelled()=>Err("File transfer cancelled".into()),_=request_cancel.cancelled()=>Err("File transfer cancelled".into()),result=self.fetch_upload(state,&input,&upload)=>result};
        match result {
            Ok(destination) if !cancel.is_cancelled() && !request_cancel.is_cancelled() => {
                // Do not hold the transfer map lock across the filesystem
                // publication await. Cancellation remains observable while
                // the final atomic link is prepared.
                let path = match destination.finish().await {
                    Ok(path) => path,
                    Err(error) => {
                        if let Some(e) = self
                            .inner
                            .entries
                            .lock()
                            .unwrap()
                            .get_mut(&input.transfer_id)
                        {
                            e.state = Phase::Failed;
                        }
                        return Err(error);
                    }
                };
                let mut entries = self.inner.entries.lock().unwrap();
                let e = entries
                    .get_mut(&input.transfer_id)
                    .ok_or("File transfer disconnected")?;
                if cancel.is_cancelled()
                    || request_cancel.is_cancelled()
                    || e.state != Phase::Running
                {
                    e.state = Phase::Cancelled;
                    return Err("File transfer cancelled".into());
                }
                let result = json!({"status":"completed","path":path,"size":upload.size,"sha256":upload.hash});
                e.state = Phase::Completed;
                e.result = result.clone();
                Ok(result)
            }
            Ok(_) => {
                if let Some(e) = self
                    .inner
                    .entries
                    .lock()
                    .unwrap()
                    .get_mut(&input.transfer_id)
                {
                    e.state = Phase::Cancelled;
                }
                Err("File transfer cancelled".into())
            }
            Err(error) => {
                if let Some(e) = self
                    .inner
                    .entries
                    .lock()
                    .unwrap()
                    .get_mut(&input.transfer_id)
                {
                    e.state = if cancel.is_cancelled() || request_cancel.is_cancelled() {
                        Phase::Cancelled
                    } else {
                        Phase::Failed
                    };
                }
                Err(error)
            }
        }
    }
    async fn fetch_upload(
        &self,
        state: &AppState,
        input: &TransferInput,
        upload: &Upload,
    ) -> Result<disk::Destination, String> {
        let mut destination =
            disk::transfer_destination(state, &input.session_id, &upload.name).await?;
        let response = self
            .inner
            .http
            .get(&upload.ticket.get_url)
            .send()
            .await
            .map_err(|_| "File retrieval failed")?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n != upload.size)
        {
            return Err("File retrieval failed".into());
        }
        streaming::receive(
            response.bytes_stream(),
            &mut destination.file,
            upload.size,
            &upload.hash,
        )
        .await?;
        destination
            .file
            .flush()
            .await
            .map_err(|_| "Cannot save file")?;
        destination
            .file
            .sync_all()
            .await
            .map_err(|_| "Cannot save file")?;
        Ok(destination)
    }
}
fn validate_upload(input: &UploadInput) -> Result<(), String> {
    if input.size > MAX_BYTES
        || input.sha256.len() != 64
        || !input.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid file size or SHA-256".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_size_hash_and_extra_url_parameters() {
        let mut value =
            json!({"sessionId":"s","name":"a","size":MAX_BYTES,"sha256":"a".repeat(64)});
        assert!(validate_upload(&parse(value.clone().into()).unwrap()).is_ok());
        value["putUrl"] = json!("https://127.0.0.1");
        assert!(parse::<UploadInput>(Some(value)).is_err());
        assert!(validate_upload(&UploadInput {
            session_id: "s".into(),
            name: "a".into(),
            size: MAX_BYTES + 1,
            sha256: "a".repeat(64)
        })
        .is_err());
    }
    #[test]
    fn cancellation_is_peer_session_scoped_and_terminal() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let token = CancellationToken::new();
        let id = transfers
            .insert(Entry {
                peer: "p".into(),
                session: "s".into(),
                cancel: token.clone(),
                expires: now() + 900_000,
                state: Phase::Running,
                upload: None,
                cache_key: None,
                result: Value::Null,
                created_at: now(),
            })
            .unwrap();
        let input = || TransferInput {
            session_id: "s".into(),
            transfer_id: id.clone(),
        };
        assert!(transfers.status("other", input(), true).is_err());
        assert!(!token.is_cancelled());
        assert_eq!(
            transfers.status("p", input(), true).unwrap()["status"],
            "cancelled"
        );
        assert!(token.is_cancelled());
        assert_eq!(
            transfers.status("p", input(), true).unwrap()["status"],
            "cancelled"
        );
    }

    #[test]
    fn full_map_evicts_only_the_oldest_completed_download_cache() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let future = now() + 900_000;
        let cache_entry = |created_at, path: &str| Entry {
            peer: "p".into(),
            session: "s".into(),
            cancel: CancellationToken::new(),
            expires: future,
            state: Phase::Completed,
            upload: None,
            cache_key: Some((path.into(), "revision".into())),
            result: json!({"getUrl":"https://signed.example/object"}),
            created_at,
        };
        let oldest = transfers
            .insert(cache_entry(now() - 100, "oldest"))
            .unwrap();
        for index in 0..62 {
            transfers
                .insert(cache_entry(now() + index, &format!("cached-{index}")))
                .unwrap();
        }
        let upload_id = transfers
            .insert(Entry {
                peer: "p".into(),
                session: "s".into(),
                cancel: CancellationToken::new(),
                expires: future,
                state: Phase::Ready,
                upload: Some(Upload {
                    ticket: Ticket {
                        put_url: "https://x.qiniucs.com/put".into(),
                        get_url: "https://x.qiniucs.com/get".into(),
                        expires_at: future,
                    },
                    name: "upload.bin".into(),
                    size: 1,
                    hash: "0".repeat(64),
                }),
                cache_key: None,
                result: Value::Null,
                created_at: now(),
            })
            .unwrap();
        assert_eq!(transfers.inner.entries.lock().unwrap().len(), MAX_ENTRIES);

        let inserted = transfers.insert(cache_entry(now(), "newest")).unwrap();
        let entries = transfers.inner.entries.lock().unwrap();
        assert!(!entries.contains_key(&oldest));
        assert!(entries.contains_key(&upload_id));
        assert!(entries.contains_key(&inserted));
        assert_eq!(entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn expiry_cancels_and_scrubs_pending_upload_ticket_state() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let token = CancellationToken::new();
        let id = transfers
            .insert(Entry {
                peer: "p".into(),
                session: "s".into(),
                cancel: token.clone(),
                expires: now() - 1,
                state: Phase::Ready,
                upload: Some(Upload {
                    ticket: Ticket {
                        put_url: "https://x.qiniucs.com/secret-put".into(),
                        get_url: "https://x.qiniucs.com/secret-get".into(),
                        expires_at: now() - 1,
                    },
                    name: "secret.bin".into(),
                    size: 1,
                    hash: "0".repeat(64),
                }),
                cache_key: None,
                result: json!({"putUrl":"https://x.qiniucs.com/secret-put"}),
                created_at: now() - 10,
            })
            .unwrap();
        transfers.expire();
        assert!(token.is_cancelled());
        assert!(!transfers.inner.entries.lock().unwrap().contains_key(&id));
    }
}
