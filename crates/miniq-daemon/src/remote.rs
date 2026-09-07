//! End-to-end encrypted bridge from the local daemon to the public miniQ relay.
//!
//! The relay only sees domain-separated key hashes and opaque AES-GCM frames.
//! The provider API key and JSON-RPC payloads never leave the two endpoints in
//! plaintext.

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use miniq_protocol::{ErrorCode, RequestId, RpcError, RpcRequest, RpcResponse};
use rand::distr::Alphanumeric;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
mod blob;
mod connection;
mod subscriptions;
mod transport;
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

use crate::state::AppState;

pub const DEFAULT_RELAY_URL: &str = "wss://oneapi.zaiwenai.com/miniq-relay/ws";
const PROTOCOL_VERSION: u8 = 1;
const MAX_SEEN_NONCES: usize = 2_048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_relay_url")]
    pub relay_url: String,
    #[serde(default = "default_device_name")]
    pub device_name: String,
    #[serde(default)]
    pub device_id: String,
}

impl Default for RemoteAccessSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            relay_url: default_relay_url(),
            device_name: default_device_name(),
            device_id: new_device_id(),
        }
    }
}

impl RemoteAccessSettings {
    pub fn ensure_device_id(&mut self) -> bool {
        if valid_device_id(&self.device_id) {
            return false;
        }
        self.device_id = new_device_id();
        true
    }
}

fn default_relay_url() -> String {
    DEFAULT_RELAY_URL.to_string()
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "我的电脑".to_string())
}

fn new_device_id() -> String {
    let suffix: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    format!("desktop-{suffix}")
}

fn valid_device_id(value: &str) -> bool {
    (8..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConnectionState {
    Disabled,
    WaitingForKey,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRuntimeStatus {
    pub state: RemoteConnectionState,
    pub relay_url: String,
    pub mobile_clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl Default for RemoteRuntimeStatus {
    fn default() -> Self {
        Self {
            state: RemoteConnectionState::Disabled,
            relay_url: DEFAULT_RELAY_URL.to_string(),
            mobile_clients: 0,
            last_error: None,
        }
    }
}

#[derive(Clone)]
struct ActiveConfig {
    relay_url: String,
    device_name: String,
    device_id: String,
    api_key: String,
    fingerprint: [u8; 32],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayFrame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    ciphertext: String,
    #[serde(default)]
    desktop_online: bool,
    #[serde(default)]
    mobile_clients: usize,
    #[serde(default)]
    mobile_ids: Option<Vec<String>>,
    #[serde(default)]
    blob_storage: bool,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    ticket: Option<blob::Ticket>,
    #[serde(default)]
    message: String,
}

struct CryptoIdentity {
    room_id: String,
    auth_token: String,
    cipher: Aes256Gcm,
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        connection_loop(state).await;
    });
}

pub fn status(state: &AppState) -> RemoteRuntimeStatus {
    state.remote_status.lock().unwrap().clone()
}

async fn connection_loop(state: AppState) {
    let mut retry_seconds = 1_u64;
    loop {
        if state.shutdown.is_cancelled() {
            return;
        }
        let remote = state.settings.lock().unwrap().remote_access.clone();
        if !remote.enabled {
            set_status(
                &state,
                RemoteConnectionState::Disabled,
                remote.relay_url,
                0,
                None,
            );
            sleep_or_shutdown(&state, Duration::from_secs(2)).await;
            retry_seconds = 1;
            continue;
        }

        let provider_key = state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .map(|provider| provider.api_key.trim().to_string())
            .unwrap_or_default();
        if provider_key.is_empty() {
            set_status(
                &state,
                RemoteConnectionState::WaitingForKey,
                remote.relay_url,
                0,
                Some("请先保存模型 API Key".to_string()),
            );
            sleep_or_shutdown(&state, Duration::from_secs(3)).await;
            continue;
        }

        let config = ActiveConfig::new(remote, provider_key);
        set_status(
            &state,
            if retry_seconds == 1 {
                RemoteConnectionState::Connecting
            } else {
                RemoteConnectionState::Reconnecting
            },
            config.relay_url.clone(),
            0,
            None,
        );
        match connection::run(&state, &config).await {
            Ok(()) => retry_seconds = 1,
            Err(error) => {
                let message = sanitize_connection_error(&error.to_string());
                tracing::warn!(error = %message, "miniQ remote relay disconnected");
                set_status(
                    &state,
                    RemoteConnectionState::Reconnecting,
                    config.relay_url.clone(),
                    0,
                    Some(message),
                );
                sleep_or_shutdown(&state, Duration::from_secs(retry_seconds)).await;
                retry_seconds = (retry_seconds * 2).min(30);
            }
        }
    }
}

impl ActiveConfig {
    fn new(remote: RemoteAccessSettings, api_key: String) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(remote.relay_url.as_bytes());
        hasher.update([0]);
        hasher.update(remote.device_name.as_bytes());
        hasher.update([0]);
        hasher.update(remote.device_id.as_bytes());
        hasher.update([0]);
        hasher.update(api_key.as_bytes());
        Self {
            relay_url: remote.relay_url,
            device_name: remote.device_name,
            device_id: remote.device_id,
            api_key,
            fingerprint: hasher.finalize().into(),
        }
    }
}

fn remote_method_allowed(method: &str) -> bool {
    !matches!(
        method,
        "daemon.shutdown"
            | "settings.update"
            | "workspace.open"
            | "externalSession.import"
            | "mcp.update"
            | "skill.delete"
    )
}

fn parse_relay_text(message: Message) -> anyhow::Result<RelayFrame> {
    let Message::Text(text) = message else {
        anyhow::bail!("relay 返回了非文本握手");
    };
    Ok(serde_json::from_str(&text)?)
}

fn derive_identity(api_key: &str) -> CryptoIdentity {
    let room_key = derive_key(api_key, b"miniq-relay-room-v1");
    let auth_key = derive_key(api_key, b"miniq-relay-auth-v1");
    let encryption_key = derive_key(api_key, b"miniq-relay-encryption-v1");
    CryptoIdentity {
        room_id: URL_SAFE_NO_PAD.encode(room_key),
        auth_token: URL_SAFE_NO_PAD.encode(auth_key),
        cipher: Aes256Gcm::new_from_slice(&encryption_key).expect("32-byte AES key"),
    }
}

fn derive_key(api_key: &str, label: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(label);
    hasher.update([0]);
    hasher.update(api_key.as_bytes());
    hasher.finalize().into()
}

fn encrypt_payload(cipher: &Aes256Gcm, payload: &[u8]) -> anyhow::Result<(String, String)> {
    let (nonce, ciphertext) = encrypt_bytes(cipher, payload)?;
    Ok((
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(ciphertext),
    ))
}

fn encrypt_bytes(cipher: &Aes256Gcm, payload: &[u8]) -> anyhow::Result<([u8; 12], Vec<u8>)> {
    let mut nonce = [0_u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), payload)
        .map_err(|_| anyhow::anyhow!("无法加密远程消息"))?;
    Ok((nonce, ciphertext))
}

fn decrypt_payload(cipher: &Aes256Gcm, nonce: &str, ciphertext: &str) -> anyhow::Result<Vec<u8>> {
    let nonce = URL_SAFE_NO_PAD.decode(nonce)?;
    if nonce.len() != 12 {
        anyhow::bail!("远程消息 nonce 长度无效");
    }
    let ciphertext = URL_SAFE_NO_PAD.decode(ciphertext)?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("远程消息认证失败"))
}

fn current_fingerprint(state: &AppState) -> Option<[u8; 32]> {
    let settings = state.settings.lock().unwrap();
    if !settings.remote_access.enabled {
        return None;
    }
    let key = settings.provider.as_ref()?.api_key.trim();
    if key.is_empty() {
        return None;
    }
    Some(ActiveConfig::new(settings.remote_access.clone(), key.to_string()).fingerprint)
}

fn set_status(
    state: &AppState,
    connection_state: RemoteConnectionState,
    relay_url: String,
    mobile_clients: usize,
    last_error: Option<String>,
) {
    *state.remote_status.lock().unwrap() = RemoteRuntimeStatus {
        state: connection_state,
        relay_url,
        mobile_clients,
        last_error,
    };
}

fn sanitize_connection_error(error: &str) -> String {
    error
        .split("authToken")
        .next()
        .unwrap_or("远程连接失败")
        .to_string()
}

async fn sleep_or_shutdown(state: &AppState, duration: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = state.shutdown.cancelled() => {}
    }
}

#[derive(Default)]
struct SeenNonces {
    values: HashSet<String>,
    order: VecDeque<String>,
}

impl SeenNonces {
    fn insert(&mut self, value: String) -> bool {
        if !self.values.insert(value.clone()) {
            return false;
        }
        self.order.push_back(value);
        if self.order.len() > MAX_SEEN_NONCES {
            if let Some(oldest) = self.order.pop_front() {
                self.values.remove(&oldest);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_stable_and_domain_separated() {
        let first = derive_identity("sk-test-secret");
        let second = derive_identity("sk-test-secret");
        assert_eq!(first.room_id, second.room_id);
        assert_eq!(first.auth_token, second.auth_token);
        assert_eq!(first.room_id, "DaSzo9SjSPu86bt0mw7BjsYK8-RWaBj0AklFHV50oeU");
        assert_eq!(
            first.auth_token,
            "Ql6-zLsUyp3DLtq-8OirdLEASP3fv70UACoYX-bxcvk"
        );
        assert_ne!(first.room_id, first.auth_token);
        assert!(!first.room_id.contains("sk-test-secret"));
    }

    #[test]
    fn encrypted_payload_round_trips_and_rejects_tampering() {
        let identity = derive_identity("sk-test-secret");
        let (nonce, ciphertext) = encrypt_payload(&identity.cipher, b"hello").unwrap();
        assert_eq!(
            decrypt_payload(&identity.cipher, &nonce, &ciphertext).unwrap(),
            b"hello"
        );

        let mut bytes = URL_SAFE_NO_PAD.decode(&ciphertext).unwrap();
        bytes[0] ^= 1;
        assert!(decrypt_payload(&identity.cipher, &nonce, &URL_SAFE_NO_PAD.encode(bytes)).is_err());
    }

    #[test]
    fn remote_management_does_not_expose_local_configuration() {
        assert!(remote_method_allowed("session.sendMessage"));
        assert!(remote_method_allowed("approval.resolve"));
        assert!(!remote_method_allowed("settings.update"));
        assert!(!remote_method_allowed("daemon.shutdown"));
        assert!(!remote_method_allowed("workspace.open"));
    }

    #[test]
    fn replay_cache_rejects_duplicates_and_stays_bounded() {
        let mut seen = SeenNonces::default();
        assert!(seen.insert("first".to_string()));
        assert!(!seen.insert("first".to_string()));
        for index in 0..=MAX_SEEN_NONCES {
            seen.insert(format!("nonce-{index}"));
        }
        assert!(seen.values.len() <= MAX_SEEN_NONCES);
    }

    #[test]
    fn connection_errors_are_redacted_without_losing_diagnostic_details() {
        let detail = "x".repeat(400);
        assert_eq!(sanitize_connection_error(&detail), detail);
        assert_eq!(
            sanitize_connection_error("handshake failed authToken=secret"),
            "handshake failed "
        );
    }
}
