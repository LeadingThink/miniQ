//! Connection-owned control-plane tickets. Never accept endpoints from RPC callers.
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ticket {
    pub put_url: String,
    pub get_url: String,
    pub expires_at: u64,
    #[serde(default)]
    pub object_id: Option<String>,
}
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Option<Ticket>>>>>;
#[derive(Clone)]
pub(super) struct Tickets {
    pending: Pending,
    controls: mpsc::UnboundedSender<Message>,
    namespace: String,
}
struct Guard(String, Pending);
impl Drop for Guard {
    fn drop(&mut self) {
        self.1.lock().unwrap().remove(&self.0);
    }
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Tickets {
    pub fn new(controls: mpsc::UnboundedSender<Message>, room: &str, desktop: &str) -> Self {
        Self {
            pending: Arc::default(),
            controls,
            namespace: format!("/remote-files/{room}/{desktop}/"),
        }
    }
    pub fn receive(&self, id: &str, ticket: Option<Ticket>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(ticket);
        }
    }
    pub async fn request(&self, session: &str, size: u64, object_id: Option<&str>) -> Result<Ticket, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _guard = Guard(id.clone(), self.pending.clone());
        self.controls
            .send(Message::Text(
                json!({"type":"file_ticket","requestId":id,"sessionId":session,"bytes":size,
                    "objectId":object_id})
                    .to_string()
                    .into(),
            ))
            .map_err(|_| "File connection closed")?;
        let ticket = tokio::time::timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| "File ticket timed out")?
            .map_err(|_| "File connection closed")?
            .ok_or("File storage unavailable")?;
        validate(&ticket)?;
        validate_scope(&ticket, &self.namespace, session)?;
        if let Some(object_id) = object_id {
            if ticket.object_id.as_deref() != Some(object_id) {
                return Err("Invalid file ticket object scope".into());
            }
        }
        Ok(ticket)
    }
}
fn validate_scope(ticket: &Ticket, namespace: &str, session: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let put = url::Url::parse(&ticket.put_url).map_err(|_| "Invalid file storage endpoint")?;
    let get = url::Url::parse(&ticket.get_url).map_err(|_| "Invalid file storage endpoint")?;
    if put.host_str() != get.host_str() || put.path() != get.path() {
        return Err("Invalid file ticket scope".into());
    }
    let expected_namespace = namespace.trim_matches('/').split('/').collect::<Vec<_>>();
    let segments = put
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let Some(index) = segments
        .iter()
        .position(|segment| *segment == "remote-files")
    else {
        return Err("Invalid file ticket scope".into());
    };
    let expected_hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    if expected_namespace.len() != 3
        || segments.get(index..index + 3) != Some(expected_namespace.as_slice())
        || segments.get(index + 3) != Some(&expected_hash.as_str())
        || segments.len() != index + 5
        || uuid::Uuid::parse_str(segments[index + 4]).is_err()
    {
        return Err("Invalid file ticket scope".into());
    }
    Ok(())
}
fn validate(ticket: &Ticket) -> Result<(), String> {
    for raw in [&ticket.put_url, &ticket.get_url] {
        let url = url::Url::parse(raw).map_err(|_| "Invalid file storage endpoint")?;
        if url.scheme() != "https"
            || !url.host_str().is_some_and(|h| h.ends_with(".qiniucs.com"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
            || url.fragment().is_some()
        {
            return Err("Invalid file storage endpoint".into());
        }
    }
    if ticket.expires_at <= now() + 5000 || ticket.expires_at > now() + 905_000 {
        return Err("Invalid file ticket expiry".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn control_ticket_is_correlated_and_session_scoped() {
        use sha2::{Digest, Sha256};
        let (tx, mut rx) = mpsc::unbounded_channel();
        let tickets = Tickets::new(tx, "room", "desktop");
        let client = tickets.clone();
        let task = tokio::spawn(async move { client.request("session", 123, None).await });
        let message = rx.recv().await.unwrap();
        let value: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(value["type"], "file_ticket");
        assert_eq!(value["sessionId"], "session");
        assert_eq!(value["bytes"], 123);
        let url = format!(
            "https://x.qiniucs.com/bucket/remote-files/room/desktop/{:x}/{}",
            Sha256::digest(b"session"),
            uuid::Uuid::new_v4()
        );
        let ticket = Ticket {
            put_url: url.clone(),
            get_url: url.clone(),
            object_id: None,
            expires_at: now() + 900_000,
        };
        assert!(validate_scope(&ticket, "/remote-files/room/desktop/", "other").is_err());
        assert!(validate_scope(&ticket, "/remote-files/room/other/", "session").is_err());
        let lookalike = Ticket {
            put_url: url.replace("/remote-files/", "/not-remote-files/"),
            get_url: url.replace("/remote-files/", "/not-remote-files/"),
            object_id: None,
            expires_at: now() + 900_000,
        };
        assert!(validate_scope(&lookalike, "/remote-files/room/desktop/", "session").is_err());
        let trailing = Ticket {
            put_url: format!("{url}/extra"),
            get_url: format!("{url}/extra"),
            object_id: None,
            expires_at: now() + 900_000,
        };
        assert!(validate_scope(&trailing, "/remote-files/room/desktop/", "session").is_err());
        tickets.receive(value["requestId"].as_str().unwrap(), Some(ticket));
        assert!(task.await.unwrap().is_ok());
        assert!(tickets.pending.lock().unwrap().is_empty());
    }
    #[test]
    fn rejects_unsafe_endpoints_and_expiry() {
        for raw in [
            "http://x.qiniucs.com/a",
            "https://127.0.0.1/a",
            "https://x.qiniucs.com.evil/a",
            "https://u:p@x.qiniucs.com/a",
            "https://x.qiniucs.com:444/a",
        ] {
            assert!(validate(&Ticket {
                put_url: raw.into(),
                get_url: raw.into(),
                object_id: None,
                expires_at: now() + 900_000
            })
            .is_err());
        }
        let mut ticket = Ticket {
            put_url: "https://x.qiniucs.com/a".into(),
            get_url: "https://x.qiniucs.com/a".into(),
            object_id: None,
            expires_at: now() + 900_000,
        };
        assert!(validate(&ticket).is_ok());
        ticket.expires_at = now();
        assert!(validate(&ticket).is_err());
    }
}
