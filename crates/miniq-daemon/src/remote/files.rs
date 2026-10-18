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
    scope: disk::TransferScope,
    cancel: CancellationToken,
    expires: u64,
    state: Phase,
    upload: Option<Upload>,
    cache_key: Option<(String, String)>,
    object_id: Option<String>,
    result: Value,
    created_at: u64,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Ready,
    Running,
    Publishing,
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
    #[serde(default)]
    force_refresh: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadInput {
    session_id: Option<String>,
    workspace_id: Option<String>,
    name: String,
    size: u64,
    sha256: String,
}
impl UploadInput {
    fn scope(&self) -> Result<disk::TransferScope, String> {
        disk::TransferScope::from_ids(self.session_id.as_deref(), self.workspace_id.as_deref())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferInput {
    session_id: Option<String>,
    workspace_id: Option<String>,
    transfer_id: String,
}
impl TransferInput {
    fn scope(&self) -> Result<disk::TransferScope, String> {
        disk::TransferScope::from_ids(self.session_id.as_deref(), self.workspace_id.as_deref())
    }
}
fn parse<T: serde::de::DeserializeOwned>(raw: Option<Value>) -> Result<T, String> {
    serde_json::from_value(raw.unwrap_or(Value::Null))
        .map_err(|_| "Invalid file transfer parameters".into())
}
fn phase(phase: Phase) -> &'static str {
    match phase {
        Phase::Ready => "ready",
        Phase::Running => "running",
        Phase::Publishing => "publishing",
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
        let scope = input.scope()?;
        let mut entries = self.inner.entries.lock().unwrap();
        let e = entries
            .get_mut(&input.transfer_id)
            .filter(|e| e.peer == peer && e.scope == scope)
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
        let scope = input.scope()?;
        // Resolve authorization and validate the destination before minting a ticket.
        let destination = disk::transfer_destination(state, &scope, &input.name).await?;
        drop(destination);
        let _slot = self
            .inner
            .slots
            .try_acquire()
            .map_err(|_| "File transfers busy")?;
        let ticket = self
            .inner
            .tickets
            .request(&scope.storage_key(), input.size, None)
            .await?;
        let result = json!({"putUrl":ticket.put_url,"expiresAt":ticket.expires_at});
        let id = self.insert(Entry {
            peer: peer.into(),
            scope,
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
            object_id: None,
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
        let scope = disk::TransferScope::Session(input.session_id.clone());
        let (file, size) =
            disk::transfer_source(state, &input.session_id, &input.path, &input.revision).await?;
        let source = file.try_clone().await.map_err(|_| "Cannot open source")?;
        let cached = {
            let entries = self.inner.entries.lock().unwrap();
            entries
                .values()
                .find(|e| {
                    e.peer == peer
                        && e.scope == scope
                        && e.cache_key.as_ref()
                            == Some(&(input.path.clone(), input.revision.clone()))
                        && e.state == Phase::Completed
                        && e.expires > now() + 5000
                })
                .map(|e| (e.result.clone(), e.object_id.clone()))
        };
        if !input.force_refresh {
            if let Some((result, _)) = cached {
                return Ok(result);
            }
        }
        if input.force_refresh {
            if let Some((mut result, Some(object_id))) = cached {
                let size = result["size"]
                    .as_u64()
                    .ok_or("Cached file transfer is invalid")?;
                let ticket = self
                    .inner
                    .tickets
                    .request(&scope.storage_key(), size, Some(&object_id))
                    .await?;
                result["getUrl"] = json!(ticket.get_url);
                result["expiresAt"] = json!(ticket.expires_at);
                return Ok(result);
            }
        }
        let ticket = self
            .inner
            .tickets
            .request(&scope.storage_key(), size, None)
            .await?;
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
            scope,
            cancel: CancellationToken::new(),
            expires: ticket.expires_at,
            state: Phase::Completed,
            upload: None,
            cache_key: Some((input.path, input.revision)),
            object_id: ticket.object_id.clone(),
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
        let scope = input.scope()?;
        let _slot = self
            .inner
            .slots
            .try_acquire()
            .map_err(|_| "File transfers busy")?;
        let (upload, cancel) = {
            let mut entries = self.inner.entries.lock().unwrap();
            let e = entries
                .get_mut(&input.transfer_id)
                .filter(|e| e.peer == peer && e.scope == scope)
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
        let result = tokio::select! {biased; _=cancel.cancelled()=>Err("File transfer cancelled".into()),_=request_cancel.cancelled()=>Err("File transfer cancelled".into()),result=self.fetch_upload(state,&scope,&upload)=>result};
        match result {
            Ok(destination) if !cancel.is_cancelled() && !request_cancel.is_cancelled() => {
                // Reserve the publication state while holding the transfer
                // lock. Once this point is reached cancellation reports the
                // in-flight terminal state and cannot publish then report a
                // false cancellation.
                let publish = {
                    let mut entries = self.inner.entries.lock().unwrap();
                    let e = entries
                        .get_mut(&input.transfer_id)
                        .ok_or("File transfer disconnected")?;
                    if e.state != Phase::Running
                        || cancel.is_cancelled()
                        || request_cancel.is_cancelled()
                    {
                        e.state = Phase::Cancelled;
                        false
                    } else {
                        e.state = Phase::Publishing;
                        true
                    }
                };
                if !publish {
                    return Err("File transfer cancelled".into());
                }
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
        scope: &disk::TransferScope,
        upload: &Upload,
    ) -> Result<disk::Destination, String> {
        let mut destination = disk::transfer_destination(state, scope, &upload.name).await?;
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
            session_id: Some("s".into()),
            workspace_id: None,
            name: "a".into(),
            size: MAX_BYTES + 1,
            sha256: "a".repeat(64)
        })
        .is_err());
    }
    #[test]
    fn upload_and_transfer_inputs_require_exactly_one_scope() {
        let upload = |extra: Value| {
            let mut value = json!({"name":"a","size":1,"sha256":"a".repeat(64)});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            parse::<UploadInput>(Some(value)).unwrap()
        };
        assert_eq!(
            upload(json!({"sessionId":"s"})).scope().unwrap(),
            disk::TransferScope::Session("s".into())
        );
        assert_eq!(
            upload(json!({"workspaceId":"w"})).scope().unwrap(),
            disk::TransferScope::Workspace("w".into())
        );
        let both = upload(json!({"sessionId":"s","workspaceId":"w"}));
        assert!(both.scope().unwrap_err().contains("not both"));
        assert!(upload(json!({}))
            .scope()
            .unwrap_err()
            .contains("exactly one"));
        let transfer = |value: Value| parse::<TransferInput>(Some(value)).unwrap();
        assert!(transfer(json!({"transferId":"t"})).scope().is_err());
        assert!(
            transfer(json!({"transferId":"t","sessionId":"s","workspaceId":"w"}))
                .scope()
                .is_err()
        );
        assert!(
            parse::<TransferInput>(Some(json!({"transferId":"t","workspaceId":"w","x":1})))
                .is_err()
        );
        assert_eq!(disk::TransferScope::Session("s".into()).storage_key(), "s");
        assert_eq!(
            disk::TransferScope::Workspace("w".into()).storage_key(),
            "workspace:w"
        );
    }

    #[tokio::test]
    async fn transfer_is_bound_to_its_peer_and_workspace_scope() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let state = AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "test".into(),
            Arc::new(miniq_models::mock::MockProvider::new(vec![])),
        );
        let token = CancellationToken::new();
        let id = transfers
            .insert(Entry {
                peer: "p".into(),
                scope: disk::TransferScope::Workspace("w".into()),
                cancel: token.clone(),
                expires: now() + 900_000,
                state: Phase::Ready,
                upload: None,
                cache_key: None,
                object_id: None,
                result: Value::Null,
                created_at: now(),
            })
            .unwrap();
        let input = |session: Option<&str>, workspace: Option<&str>| TransferInput {
            session_id: session.map(Into::into),
            workspace_id: workspace.map(Into::into),
            transfer_id: id.clone(),
        };
        for wrong in [
            input(Some("w"), None),
            input(None, Some("other")),
            input(Some("w"), Some("w")),
            input(None, None),
        ] {
            assert!(transfers.status("p", wrong, true).is_err());
        }
        assert!(transfers
            .status("other-peer", input(None, Some("w")), true)
            .is_err());
        for wrong in [input(Some("w"), None), input(None, Some("other"))] {
            let result = transfers
                .commit(&state, "p", wrong, &CancellationToken::new())
                .await;
            assert_eq!(result.unwrap_err(), "Unknown file transfer");
        }
        assert!(!token.is_cancelled());
        assert_eq!(
            transfers.status("p", input(None, Some("w")), true).unwrap()["status"],
            "cancelled"
        );
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellation_is_peer_session_scoped_and_terminal() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let token = CancellationToken::new();
        let id = transfers
            .insert(Entry {
                peer: "p".into(),
                scope: disk::TransferScope::Session("s".into()),
                cancel: token.clone(),
                expires: now() + 900_000,
                state: Phase::Running,
                upload: None,
                cache_key: None,
                object_id: None,
                result: Value::Null,
                created_at: now(),
            })
            .unwrap();
        let input = || TransferInput {
            session_id: Some("s".into()),
            workspace_id: None,
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
    fn publishing_state_cannot_be_cancelled_after_publication_reservation() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let token = CancellationToken::new();
        let id = transfers
            .insert(Entry {
                peer: "p".into(),
                scope: disk::TransferScope::Session("s".into()),
                cancel: token.clone(),
                expires: now() + 900_000,
                state: Phase::Publishing,
                upload: None,
                cache_key: None,
                object_id: None,
                result: Value::Null,
                created_at: now(),
            })
            .unwrap();
        let result = transfers
            .status(
                "p",
                TransferInput {
                    session_id: Some("s".into()),
                    workspace_id: None,
                    transfer_id: id,
                },
                true,
            )
            .unwrap();
        assert_eq!(result["status"], "publishing");
        assert!(!token.is_cancelled());
    }

    #[test]
    fn full_map_evicts_only_the_oldest_completed_download_cache() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(Tickets::new(tx, "room", "desktop"), true);
        let future = now() + 900_000;
        let cache_entry = |created_at, path: &str| Entry {
            peer: "p".into(),
            scope: disk::TransferScope::Session("s".into()),
            cancel: CancellationToken::new(),
            expires: future,
            state: Phase::Completed,
            upload: None,
            cache_key: Some((path.into(), "revision".into())),
            object_id: None,
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
                scope: disk::TransferScope::Session("s".into()),
                cancel: CancellationToken::new(),
                expires: future,
                state: Phase::Ready,
                upload: Some(Upload {
                    ticket: Ticket {
                        put_url: "https://x.qiniucs.com/put".into(),
                        get_url: "https://x.qiniucs.com/get".into(),
                        expires_at: future,
                        object_id: None,
                    },
                    name: "upload.bin".into(),
                    size: 1,
                    hash: "0".repeat(64),
                }),
                cache_key: None,
                object_id: None,
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
                scope: disk::TransferScope::Session("s".into()),
                cancel: token.clone(),
                expires: now() - 1,
                state: Phase::Ready,
                upload: Some(Upload {
                    ticket: Ticket {
                        put_url: "https://x.qiniucs.com/secret-put".into(),
                        get_url: "https://x.qiniucs.com/secret-get".into(),
                        expires_at: now() - 1,
                        object_id: None,
                    },
                    name: "secret.bin".into(),
                    size: 1,
                    hash: "0".repeat(64),
                }),
                cache_key: None,
                object_id: None,
                result: json!({"putUrl":"https://x.qiniucs.com/secret-put"}),
                created_at: now() - 10,
            })
            .unwrap();
        transfers.expire();
        assert!(token.is_cancelled());
        assert!(!transfers.inner.entries.lock().unwrap().contains_key(&id));
    }
}
